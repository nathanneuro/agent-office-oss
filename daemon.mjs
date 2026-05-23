#!/usr/bin/env node
// The Office — daemon / orchestrator
// Zero external deps. Ingests Claude Code hook events, derives live agent
// state (model, context %, what they're doing, blocked-on-you), and pushes
// it to the office UI over a hand-rolled WebSocket. Serves the UI too.
//
//   node daemon.mjs            then open http://localhost:4317
//
import http from 'node:http';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BBSStore } from './bbs-store.mjs';
import { codexObserverStatus } from './codex-observer-state.mjs';
import {
  EV,
  TASK_PRIORITY,
  capabilityOf,
  normalizeTaskStatus,
  promptActions,
} from './core/contract.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { TaskStore } from './task-store.mjs';
import { CallQueue } from './call-store.mjs';
import { speechify } from './call-speechifier.mjs';
import { voiceFor, ANNOUNCER_VOICE } from './call-voices.mjs';

const PORT = Number(process.env.OFFICE_PORT || 4317);
const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_FILE = path.join(os.homedir(), '.claude', 'agent-office',
  'profiles.json');
const LOCAL_PROFILES_FILE = path.join(__dir, 'data', 'profiles.local.json');
const BBS_FILE = path.join(__dir, 'data', 'bbs.json');
const TASKS_FILE = path.join(__dir, 'data', 'tasks.json');
const BBS_RECENT_LIMIT = 6;
const COLLAB_RECENT_LIMIT = 8;
const CHANNEL_RECENT_LIMIT = 12;
const AUTO_OBSERVE_CODEX = process.env.OFFICE_AUTO_OBSERVE_CODEX !== '0';
const CODEX_OBSERVER_RESTART_MS = 5000;
// Conference-call Operator (operator.mjs): opt-in hidden coordinator subprocess.
const OFFICE_OPERATOR = process.env.OFFICE_OPERATOR === '1';
const OPERATOR_RESTART_MS = 5000;

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------
/** session_id -> agent */
const agents = new Map();
const DESKS = 12;
const deskTaken = new Array(DESKS).fill(null);
const bbs = new BBSStore(BBS_FILE);
const tasks = new TaskStore(TASKS_FILE);
const requestThreadByAgent = new Map();
const prompts = new Map();
const promptByAgent = new Map();
const runtimes = new RuntimeManager(PORT);
const TASK_PRIORITY_SET = new Set(TASK_PRIORITY);
let codexObserverChild = null;
let codexObserverRetry = null;
let operatorChild = null;
let operatorRetry = null;
let shuttingDown = false;

function getCodexObserverStatus() {
  const status = codexObserverStatus();
  return {
    ...status,
    enabled: AUTO_OBSERVE_CODEX,
    managedByDaemon: !!(codexObserverChild && status.pid && codexObserverChild.pid === status.pid),
  };
}

function startCodexObserver() {
  if (!AUTO_OBSERVE_CODEX || shuttingDown) return;
  const running = codexObserverStatus();
  if (running.running) return;
  if (codexObserverChild && codexObserverChild.exitCode === null) return;
  const child = cp.spawn(process.execPath, [path.join(__dir, 'observe-codex.mjs')], {
    cwd: __dir,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_OBSERVER_OWNER: 'daemon',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  codexObserverChild = child;
  child.stdout.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (line) console.log(`[codex-observer] ${line}`);
  });
  child.stderr.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (line) console.warn(`[codex-observer] ${line}`);
  });
  child.on('exit', (code, signal) => {
    if (codexObserverChild === child) codexObserverChild = null;
    if (shuttingDown) return;
    if (codexObserverRetry) clearTimeout(codexObserverRetry);
    console.warn('[codex-observer] exited'
      + (code !== null ? ` with code ${code}` : '')
      + (signal ? ` (${signal})` : '')
      + '; retrying.');
    codexObserverRetry = setTimeout(() => {
      codexObserverRetry = null;
      startCodexObserver();
    }, CODEX_OBSERVER_RESTART_MS);
  });
}

function stopCodexObserver() {
  shuttingDown = true;
  if (codexObserverRetry) {
    clearTimeout(codexObserverRetry);
    codexObserverRetry = null;
  }
  if (codexObserverChild && codexObserverChild.exitCode === null) {
    try { codexObserverChild.kill('SIGTERM'); } catch {}
  }
}

// Hidden Operator coordinator (CONFERENCE_CALL.md §3.2): daemon-managed
// subprocess with auto-restart, mirroring the codex observer. Opt-in via
// OFFICE_OPERATOR=1 so the call feature stays off by default.
function startOperator() {
  if (!OFFICE_OPERATOR || shuttingDown) return;
  if (operatorChild && operatorChild.exitCode === null) return;
  const child = cp.spawn(process.execPath, [path.join(__dir, 'operator.mjs')], {
    cwd: __dir,
    env: { ...process.env, OFFICE_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  operatorChild = child;
  child.stdout.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (line) console.log(`[operator] ${line}`);
  });
  child.stderr.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (line) console.warn(`[operator] ${line}`);
  });
  child.on('exit', (code, signal) => {
    if (operatorChild === child) operatorChild = null;
    if (shuttingDown) return;
    if (operatorRetry) clearTimeout(operatorRetry);
    console.warn('[operator] exited'
      + (code !== null ? ` with code ${code}` : '')
      + (signal ? ` (${signal})` : '')
      + '; retrying.');
    operatorRetry = setTimeout(() => {
      operatorRetry = null;
      startOperator();
    }, OPERATOR_RESTART_MS);
  });
}

function stopOperator() {
  if (operatorRetry) {
    clearTimeout(operatorRetry);
    operatorRetry = null;
  }
  if (operatorChild && operatorChild.exitCode === null) {
    try { operatorChild.kill('SIGTERM'); } catch {}
  }
}

const ADJ = ['Quiet','Brisk','Amber','Velvet','Iron','Pewter','Saffron','Cobalt',
  'Hollow','Drift','Ember','Slate','Marble','Russet','Onyx','Ivory'];
const CRIT = ['Heron','Marten','Civet','Lynx','Vireo','Tapir','Shrike','Caracal',
  'Fennec','Quokka','Saiga','Margay','Genet','Serval','Numbat','Pika'];

function codename(id) {
  const h = crypto.createHash('md5').update(id).digest();
  return `${ADJ[h[0] % ADJ.length]} ${CRIT[h[1] % CRIT.length]}`;
}

// Hot-reloaded agent profiles. Shape:
//   { "bySession": { "<id>": {profile} }, "byCwd": { "/abs/path": {profile} } }
// profile = {
//   name?,
//   character?: {...},
//   desk?: { items:[...] , deskColor? },
//   card?: { title?, blurb?, traits?:[], features?:[] }
// }
// There are two sources:
//   1. ~/.claude/agent-office/profiles.json        (global / personal)
//   2. ./data/profiles.local.json                  (repo-local / portable)
// Local wins so a project can bring its own Office cast without mutating the
// user's home config.
let _profCache = { key: '', data: { bySession: {}, byCwd: {}, departments: [] } };
function readProfileFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { bySession: {}, byCwd: {}, departments: [] };
  }
}
function loadProfiles() {
  try {
    const parts = [PROFILES_FILE, LOCAL_PROFILES_FILE].map((file) => {
      try { return `${file}:${fs.statSync(file).mtimeMs}`; }
      catch { return `${file}:0`; }
    });
    const key = parts.join('|');
    if (key !== _profCache.key) {
      const global = readProfileFile(PROFILES_FILE);
      const local = readProfileFile(LOCAL_PROFILES_FILE);
      _profCache = { key, data: {
        bySession: { ...(global.bySession || {}), ...(local.bySession || {}) },
        byCwd: { ...(global.byCwd || {}), ...(local.byCwd || {}) },
        departments: [...(local.departments || []), ...(global.departments || [])],
      } };
    }
  } catch { _profCache = { key: '',
    data: { bySession: {}, byCwd: {}, departments: [] } }; }
  return _profCache.data;
}
function resolveProfile(id, cwd) {
  const p = loadProfiles();
  return { ...(cwd && p.byCwd[cwd]), ...p.bySession[id] }; // session wins
}
// cwd -> department. Config `departments[].match` wins; else auto from path.
function prettyName(s) {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function resolveDepartment(cwd) {
  const { departments } = loadProfiles();
  if (cwd) for (const d of departments)
    if ((d.match || []).some((m) => cwd.includes(m)))
      return { id: d.id, name: d.name || prettyName(d.id),
        color: d.color || null, icon: d.icon || null, auto: false };
  const base = (cwd || 'desk').replace(/\/+$/, '').split('/').pop() || 'desk';
  return { id: base, name: prettyName(base), color: null, icon: null,
    auto: true };
}

function assignDesk(id) {
  let i = deskTaken.indexOf(null);
  if (i === -1) i = Math.floor(Math.random() * DESKS); // fallback: double up
  deskTaken[i] = id;
  return i;
}
function freeDesk(id) {
  const i = deskTaken.indexOf(id);
  if (i !== -1) deskTaken[i] = null;
}

function modelWindow(model = '') {
  const m = model.toLowerCase();
  if (m.includes('1m') || m.includes('[1m]')) return 1_000_000;
  if (m.includes('haiku')) return 200_000;
  return 200_000;
}

// Pull model + context usage from the tail of the transcript JSONL.
function readTranscriptStats(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, 96 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const msg = o.message || o;
      const u = msg && msg.usage;
      if (msg && msg.model && u) {
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
                     (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        return {
          model: msg.model,
          contextPct: Math.min(100, Math.round((used / modelWindow(msg.model)) * 100)),
          tokens: used,
        };
      }
    }
  } catch { /* transcript not readable yet — fine */ }
  return null;
}

// Public projection — never serialize internal fields (e.g. _settle, a
// Timeout, is circular and crashes JSON.stringify).
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const NO_RUNTIME_CAPS = Object.freeze({
  observe: false,
  prompt: false,
  control: false,
  spawn: false,
});

function resolveRuntimeSessionSnapshot(ref) {
  if (!ref) return null;
  try {
    const session = runtimes.getSession(ref);
    return session && session.kind === 'terminal' ? session : null;
  } catch {
    return null;
  }
}

function observedCodexInboxSession(agent) {
  if (!agent || !agent.id || !getCodexObserverStatus().running) return null;
  if ((agent.provider || '').toLowerCase() !== 'codex') return null;
  return {
    id: agent.id,
    runtimeId: 'observed',
    provider: 'codex',
    runtimeLabel: 'Codex observed thread',
    kind: 'observed',
    transport: 'thread-store',
    lane: 'first-party',
    alive: true,
    observedOnly: true,
    firstParty: true,
    experimental: false,
    utility: false,
    cwd: agent.cwd || '',
    requestedCwd: agent.cwd || '',
  };
}

function runtimeSessionForSummary(agent, opt = {}) {
  if (!agent) return null;
  const preferred = resolveRuntimeSessionSnapshot(
    opt.runtimeSessionId || opt.targetSession || opt.sessionId || null,
  );
  if (preferred) return preferred;
  const linked = resolveRuntimeSessionSnapshot(agent.runtimeSessionId || null);
  if (linked) return linked;
  const observed = observedCodexInboxSession(agent);
  if (observed) return observed;
  return null;
}

function runtimeSummaryFromSession(session) {
  if (!session) {
    return {
      sessionId: null,
      runtimeId: null,
      provider: null,
      runtimeLabel: null,
      kind: null,
      transport: null,
      lane: null,
      live: false,
      managed: false,
      observedOnly: false,
      firstParty: false,
      experimental: false,
      utility: false,
      caps: { ...NO_RUNTIME_CAPS },
      promptActions: [],
    };
  }
  const caps = capabilityOf(session.provider || '');
  return {
    sessionId: session.id,
    runtimeId: session.runtimeId || null,
    provider: session.provider || null,
    runtimeLabel: session.runtimeLabel || null,
    kind: session.kind || null,
    transport: session.transport || null,
    lane: session.lane || null,
    live: !!session.alive,
    managed: !!session.runtimeId && session.runtimeId !== 'observed' && !session.observedOnly,
    observedOnly: !!session.observedOnly || session.runtimeId === 'observed',
    firstParty: !!session.firstParty,
    experimental: !!session.experimental,
    utility: !!session.utility,
    caps: { ...caps },
    promptActions: session.alive ? promptActions(session.provider) : [],
  };
}

function runtimeSummaryForAgent(agent, opt = {}) {
  return runtimeSummaryFromSession(runtimeSessionForSummary(agent, opt));
}

function promptReplyActions(prompt, runtime) {
  const actions = new Set();
  if (prompt?.threadId || runtime?.live) actions.add('reply');
  for (const action of runtime?.promptActions || []) actions.add(action);
  return [...actions];
}

function sessionDeliveryMode(session) {
  if (!session) return null;
  const caps = capabilityOf(session.provider || '');
  if (caps.control === true) return 'delivered';
  if (caps.prompt) return 'relayed';
  return null;
}

function sessionSupportsAsyncInbox(session) {
  if (!session || !session.alive) return false;
  if ((session.provider || '').toLowerCase() !== 'codex') return false;
  if (session.kind !== 'terminal' && !(session.observedOnly || session.kind === 'observed')) return false;
  return !!getCodexObserverStatus().running;
}

function actionReceipt(opt = {}) {
  const stored = !!opt.stored;
  const targetSessions = Array.isArray(opt.targetSessions)
    ? opt.targetSessions.filter(Boolean)
    : [];
  const queuedSessions = Array.isArray(opt.queuedSessions)
    ? opt.queuedSessions.filter(Boolean)
    : [];
  const deliveredSessionIds = [];
  const relayedSessionIds = [];
  for (const session of targetSessions) {
    const mode = sessionDeliveryMode(session);
    if (mode === 'delivered') deliveredSessionIds.push(session.id);
    else if (mode === 'relayed') relayedSessionIds.push(session.id);
  }
  const queuedSessionIds = queuedSessions.map((session) => session.id);
  const queued = !!opt.queued || queuedSessionIds.length > 0;
  let status = stored ? 'stored' : 'stored';
  if (deliveredSessionIds.length) status = 'delivered';
  else if (relayedSessionIds.length) status = 'relayed';
  else if (queued) status = 'queued';
  return {
    status,
    stored,
    queued,
    delivered: deliveredSessionIds.length > 0,
    relayed: relayedSessionIds.length > 0,
    targetSessionIds: targetSessions.map((session) => session.id),
    deliveredSessionIds,
    relayedSessionIds,
    queuedSessionIds,
    deliveredCount: deliveredSessionIds.length,
    relayedCount: relayedSessionIds.length,
    queuedCount: queuedSessionIds.length,
  };
}

const pub = (a) => {
  const runtime = runtimeSummaryForAgent(a);
  return {
    id: a.id, short: a.short, name: a.name, model: a.model,
    contextPct: a.contextPct, status: a.status, tool: a.tool,
    cwd: a.cwd, desk: a.desk, since: a.since, note: a.note,
    runtimeSessionId: a.runtimeSessionId || runtime.sessionId || null,
    provider: runtime.provider || a.provider || null,
    runtime,
    profile: a.profile || null, department: a.department || null,
    task: a.task || '',
  };
};

const SETTLE_MS = 1400; // working/done eases back to "thinking" after this

function touch(id, patch) {
  let a = agents.get(id);
  const now = Date.now();
  if (!a) {
    a = {
      id,
      short: id.slice(0, 8),
      name: codename(id),
      model: '',
      provider: '',
      contextPct: 0,
      status: 'arriving',
      tool: '',
      cwd: '',
      desk: assignDesk(id),
      since: now,
    };
    agents.set(id, a);
  }
  const nextStatus = hasOwn(patch, 'status') && patch.status ? patch.status : a.status;
  const statusChanged = !!(nextStatus && nextStatus !== a.status);
  Object.assign(a, patch, { lastSeen: now });
  if (!a.since || statusChanged) a.since = now;
  const prof = resolveProfile(id, a.cwd);
  a.department = resolveDepartment(a.cwd);
  a.task = prof.task || '';
  if (prof.name) a.name = prof.name;
  a.profile = (prof.character || prof.desk || prof.card)
    ? {
      character: prof.character || null,
      desk: prof.desk || null,
      card: prof.card || null,
    } : null;
  broadcast({ type: 'update', agent: pub(a) });
  return a;
}

function scheduleSettle(id) {
  const a = agents.get(id);
  if (!a) return;
  clearTimeout(a._settle);
  a._settle = setTimeout(() => {
    const cur = agents.get(id);
    if (cur && (cur.status === 'working' || cur.status === 'done')) {
      cur.status = 'thinking';
      cur.since = Date.now();
      broadcast({ type: 'update', agent: pub(cur) });
    }
  }, SETTLE_MS);
}

function remove(id) {
  const a = agents.get(id);
  if (!a) return;
  clearAgentTaskSessions(id);
  a.status = 'leaving';
  a.since = Date.now();
  broadcast({ type: 'update', agent: pub(a) });
  setTimeout(() => {
    freeDesk(id);
    agents.delete(id);
    broadcast({ type: 'remove', id });
  }, 1100);
}

function helpThreadContent(a, message) {
  return [
    message,
    a.task ? `Task: ${a.task}` : '',
    a.cwd ? `Workspace: ${a.cwd}` : '',
  ].filter(Boolean).join('\n');
}

function broadcastBoardRecent() {
  broadcast({ type: 'bbs_recent', posts: bbs.getRecent(BBS_RECENT_LIMIT) });
}

function resolveAgentRef(ref) {
  if (!ref) return null;
  if (agents.has(ref)) return agents.get(ref);
  const needle = ('' + ref).trim().toLowerCase();
  if (!needle) return null;
  const matches = [...agents.values()].filter((a) =>
    [a.id, a.short, a.name].some((value) => (value || '').toLowerCase() === needle));
  return matches.length === 1 ? matches[0] : null;
}

function resolveRuntimeSessionRef(ref) {
  if (!ref) return null;
  try {
    const session = runtimes.getSession(ref);
    return session && session.kind === 'terminal' && session.alive ? session : null;
  } catch {
    return null;
  }
}

function resolveAgentRuntimeSessionStrict(agent, opt = {}) {
  if (!agent) return null;
  const preferred = resolveRuntimeSessionRef(
    opt.runtimeSessionId || opt.targetSession || opt.sessionId || null,
  );
  if (preferred) return preferred;
  const linked = resolveRuntimeSessionRef(agent.runtimeSessionId || null);
  if (linked) return linked;
  return null;
}

function resolveAgentAsyncInboxSession(agent, opt = {}) {
  const linked = resolveAgentRuntimeSessionStrict(agent, opt);
  if (linked) return linked;
  return observedCodexInboxSession(agent);
}

function resolveAgentRuntimeSession(agent, opt = {}) {
  const strict = resolveAgentRuntimeSessionStrict(agent, opt);
  if (strict) return strict;
  if (opt.strict) return null;
  return runtimes.findUniqueSessionByCwd(agent.cwd);
}

function resolveAuthorIdentity(body, opt = {}) {
  const fallbackAuthor = (opt.fallbackAuthor || 'Lead').trim() || 'Lead';
  const requestedAuthor = (body.author || fallbackAuthor).trim() || fallbackAuthor;
  const agent = resolveAgentRef(
    body.authorAgentId || body.authorSessionId || body.fromAgentId
    || body.from || body.authorId || body.agentId || body.sessionId
    || requestedAuthor,
  );
  const runtimeSessionId = body.authorRuntimeSessionId
    || body.fromRuntimeSessionId
    || body.runtimeSessionId
    || resolveAgentRuntimeSessionStrict(agent)?.id
    || null;
  if (agent) {
    return {
      author: agent.name,
      authorType: 'agent',
      agent,
      authorAgentId: agent.id,
      authorSessionId: agent.id,
      authorRuntimeSessionId: runtimeSessionId,
    };
  }
  return {
    author: requestedAuthor,
    authorType: body.authorType || opt.fallbackType || 'human',
    agent: null,
    authorAgentId: null,
    authorSessionId: null,
    authorRuntimeSessionId: runtimeSessionId,
  };
}

function collabParticipantKey(aId, bId) {
  return [aId, bId].sort().join('::');
}

function collabSubject(from, to, subject) {
  return subject || `${from.name} ↔ ${to.name}`;
}

function formatCollabRelay(from, to, subject, content) {
  return [
    `[Office collab] ${from.name} -> ${to.name}`,
    subject ? `Thread: ${subject}` : '',
    content,
  ].filter(Boolean).join('\n');
}

function shellQuoteArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function relayPayloadForSession(session, text) {
  const provider = (session?.provider || '').toLowerCase();
  if (provider === 'claude' || provider === 'codex') return text;
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  return `printf '%s\\n' ${lines.map((line) => shellQuoteArg(line)).join(' ')}`;
}

function projectChannelId(deptId) {
  return `project:${deptId}`;
}

function allHandsChannel() {
  const members = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: 'all',
    name: 'All Hands',
    kind: 'all-hands',
    memberIds: members.map((a) => a.id),
    memberNames: members.map((a) => a.name),
    memberCount: members.length,
    departmentIds: [...new Set(members.map((a) => a.department?.id).filter(Boolean))],
  };
}

function groupsByDepartment() {
  const grouped = new Map();
  for (const agent of agents.values()) {
    const dept = agent.department || { id: 'desk', name: 'Desk' };
    if (!grouped.has(dept.id)) grouped.set(dept.id, { dept, list: [] });
    grouped.get(dept.id).list.push(agent);
  }
  return [...grouped.values()].sort((a, b) => a.dept.name.localeCompare(b.dept.name));
}

function agentIsPresent(agent) {
  return !!agent && agent.status !== 'leaving';
}

function getProjectChannels() {
  const groups = groupsByDepartment().map((grp) => ({
    id: projectChannelId(grp.dept.id),
    name: grp.dept.name,
    kind: 'project',
    departmentId: grp.dept.id,
    memberIds: grp.list.map((a) => a.id),
    memberNames: grp.list.map((a) => a.name),
    memberCount: grp.list.length,
    liveCount: grp.list.filter(agentIsPresent).length,
    sampleCwd: grp.list[0]?.cwd || '',
  })).sort((a, b) => a.name.localeCompare(b.name));
  return [allHandsChannel(), ...groups];
}

function resolveChannelRef(ref, fallbackAgentId) {
  const channels = getProjectChannels();
  if (ref) {
    const needle = ('' + ref).trim().toLowerCase();
    const direct = channels.find((channel) =>
      channel.id.toLowerCase() === needle || channel.name.toLowerCase() === needle);
    if (direct) return direct;
  }
  if (fallbackAgentId) {
    const agent = resolveAgentRef(fallbackAgentId);
    if (agent && agent.department?.id) {
      return channels.find((channel) => channel.id === projectChannelId(agent.department.id)) || null;
    }
  }
  return channels[0] || null;
}

function findChannelThread(channelId) {
  return bbs.getThreads('channels').find((thread) =>
    thread.meta?.kind === 'project-channel' && thread.meta?.channelId === channelId) || null;
}

function channelMembers(channel) {
  if (!channel) return [];
  if (channel.id === 'all') return [...agents.values()];
  return channel.memberIds.map((id) => agents.get(id)).filter(Boolean);
}

function formatChannelRelay(channel, author, content) {
  return [
    `[Office channel] #${channel.name}`,
    `${author}:`,
    content,
  ].filter(Boolean).join('\n');
}

function pubChannelPost(post, thread) {
  const meta = post?.meta || {};
  const threadMeta = thread?.meta || {};
  return {
    id: post.id,
    threadId: post.threadId,
    channelId: threadMeta.channelId || null,
    channelName: threadMeta.channelName || thread?.subject || '(unknown channel)',
    author: post.author,
    authorType: post.authorType,
    content: post.content,
    timestamp: post.timestamp,
    board: 'channels',
    authorAgentId: meta.authorAgentId || null,
    authorSessionId: meta.authorSessionId || null,
    authorRuntimeSessionId: meta.authorRuntimeSessionId || null,
    deliveredCount: meta.deliveredCount || 0,
    targetSessions: meta.targetSessions || [],
    queuedCount: meta.queuedCount || 0,
    queuedSessionIds: meta.queuedSessionIds || [],
    memberCount: meta.memberCount || threadMeta.memberCount || 0,
  };
}

function getChannelRecent(channelId, limit = CHANNEL_RECENT_LIMIT) {
  const thread = channelId ? findChannelThread(channelId) : null;
  if (channelId && !thread) return [];
  if (!channelId) {
    const threads = bbs.getThreads('channels').filter((item) => item.meta?.kind === 'project-channel');
    const threadMap = new Map(threads.map((item) => [item.id, item]));
    return bbs.getRecent(limit, { board: 'channels', threadIds: threads.map((item) => item.id) })
      .map((post) => pubChannelPost(post, threadMap.get(post.threadId)));
  }
  return bbs.getRecent(limit, { board: 'channels', threadIds: [thread.id] })
    .map((post) => pubChannelPost(post, thread));
}

function sendChannelMessage(body) {
  const channel = resolveChannelRef(body.channelId || body.channel || body.projectChannel, body.agentId || body.agent);
  if (!channel) return { error: 'channel not found', status: 404 };
  const content = (body.content || body.text || '').trim();
  if (!content) return { error: 'content required', status: 400 };
  const authorInfo = resolveAuthorIdentity(body, { fallbackAuthor: 'Lead', fallbackType: 'human' });
  const members = channelMembers(channel);
  const sessions = runtimes.listSessions().filter((session) => session.alive);
  const targets = new Map();
  const exactTargetIds = new Set();
  const fallbackCwds = new Set();
  for (const member of members) {
    const exact = resolveAgentRuntimeSessionStrict(member);
    if (exact) {
      exactTargetIds.add(exact.id);
    } else if (member.cwd) {
      fallbackCwds.add(member.cwd);
    }
  }
  if (body.relay !== false) {
    for (const session of sessions) {
      if (session.kind !== 'terminal') continue;
      if (authorInfo.authorRuntimeSessionId && session.id === authorInfo.authorRuntimeSessionId) continue;
      if (exactTargetIds.has(session.id)) {
        targets.set(session.id, session);
        continue;
      }
      if (!fallbackCwds.has(session.cwd) && !fallbackCwds.has(session.requestedCwd)) continue;
      targets.set(session.id, session);
    }
  }
  const targetSessions = [...targets.values()];
  const deliveredSessions = [];
  for (const session of targetSessions) {
    try {
      runtimes.sendInput(session.id,
        relayPayloadForSession(session, formatChannelRelay(channel, authorInfo.author, content)),
        { enter: body.enter !== false });
      deliveredSessions.push(session);
    } catch {}
  }
  const queuedSessions = [];
  for (const member of members) {
    const asyncSession = resolveAgentAsyncInboxSession(member);
    if (!sessionSupportsAsyncInbox(asyncSession)) continue;
    if (authorInfo.authorRuntimeSessionId && asyncSession.id === authorInfo.authorRuntimeSessionId) continue;
    if (deliveredSessions.some((session) => session.id === asyncSession.id)) continue;
    if (!queuedSessions.some((session) => session.id === asyncSession.id)) queuedSessions.push(asyncSession);
  }
  let thread = findChannelThread(channel.id);
  const postMeta = {
    authorAgentId: authorInfo.authorAgentId,
    authorSessionId: authorInfo.authorSessionId,
    authorRuntimeSessionId: authorInfo.authorRuntimeSessionId,
    deliveredCount: deliveredSessions.length,
    targetSessions: deliveredSessions.map((session) => session.id),
    queuedCount: queuedSessions.length,
    queuedSessionIds: queuedSessions.map((session) => session.id),
    memberCount: members.length,
  };
  let post;
  if (!thread) {
    const created = bbs.createThread({
      board: 'channels',
      subject: channel.name,
      author: authorInfo.author,
      authorType: authorInfo.authorType,
      content,
      meta: {
        kind: 'project-channel',
        channelId: channel.id,
        channelName: channel.name,
        memberCount: members.length,
      },
      postMeta,
    });
    thread = created.thread;
    post = created.post;
  } else {
    post = bbs.reply({
      threadId: thread.id,
      author: authorInfo.author,
      authorType: authorInfo.authorType,
      content,
      meta: postMeta,
    });
  }
  broadcastBoardRecent();
  broadcastCommsOverview();
  const receipt = actionReceipt({
    stored: true,
    targetSessions: deliveredSessions,
    queuedSessions,
  });
  return {
    ok: true,
    channel,
    thread,
    post: pubChannelPost(post, thread),
    deliveredCount: deliveredSessions.length,
    memberCount: members.length,
    targetSessions: deliveredSessions.map((session) => session.id),
    receipt,
  };
}

function pubCollabPost(post, thread) {
  const meta = post?.meta || {};
  const threadMeta = thread?.meta || {};
  return {
    id: post.id,
    threadId: post.threadId,
    subject: thread?.subject || '(unknown)',
    author: post.author,
    authorType: post.authorType,
    content: post.content,
    timestamp: post.timestamp,
    board: 'collab',
    fromAgentId: meta.fromAgentId || threadMeta.fromAgentId || null,
    fromAgentName: meta.fromAgentName || threadMeta.fromAgentName || post.author,
    toAgentId: meta.toAgentId || threadMeta.toAgentId || null,
    toAgentName: meta.toAgentName || threadMeta.toAgentName || null,
    terminalDelivered: !!meta.terminalDelivered,
    relaySessionId: meta.relaySessionId || null,
    queuedCount: meta.queuedCount || 0,
    queuedSessionIds: meta.queuedSessionIds || [],
  };
}

function getCollabRecent(agentId, limit = COLLAB_RECENT_LIMIT) {
  const threads = bbs.getThreads('collab').filter((thread) =>
    !agentId || (thread.meta?.participants || []).includes(agentId));
  if (!threads.length) return [];
  const threadIds = threads.map((thread) => thread.id);
  const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
  return bbs.getRecent(limit, { board: 'collab', threadIds })
    .map((post) => pubCollabPost(post, threadMap.get(post.threadId)));
}

function getDirectThreadSummaries(limit = 18) {
  const threads = bbs.getThreads('collab').filter((thread) =>
    thread.meta?.kind === 'direct' || thread.meta?.kind === 'lead-direct');
  if (!threads.length) return [];
  const threadIds = threads.map((thread) => thread.id);
  const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
  const latestByThread = new Map();
  for (const post of bbs.getRecent(Math.max(limit * 6, 72), { board: 'collab', threadIds })) {
    if (latestByThread.has(post.threadId)) continue;
    latestByThread.set(post.threadId, pubCollabPost(post, threadMap.get(post.threadId)));
  }
  return [...latestByThread.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function broadcastCollabRecent() {
  broadcast({ type: 'collab_recent', posts: getCollabRecent(null, COLLAB_RECENT_LIMIT) });
  broadcastCommsOverview();
}

function getCommsOverview() {
  const liveAgents = [...agents.values()];
  const pending = [...prompts.values()].map(pubPrompt)
    .sort((a, b) => {
      if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  return {
    generatedAt: Date.now(),
    channels: getProjectChannels(),
    prompts: pending,
    recentChannels: getChannelRecent(null, 18),
    recentCollab: getCollabRecent(null, 14),
    directThreads: getDirectThreadSummaries(18),
    stats: {
      liveAgents: liveAgents.length,
      blockedAgents: liveAgents.filter((a) => a.status === 'blocked').length,
      workingAgents: liveAgents.filter((a) => a.status === 'working').length,
      managedSessions: runtimes.listSessions().filter((s) => s.alive).length,
    },
  };
}

function broadcastCommsOverview() {
  broadcast({ type: EV.COMMS_OVERVIEW, overview: getCommsOverview() });
}

function findDirectCollabThread(fromAgentId, toAgentId) {
  const key = collabParticipantKey(fromAgentId, toAgentId);
  return bbs.getThreads('collab').find((thread) =>
    thread.meta?.kind === 'direct' && thread.meta?.participantKey === key) || null;
}

function findLeadDirectThread(toAgentId) {
  return bbs.getThreads('collab').find((thread) =>
    thread.meta?.kind === 'lead-direct' && thread.meta?.toAgentId === toAgentId) || null;
}

function leadDirectSubject(to, subject) {
  return subject || `[Lead direct] Lead -> ${to.name}`;
}

function formatLeadDirectRelay(to, content) {
  return [
    `[Office lead direct] Lead -> ${to.name}`,
    content,
  ].filter(Boolean).join('\n');
}

function sendCollabMessage(body) {
  const from = resolveAgentRef(body.fromAgentId || body.from || body.authorId || body.author);
  const to = resolveAgentRef(body.toAgentId || body.to || body.recipientId || body.recipient);
  if (!from || !to) {
    return { error: 'from/to agent not found', status: 404 };
  }
  const content = (body.content || body.text || '').trim();
  if (!content) return { error: 'content required', status: 400 };

  let thread = body.threadId ? bbs.getThread(body.threadId)?.thread || null : null;
  if (!thread) thread = findDirectCollabThread(from.id, to.id);
  const subject = thread?.subject || collabSubject(from, to, body.subject);
  const relayTarget = body.relay === false
    ? null
    : resolveRuntimeSessionRef(body.targetSession || body.targetRuntimeSessionId || body.toRuntimeSessionId)?.id
      || resolveAgentRuntimeSessionStrict(to)?.id
      || null;
  let terminalDelivered = false;
  if (relayTarget) {
    try {
      const relaySession = runtimes.getSession(relayTarget);
      runtimes.sendInput(relayTarget,
        relayPayloadForSession(relaySession, formatCollabRelay(from, to, subject, content)),
        { enter: body.enter !== false });
      terminalDelivered = true;
    } catch {}
  }
  const queuedSession = !terminalDelivered
    && (!body.fromRuntimeSessionId || body.fromRuntimeSessionId !== resolveAgentAsyncInboxSession(to)?.id)
    ? resolveAgentAsyncInboxSession(to)
    : null;
  const queuedSessions = sessionSupportsAsyncInbox(queuedSession) ? [queuedSession] : [];
  const postMeta = {
    fromAgentId: from.id,
    fromAgentName: from.name,
    fromRuntimeSessionId: body.fromRuntimeSessionId || body.runtimeSessionId || null,
    toAgentId: to.id,
    toAgentName: to.name,
    terminalDelivered,
    relaySessionId: terminalDelivered ? relayTarget : null,
    queuedCount: queuedSessions.length,
    queuedSessionIds: queuedSessions.map((session) => session.id),
  };
  let post;
  if (!thread) {
    const created = bbs.createThread({
      board: 'collab',
      subject,
      author: from.name,
      authorType: 'agent',
      content,
      meta: {
        kind: 'direct',
        participantKey: collabParticipantKey(from.id, to.id),
        participants: [from.id, to.id],
        fromAgentId: from.id,
        fromAgentName: from.name,
        toAgentId: to.id,
        toAgentName: to.name,
      },
      postMeta,
    });
    thread = created.thread;
    post = created.post;
  } else {
    post = bbs.reply({
      threadId: thread.id,
      author: from.name,
      authorType: 'agent',
      content,
      meta: postMeta,
    });
  }
  broadcastBoardRecent();
  broadcastCollabRecent();
  const relaySession = terminalDelivered ? resolveRuntimeSessionSnapshot(relayTarget) : null;
  return {
    ok: true,
    thread,
    post: pubCollabPost(post, thread),
    terminalDelivered,
    targetSession: relayTarget,
    receipt: actionReceipt({
      stored: true,
      targetSessions: relaySession ? [relaySession] : [],
      queuedSessions,
    }),
  };
}

function sendLeadDirectMessage(body) {
  const to = resolveAgentRef(body.toAgentId || body.to || body.recipientId || body.recipient
    || body.agentId || body.agent);
  if (!to) return { error: 'recipient agent not found', status: 404 };
  const content = (body.content || body.text || '').trim();
  if (!content) return { error: 'content required', status: 400 };

  let thread = body.threadId ? bbs.getThread(body.threadId)?.thread || null : null;
  if (!thread) thread = findLeadDirectThread(to.id);
  const subject = thread?.subject || leadDirectSubject(to, body.subject);
  const relayTarget = body.relay === false
    ? null
    : resolveRuntimeSessionRef(body.targetSession || body.targetRuntimeSessionId || body.toRuntimeSessionId)?.id
      || resolveAgentRuntimeSessionStrict(to)?.id
      || null;
  let terminalDelivered = false;
  if (relayTarget) {
    try {
      const relaySession = runtimes.getSession(relayTarget);
      runtimes.sendInput(relayTarget,
        relayPayloadForSession(relaySession, formatLeadDirectRelay(to, content)),
        { enter: body.enter !== false });
      terminalDelivered = true;
    } catch {}
  }
  const queuedSession = !terminalDelivered ? resolveAgentAsyncInboxSession(to) : null;
  const queuedSessions = sessionSupportsAsyncInbox(queuedSession) ? [queuedSession] : [];
  const postMeta = {
    fromAgentId: null,
    fromAgentName: body.author || 'Lead',
    toAgentId: to.id,
    toAgentName: to.name,
    terminalDelivered,
    relaySessionId: terminalDelivered ? relayTarget : null,
    leadDirect: true,
    queuedCount: queuedSessions.length,
    queuedSessionIds: queuedSessions.map((session) => session.id),
  };
  let post;
  if (!thread) {
    const created = bbs.createThread({
      board: 'collab',
      subject,
      author: body.author || 'Lead',
      authorType: body.authorType || 'human',
      content,
      meta: {
        kind: 'lead-direct',
        participantKey: `lead:${to.id}`,
        participants: ['lead', to.id],
        fromAgentId: null,
        fromAgentName: body.author || 'Lead',
        toAgentId: to.id,
        toAgentName: to.name,
        leadDirect: true,
      },
      postMeta,
    });
    thread = created.thread;
    post = created.post;
  } else {
    post = bbs.reply({
      threadId: thread.id,
      author: body.author || 'Lead',
      authorType: body.authorType || 'human',
      content,
      meta: postMeta,
    });
  }
  broadcastCollabRecent();
  const relaySession = terminalDelivered ? resolveRuntimeSessionSnapshot(relayTarget) : null;
  return {
    ok: true,
    thread,
    post: pubCollabPost(post, thread),
    terminalDelivered,
    targetSession: relayTarget,
    receipt: actionReceipt({
      stored: true,
      targetSessions: relaySession ? [relaySession] : [],
      queuedSessions,
    }),
  };
}

function pubPrompt(p) {
  const runtime = runtimeSummaryForAgent(agents.get(p.agentId), {
    runtimeSessionId: p.terminalSessionId,
  });
  return {
    id: p.id,
    agentId: p.agentId,
    agentName: p.agentName,
    cwd: p.cwd,
    task: p.task,
    message: p.message,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    resolvedAt: p.resolvedAt || null,
    status: p.status,
    threadId: p.threadId || null,
    terminalSessionId: p.terminalSessionId || null,
    provider: runtime.provider || null,
    runtime,
    actions: promptReplyActions(p, runtime),
  };
}

function broadcastPrompts() {
  broadcast({
    type: 'prompts',
    prompts: [...prompts.values()].map(pubPrompt)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
  broadcastCommsOverview();
}

function normalizeTaskPriority(priority) {
  return TASK_PRIORITY_SET.has(priority) ? priority : 'normal';
}

function cleanDependsOn(dependsOn) {
  if (Array.isArray(dependsOn)) {
    return [...new Set(dependsOn.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  if (typeof dependsOn === 'string') {
    return cleanDependsOn(dependsOn.split(','));
  }
  return [];
}

function activeTaskStatus(status) {
  return status === 'doing' || status === 'blocked' || status === 'review';
}

function taskPromptForAgent(agentId) {
  const promptId = promptByAgent.get(agentId);
  return promptId && prompts.has(promptId) ? promptId : null;
}

function normalizeDeptId(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  if (value.startsWith('project:')) return value.slice('project:'.length);
  return value;
}

function resolveTaskDept(body, authorInfo, assigneeAgent) {
  const direct = normalizeDeptId(body.deptId || body.departmentId || '');
  if (direct) return direct;
  if (body.channelId || body.channel) {
    const channel = resolveChannelRef(body.channelId || body.channel, authorInfo.agent?.id || null);
    if (channel?.departmentId) return channel.departmentId;
  }
  if (assigneeAgent?.department?.id) return assigneeAgent.department.id;
  if (authorInfo.agent?.department?.id) return authorInfo.agent.department.id;
  if (body.sessionId || body.agentId || body.authorAgentId || body.authorSessionId) {
    const sessionAgent = resolveAgentRef(
      body.sessionId || body.agentId || body.authorAgentId || body.authorSessionId,
    );
    if (sessionAgent?.department?.id) return sessionAgent.department.id;
  }
  if (body.cwd) return resolveDepartment(body.cwd).id;
  return '';
}

function pubTask(task) {
  const assigneeAgent = task.assignee ? resolveAgentRef(task.assignee) : null;
  const linkedPrompt = task.promptId && prompts.has(task.promptId) ? prompts.get(task.promptId) : null;
  return {
    id: task.id,
    deptId: task.deptId,
    title: task.title,
    body: task.body || '',
    status: task.status,
    priority: task.priority || 'normal',
    assignee: task.assignee || null,
    assigneeName: assigneeAgent?.name || null,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    sessionId: task.sessionId || null,
    promptId: task.promptId || null,
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.slice() : [],
    live: !!task.sessionId,
    promptStatus: linkedPrompt?.status || null,
  };
}

function listTasks(opt = {}) {
  return tasks.list(opt).map(pubTask);
}

function broadcastTasks(deptId) {
  if (deptId) {
    broadcast({ type: EV.TASKS, deptId, tasks: listTasks({ deptId }) });
    return;
  }
  const deptIds = [...new Set(tasks.list().map((task) => task.deptId).filter(Boolean))];
  if (!deptIds.length) {
    broadcast({ type: EV.TASKS, deptId: null, tasks: [] });
    return;
  }
  for (const id of deptIds) {
    broadcast({ type: EV.TASKS, deptId: id, tasks: listTasks({ deptId: id }) });
  }
}

function sendTasksSnapshot(socket) {
  const deptIds = [...new Set(tasks.list().map((task) => task.deptId).filter(Boolean))];
  for (const deptId of deptIds) {
    socket.write(encodeFrame(JSON.stringify({
      type: EV.TASKS,
      deptId,
      tasks: listTasks({ deptId }),
    })));
  }
}

function createTask(body) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'title required', status: 400 };
  const authorInfo = resolveAuthorIdentity(body, { fallbackAuthor: 'Lead', fallbackType: 'human' });
  const assigneeRef = body.assignee || body.assigneeId || null;
  const assigneeAgent = resolveAgentRef(assigneeRef);
  if (assigneeRef && !assigneeAgent) return { error: 'assignee not found', status: 404 };
  const deptId = resolveTaskDept(body, authorInfo, assigneeAgent);
  if (!deptId) return { error: 'deptId required', status: 400 };
  const status = normalizeTaskStatus(body.status);
  const priority = normalizeTaskPriority(body.priority);
  const explicitSession = hasOwn(body, 'sessionId');
  const explicitPrompt = hasOwn(body, 'promptId');
  const sessionId = explicitSession
    ? (body.sessionId ? String(body.sessionId).trim() : null)
    : (activeTaskStatus(status) ? (authorInfo.agent?.id || assigneeAgent?.id || null) : null);
  const promptId = explicitPrompt
    ? (body.promptId ? String(body.promptId).trim() : null)
    : (status === 'blocked' && assigneeAgent ? taskPromptForAgent(assigneeAgent.id) : null);
  const task = tasks.create({
    deptId,
    title,
    body: body.body || '',
    status,
    priority,
    assignee: assigneeAgent?.id || null,
    createdBy: authorInfo.authorType === 'agent' && authorInfo.agent ? authorInfo.agent.id : 'human',
    sessionId,
    promptId,
    dependsOn: cleanDependsOn(body.dependsOn),
  });
  broadcastTasks(task.deptId);
  return { ok: true, task: pubTask(task) };
}

function updateTask(taskId, body) {
  const current = tasks.get(taskId);
  if (!current) return { error: 'task not found', status: 404 };
  const authorInfo = resolveAuthorIdentity(body, { fallbackAuthor: 'Lead', fallbackType: 'human' });
  const assigneeProvided = hasOwn(body, 'assignee') || hasOwn(body, 'assigneeId');
  const assigneeRef = assigneeProvided ? (body.assignee ?? body.assigneeId ?? null) : null;
  const assigneeAgent = assigneeProvided
    ? resolveAgentRef(assigneeRef || '')
    : (current.assignee ? resolveAgentRef(current.assignee) : null);
  if (assigneeProvided && assigneeRef && !assigneeAgent) return { error: 'assignee not found', status: 404 };
  const deptProvided = hasOwn(body, 'deptId') || hasOwn(body, 'departmentId')
    || hasOwn(body, 'channelId') || hasOwn(body, 'channel');
  const deptId = deptProvided
    ? resolveTaskDept(body, authorInfo, assigneeAgent)
    : current.deptId;
  if (!deptId) return { error: 'deptId required', status: 400 };
  const statusProvided = hasOwn(body, 'status');
  const nextStatus = statusProvided ? normalizeTaskStatus(body.status) : current.status;
  const patch = { deptId };
  if (hasOwn(body, 'title')) patch.title = body.title || '';
  if (hasOwn(body, 'body')) patch.body = body.body || '';
  if (statusProvided) patch.status = nextStatus;
  if (hasOwn(body, 'priority')) patch.priority = normalizeTaskPriority(body.priority);
  if (assigneeProvided) patch.assignee = assigneeAgent?.id || null;
  if (hasOwn(body, 'dependsOn')) patch.dependsOn = cleanDependsOn(body.dependsOn);
  if (hasOwn(body, 'sessionId')) {
    patch.sessionId = body.sessionId ? String(body.sessionId).trim() : null;
  } else if (statusProvided) {
    patch.sessionId = activeTaskStatus(nextStatus)
      ? (authorInfo.agent?.id || assigneeAgent?.id || current.sessionId || null)
      : null;
  }
  if (hasOwn(body, 'promptId')) {
    patch.promptId = body.promptId ? String(body.promptId).trim() : null;
  } else if (statusProvided) {
    patch.promptId = nextStatus === 'blocked'
      ? taskPromptForAgent(assigneeAgent?.id || current.assignee || '') || current.promptId || null
      : null;
  }
  const updated = tasks.update(taskId, patch);
  if (!updated) return { error: 'task not found', status: 404 };
  if (current.deptId !== updated.deptId) broadcastTasks(current.deptId);
  broadcastTasks(updated.deptId);
  return { ok: true, task: pubTask(updated) };
}

function clearAgentTaskSessions(agentId) {
  const touched = new Set();
  for (const task of tasks.list({ sessionId: agentId })) {
    tasks.update(task.id, { sessionId: null });
    touched.add(task.deptId);
  }
  for (const deptId of touched) broadcastTasks(deptId);
}

function postHelpRequest(id, message) {
  const a = agents.get(id);
  if (!a || !message) return null;
  const content = helpThreadContent(a, message);
  const threadId = requestThreadByAgent.get(id);
  if (threadId && bbs.getThread(threadId)) {
    bbs.reply({
      threadId,
      author: a.name,
      authorType: 'agent',
      content,
    });
  } else {
    const { thread } = bbs.createThread({
      board: 'requests',
      subject: `${a.name} needs input`,
      author: a.name,
      authorType: 'agent',
      content,
    });
    requestThreadByAgent.set(id, thread.id);
    broadcastBoardRecent();
    return thread.id;
  }
  broadcastBoardRecent();
  return threadId;
}

function resolveHelpRequest(id, message) {
  const threadId = requestThreadByAgent.get(id);
  if (!threadId) return;
  if (!bbs.getThread(threadId)) {
    requestThreadByAgent.delete(id);
    return;
  }
  bbs.reply({
    threadId,
    author: 'SYSTEM',
    authorType: 'system',
    content: message,
  });
  requestThreadByAgent.delete(id);
  broadcastBoardRecent();
}

function openPrompt(id, message) {
  const a = agents.get(id);
  if (!a || !message) return null;
  const existingId = promptByAgent.get(id);
  const threadId = postHelpRequest(id, message);
  const matched = resolveAgentRuntimeSession(a);
  if (existingId && prompts.has(existingId)) {
    const cur = prompts.get(existingId);
    cur.message = message;
    cur.updatedAt = Date.now();
    cur.status = 'pending';
    cur.threadId = threadId || cur.threadId || null;
    cur.terminalSessionId = matched?.id || cur.terminalSessionId || null;
    broadcastPrompts();
    return cur;
  }
  const prompt = {
    id: crypto.randomUUID(),
    agentId: id,
    agentName: a.name,
    cwd: a.cwd,
    task: a.task || '',
    message,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
    status: 'pending',
    threadId: threadId || null,
    terminalSessionId: matched?.id || null,
  };
  prompts.set(prompt.id, prompt);
  promptByAgent.set(id, prompt.id);
  broadcastPrompts();
  return prompt;
}

function resolvePromptForAgent(id, resolution) {
  const promptId = promptByAgent.get(id);
  if (!promptId || !prompts.has(promptId)) return;
  const prompt = prompts.get(promptId);
  prompt.status = 'resolved';
  prompt.resolvedAt = Date.now();
  prompt.updatedAt = prompt.resolvedAt;
  if (resolution) prompt.resolution = resolution;
  promptByAgent.delete(id);
  broadcastPrompts();
}

function replyToPrompt(promptId, body) {
  const prompt = prompts.get(promptId);
  if (!prompt) return { error: 'Prompt not found', status: 404 };
  const text = (body && body.text ? '' + body.text : '').trim();
  const author = body.author || 'Human';
  let boardPosted = false, terminalDelivered = false;
  let receiptTargetSession = null;
  if (text && prompt.threadId && bbs.getThread(prompt.threadId)) {
    bbs.reply({
      threadId: prompt.threadId,
      author,
      authorType: 'human',
      content: text,
    });
    boardPosted = true;
    broadcastBoardRecent();
  }
  const target = body.targetSession
    || resolveRuntimeSessionRef(prompt.terminalSessionId)?.id
    || resolveAgentRuntimeSessionStrict(agents.get(prompt.agentId))?.id
    || null;
  if (text && target) {
    try {
      runtimes.sendInput(target, text, { enter: body.enter !== false });
      terminalDelivered = true;
      prompt.terminalSessionId = target;
      receiptTargetSession = resolveRuntimeSessionSnapshot(target);
    } catch {}
  }
  if (body.close !== false) {
    prompt.status = 'resolved';
    prompt.resolvedAt = Date.now();
    prompt.updatedAt = prompt.resolvedAt;
    promptByAgent.delete(prompt.agentId);
  } else {
    prompt.updatedAt = Date.now();
  }
  broadcastPrompts();
  return {
    ok: true,
    prompt: pubPrompt(prompt),
    boardPosted,
    terminalDelivered,
    targetSession: target,
    receipt: actionReceipt({
      stored: boardPosted,
      targetSessions: receiptTargetSession ? [receiptTargetSession] : [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Hook event -> animation state
// ---------------------------------------------------------------------------
function handleHook(ev) {
  const id = ev.session_id || ev.sessionId;
  if (!id) return;
  const name = ev.hook_event_name || ev.event;
  const base = {};
  if (ev.cwd) base.cwd = ev.cwd;
  if (ev.model) base.model = ev.model;
  if (ev.provider) base.provider = ev.provider;
  if (typeof ev.contextPct === 'number') base.contextPct = ev.contextPct;
  if (Object.prototype.hasOwnProperty.call(ev, 'note')) base.note = ev.note || '';
  if (Object.prototype.hasOwnProperty.call(ev, 'runtime_session_id')
    || Object.prototype.hasOwnProperty.call(ev, 'runtimeSessionId')) {
    const runtimeSessionId = ev.runtime_session_id ?? ev.runtimeSessionId ?? '';
    base.runtimeSessionId = runtimeSessionId ? String(runtimeSessionId) : null;
  }
  if (ev.transcript_path) {
    const st = readTranscriptStats(ev.transcript_path);
    if (st) { base.model = st.model; base.contextPct = st.contextPct; }
  }

  switch (name) {
    case 'SessionStart':
      touch(id, { ...base, status: 'arriving', tool: '' });
      setTimeout(() => { if (agents.get(id)?.status === 'arriving') touch(id, { status: 'thinking' }); }, 1500);
      break;
    case 'UserPromptSubmit':
      touch(id, { ...base, status: 'thinking', tool: '' });
      resolveHelpRequest(id, 'Human acknowledged the request and replied.');
      resolvePromptForAgent(id, 'Human acknowledged the request and replied.');
      break;
    case 'PreToolUse':
      touch(id, { ...base, status: 'working', tool: ev.tool_name || '' });
      scheduleSettle(id);
      break;
    case 'PostToolUse':
      touch(id, { ...base, status: 'working', tool: ev.tool_name || '' });
      scheduleSettle(id);
      break;
    case 'Notification':
      touch(id, { ...base, status: 'blocked', tool: '', note: ev.message || 'needs you' });
      openPrompt(id, ev.message || 'needs input');
      break;
    case 'Stop':
      touch(id, { ...base, status: 'done', tool: '' });
      scheduleSettle(id);
      break;
    case 'SubagentStop':
      { const a = agents.get(id); if (a) broadcast({ type: 'subagent', id, name: a.name }); }
      break;
    case 'SessionEnd':
      resolveHelpRequest(id, 'Session closed before the request was resolved.');
      resolvePromptForAgent(id, 'Session closed before the request was resolved.');
      remove(id);
      break;
    default:
      touch(id, base);
  }
}

// ---------------------------------------------------------------------------
// Minimal WebSocket (RFC6455, text frames, no deps)
// ---------------------------------------------------------------------------
const clients = new Set();
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(str) {
  const payload = Buffer.from(str);
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}
function broadcast(obj) {
  const f = encodeFrame(JSON.stringify(obj));
  for (const s of clients) { try { s.write(f); } catch { clients.delete(s); } }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  clients.add(socket);
  socket.write(encodeFrame(JSON.stringify({
    type: 'snapshot',
    agents: [...agents.values()].map(pub),
    boardRecent: bbs.getRecent(BBS_RECENT_LIMIT),
    collabRecent: getCollabRecent(null, COLLAB_RECENT_LIMIT),
    prompts: [...prompts.values()].map(pubPrompt),
    commsOverview: getCommsOverview(),
    call: callView(),
  })));
  sendTasksSnapshot(socket);
  socket.on('data', (b) => {
    // We only care about the close opcode (0x8); ignore the rest.
    if (b.length && (b[0] & 0x0f) === 0x8) { clients.delete(socket); socket.end(); }
  });
  const drop = () => clients.delete(socket);
  socket.on('close', drop);
  socket.on('error', drop);
}

// ---------------------------------------------------------------------------
// Conference call — speak-queue + bidding/routing (CONFERENCE_CALL.md §4, §6).
// One voice at a time: the daemon hands the browser the current utterance, the
// browser plays it and acks `tts-done`, the daemon advances. A watchdog auto-
// advances if no browser is listening so the queue never wedges. Agents bid for
// the floor; the Operator (operator.mjs) selects, speaks, and routes the human's
// transcribed replies back into agent sessions.
// ---------------------------------------------------------------------------
const VOICE_PORT = Number(process.env.OFFICE_VOICE_PORT || 4318);
const STT_PORT = Number(process.env.OFFICE_STT_PORT || 4319);
// Standing note appended to every routed instruction so agents stay succinct (§6).
const VOCAL_META = '(User is on the vocal interface. Please be succinct.)';
const call = new CallQueue();
let callWatchdog = null;
const callBids = new Map();        // agentId -> bid (latest replaces older)
const callTranscripts = [];        // human STT awaiting the Operator (drained)

function listBids() {
  return [...callBids.values()].sort((a, b) => b.createdAt - a.createdAt);
}
function callView() {
  return { ...call.state(), bids: listBids() };
}
function broadcastCall() {
  broadcast({ type: EV.CALL, call: callView() });
}
function clearCallWatchdog() {
  if (callWatchdog) { clearTimeout(callWatchdog); callWatchdog = null; }
}
function armCallWatchdog(item) {
  clearCallWatchdog();
  const chars = (item.speech ? item.speech.length : 0)
    + (item.announce && item.announce.text ? item.announce.text.length : 0);
  const ms = Math.min(60000, 5000 + chars * 80);
  callWatchdog = setTimeout(() => { callWatchdog = null; finishCall(item.id); }, ms);
}
function pumpCall() {
  if (!call.current) {
    const next = call.advance();
    if (next) armCallWatchdog(next);
  }
  broadcastCall();
}
function enqueueUtterance({ agentId, agentName, text, urgency, voice, operator } = {}) {
  const speech = speechify(text);
  if (!speech) return null;
  const name = operator ? 'Operator' : (agentName || 'Agent');
  const item = {
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agentId: operator ? null : (agentId || null),
    agentName: name,
    text: String(text),
    speech,
    // Operator speech (announcements, confirmations, rephrase prompts) uses the
    // reserved announcer voice and skips the name-announce — it IS the announcer.
    voice: operator ? ANNOUNCER_VOICE : voiceFor(agentId, voice),
    announce: operator ? null : { text: name, voice: ANNOUNCER_VOICE },
    urgency: urgency || 'normal',
    createdAt: Date.now(),
  };
  call.enqueue(item);
  pumpCall();
  return item;
}
function finishCall(id) {
  const done = call.ack(id);
  if (!done) return false;
  clearCallWatchdog();
  pumpCall();
  return true;
}

// A bid is the structured "I want the floor" / "I need a decision" (§4). Latest
// bid per agent wins; the Operator clears it when the turn is granted.
function submitBid({ agentId, agentName, urgency, summary, question, options, blockedOn, kind } = {}) {
  if (!agentId) return null;
  const bid = {
    id: 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agentId,
    agentName: agentName || 'Agent',
    // 'clarification' = a re-bid because a routed instruction was too unclear to
    // act on; the Operator prioritizes these so the half-finished exchange closes
    // before new turns start (CONFERENCE_CALL.md §6).
    kind: kind === 'clarification' ? 'clarification' : 'turn',
    urgency: urgency || 'normal',
    summary: summary ? String(summary) : '',
    question: question ? String(question) : '',
    options: Array.isArray(options) ? options.map(String) : [],
    blockedOn: blockedOn ? String(blockedOn) : '',
    createdAt: Date.now(),
  };
  callBids.set(agentId, bid);
  broadcastCall();
  return bid;
}
function clearBid(agentId) {
  const had = callBids.delete(agentId);
  if (had) broadcastCall();
  return had;
}

// Resolve a routing target by id (preferred) or fuzzy name (§6 addressing).
function resolveCallTarget({ targetAgentId, targetName } = {}) {
  if (targetAgentId && agents.has(targetAgentId)) return agents.get(targetAgentId);
  const needle = String(targetName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!needle) return null;
  let best = null;
  for (const a of agents.values()) {
    const norm = String(a.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (norm === needle) return a;
    if (!best && norm.includes(needle)) best = a;
  }
  return best;
}

// Inject the Operator's processed instruction into an agent's session (§6). The
// agent receives clean text + the standing succinctness note — never raw STT.
function routeToAgent({ targetAgentId, targetName, instruction, appendMeta } = {}) {
  const text = String(instruction || '').trim();
  if (!text) return { error: 'instruction required', status: 400 };
  const agent = resolveCallTarget({ targetAgentId, targetName });
  if (!agent) return { error: 'target agent not found', status: 404 };
  const session = resolveAgentRuntimeSession(agent);
  const payload = appendMeta === false ? text : `${text}\n\n${VOCAL_META}`;
  let delivered = false;
  if (session) {
    try {
      runtimes.sendInput(session.id, relayPayloadForSession(session, payload), { enter: true });
      delivered = true;
    } catch { /* session may have died */ }
  }
  return {
    ok: true,
    delivered,
    targetAgentId: agent.id,
    targetName: agent.name,
    targetSession: session ? session.id : null,
    text: payload,
  };
}


// ---------------------------------------------------------------------------
// Project context for the filing cabinet. SAFE: never reads .env contents,
// never returns secret values — only what we're working with.
// ---------------------------------------------------------------------------
function getProjectInfo(cwd) {
  const out = { cwd, exists: false, claudeMd: null, agentsMd: false,
    envFiles: [], dotClaude: [], skills: [], files: [] };
  try {
    if (!cwd || !fs.statSync(cwd).isDirectory()) return out;
    out.exists = true;
    const ents = fs.readdirSync(cwd, { withFileTypes: true });
    out.envFiles = ents.filter((e) => /^\.env/.test(e.name))
      .map((e) => e.name).slice(0, 8);                 // NAMES ONLY
    out.agentsMd = ents.some((e) => e.name === 'AGENTS.md');
    out.files = ents
      .filter((e) => !/^(node_modules|\.git|\.DS_Store)$/.test(e.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory())
        || a.name.localeCompare(b.name))
      .slice(0, 24)
      .map((e) => e.isDirectory() ? e.name + '/' : e.name);
    const cmd = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(cmd)) {
      const txt = fs.readFileSync(cmd, 'utf8').slice(0, 8192);
      const head = txt.split('\n').find((l) => l.trim().startsWith('#'));
      out.claudeMd = { heading: (head || 'CLAUDE.md').replace(/^#+\s*/, '')
        .slice(0, 60), lines: txt.split('\n').length,
        kb: Math.max(1, Math.round(fs.statSync(cmd).size / 1024)) };
    }
    const dc = path.join(cwd, '.claude');
    if (fs.existsSync(dc) && fs.statSync(dc).isDirectory()) {
      out.dotClaude = fs.readdirSync(dc).slice(0, 16);
      const sk = path.join(dc, 'skills');
      if (fs.existsSync(sk)) out.skills = fs.readdirSync(sk).slice(0, 24);
    }
  } catch { /* unreadable — return what we have */ }
  return out;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP: UI + hook ingest
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/hook') {
    try { handleHook(await readJsonBody(req)); } catch { /* ignore bad payloads */ }
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && pathname === '/state') {
    sendJson(res, 200, [...agents.values()].map(pub));
    return;
  }
  if (req.method === 'GET' && pathname === '/project') {
    sendJson(res, 200, getProjectInfo(url.searchParams.get('cwd') || ''));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    const runtime = runtimes.runtimeStatus();
    sendJson(res, 200, {
      status: 'ok',
      agents: agents.size,
      departments: [...new Set([...agents.values()]
        .map((a) => a.department?.id).filter(Boolean))].length,
      boards: bbs.getBoards().length,
      tasks: tasks.list().length,
      recentPosts: bbs.getRecent(BBS_RECENT_LIMIT).length,
      pendingPrompts: [...prompts.values()].filter((p) => p.status === 'pending').length,
      tmuxAvailable: runtime.tmuxAvailable,
      claudeAvailable: runtime.claudeAvailable,
      codexAvailable: runtime.codexAvailable,
      shellAvailable: runtime.shellAvailable,
      managedSessions: runtime.sessions.filter((s) => s.kind === 'terminal' && s.alive).length,
      codexObserver: getCodexObserverStatus(),
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/agents') {
    sendJson(res, 200, [...agents.values()].map(pub));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/prompts') {
    const status = url.searchParams.get('status');
    let list = [...prompts.values()].map(pubPrompt).sort((a,b)=>b.updatedAt-a.updatedAt);
    if (status) list = list.filter((p) => p.status === status);
    sendJson(res, 200, list);
    return;
  }
  if (req.method === 'POST' && pathname.startsWith('/api/prompts/')) {
    const parts = pathname.split('/').filter(Boolean);
    const promptId = parts[2];
    const action = parts[3] || 'reply';
    if (action === 'reply') {
      let body;
      try { body = await readJsonBody(req); }
      catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
      const result = replyToPrompt(promptId, body);
      sendJson(res, result.status || 200, result);
      return;
    }
  }
  if (req.method === 'GET' && pathname === '/api/terminal/status') {
    sendJson(res, 200, {
      ...runtimes.runtimeStatus(),
      codexObserver: getCodexObserverStatus(),
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/observers') {
    sendJson(res, 200, {
      codex: getCodexObserverStatus(),
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/runtimes') {
    sendJson(res, 200, runtimes.listRuntimes());
    return;
  }
  if (req.method === 'GET' && pathname === '/api/sessions') {
    sendJson(res, 200, runtimes.listSessions());
    return;
  }
  if (req.method === 'GET' && pathname === '/api/terminal/sessions') {
    sendJson(res, 200, {
      managed: runtimes.listSessions(),
      live: runtimes.listLiveTerminals(),
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/terminal/spawn') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    try {
      sendJson(res, 200, runtimes.spawnSession({
        runtimeId: body.runtimeId,
        name: body.name,
        cwd: body.cwd || process.cwd(),
        task: body.task || '',
        provider: body.provider || 'claude',
        systemPrompt: body.systemPrompt || '',
        command: body.command || '',
        args: Array.isArray(body.args) ? body.args : [],
        claudeArgs: Array.isArray(body.claudeArgs) ? body.claudeArgs : [],
        codexArgs: Array.isArray(body.codexArgs) ? body.codexArgs : [],
        env: body.env && typeof body.env === 'object' ? body.env : {},
      }));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }
  if (pathname.startsWith('/api/terminal/')) {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || '';
    if (req.method === 'GET' && action === 'snapshot') {
      try {
        sendJson(res, 200, {
          session: runtimes.getSession(sessionId),
          text: runtimes.capture(sessionId, Number(url.searchParams.get('lines') || 220)),
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (req.method === 'POST' && action === 'input') {
      let body;
      try { body = await readJsonBody(req); }
      catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
      try {
        runtimes.sendInput(sessionId, body.text || '', { enter: body.enter !== false });
        sendJson(res, 200, { ok: true, sessionId });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (req.method === 'DELETE' && !action) {
      runtimes.kill(sessionId);
      sendJson(res, 200, { ok: true, sessionId });
      return;
    }
  }
  if (req.method === 'GET' && pathname === '/api/bbs/boards') {
    sendJson(res, 200, bbs.getBoards());
    return;
  }
  if (req.method === 'GET' && pathname === '/api/bbs/threads') {
    sendJson(res, 200, bbs.getThreads(url.searchParams.get('board') || undefined));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/bbs/threads/')) {
    const parts = pathname.split('/').filter(Boolean);
    const threadId = parts[3];
    const wantsReply = parts[4] === 'reply';
    if (!wantsReply) {
      const thread = bbs.getThread(threadId);
      if (!thread) { sendJson(res, 404, { error: 'Thread not found' }); return; }
      sendJson(res, 200, thread);
      return;
    }
  }
  if (req.method === 'GET' && pathname === '/api/bbs/recent') {
    sendJson(res, 200, bbs.getRecent(Number(url.searchParams.get('limit') || BBS_RECENT_LIMIT)));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/collab/recent') {
    sendJson(res, 200, getCollabRecent(
      url.searchParams.get('agentId') || undefined,
      Number(url.searchParams.get('limit') || COLLAB_RECENT_LIMIT),
    ));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/comms/overview') {
    sendJson(res, 200, getCommsOverview());
    return;
  }
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const deptId = normalizeDeptId(url.searchParams.get('deptId') || url.searchParams.get('departmentId') || '');
    const assignee = url.searchParams.get('assignee') || '';
    const resolvedAssignee = assignee ? resolveAgentRef(assignee) : null;
    const status = url.searchParams.get('status') || '';
    const promptId = url.searchParams.get('promptId') || '';
    const sessionId = url.searchParams.get('sessionId') || '';
    const list = listTasks({
      deptId: deptId || undefined,
      assignee: resolvedAssignee?.id || undefined,
      status: status || undefined,
      promptId: promptId || undefined,
      sessionId: sessionId || undefined,
    });
    sendJson(res, 200, { tasks: list });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/tasks') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const result = createTask(body);
    sendJson(res, result.status || 200, result);
    return;
  }
  if (pathname.startsWith('/api/tasks/')) {
    const taskId = decodeURIComponent(pathname.split('/').filter(Boolean)[2] || '');
    if (req.method === 'GET') {
      const task = tasks.get(taskId);
      if (!task) { sendJson(res, 404, { error: 'task not found' }); return; }
      sendJson(res, 200, { task: pubTask(task) });
      return;
    }
    if (req.method === 'PATCH') {
      let body;
      try { body = await readJsonBody(req); }
      catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
      const result = updateTask(taskId, body);
      sendJson(res, result.status || 200, result);
      return;
    }
  }
  if (req.method === 'POST' && pathname === '/api/collab/message') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const result = sendCollabMessage(body);
    sendJson(res, result.status || 200, result);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/comms/direct-message') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const result = sendLeadDirectMessage(body);
    sendJson(res, result.status || 200, result);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/call/config') {
    sendJson(res, 200, { voicePort: VOICE_PORT, sttPort: STT_PORT, announcerVoice: ANNOUNCER_VOICE });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/call/state') {
    sendJson(res, 200, callView());
    return;
  }
  if (req.method === 'POST' && pathname === '/api/call/speak') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    if (!body.text || !String(body.text).trim()) {
      sendJson(res, 400, { error: 'text required' });
      return;
    }
    const item = enqueueUtterance(body);
    if (!item) { sendJson(res, 400, { error: 'nothing speakable after sanitizing' }); return; }
    sendJson(res, 200, { ok: true, id: item.id, speech: item.speech, state: callView() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/call/ack') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    sendJson(res, 200, { ok: finishCall(body.id) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/call/bids') {
    sendJson(res, 200, { bids: listBids() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/call/bid') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    if (!body.agentId) { sendJson(res, 400, { error: 'agentId required' }); return; }
    const bid = submitBid(body);
    sendJson(res, 200, { ok: true, bid });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/call/bid/clear') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    sendJson(res, 200, { ok: clearBid(body.agentId) });
    return;
  }
  // Browser posts the human's raw STT here; the Operator drains it (GET below).
  if (req.method === 'POST' && pathname === '/api/call/transcript') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    if (!body.text || !String(body.text).trim()) {
      sendJson(res, 400, { error: 'text required' });
      return;
    }
    callTranscripts.push({
      id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: String(body.text),
      confidence: typeof body.confidence === 'number' ? body.confidence : null,
      createdAt: Date.now(),
    });
    sendJson(res, 200, { ok: true, pending: callTranscripts.length });
    return;
  }
  // Operator drains pending transcripts (returns and clears).
  if (req.method === 'GET' && pathname === '/api/call/transcripts') {
    const drained = callTranscripts.splice(0, callTranscripts.length);
    sendJson(res, 200, { transcripts: drained });
    return;
  }
  // Operator routes a processed instruction into an agent's session (§6).
  if (req.method === 'POST' && pathname === '/api/call/route') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const result = routeToAgent(body);
    sendJson(res, result.status || 200, result);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/channels') {
    sendJson(res, 200, getProjectChannels());
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/channels/')) {
    const parts = pathname.split('/').filter(Boolean);
    const channelId = decodeURIComponent(parts[2] || '');
    const action = parts[3] || '';
    if (action === 'recent') {
      sendJson(res, 200, getChannelRecent(
        channelId,
        Number(url.searchParams.get('limit') || CHANNEL_RECENT_LIMIT),
      ));
      return;
    }
  }
  if (req.method === 'POST' && pathname.startsWith('/api/channels/')) {
    const parts = pathname.split('/').filter(Boolean);
    const channelId = decodeURIComponent(parts[2] || '');
    const action = parts[3] || '';
    if (action === 'message') {
      let body;
      try { body = await readJsonBody(req); }
      catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
      const result = sendChannelMessage({ ...body, channelId });
      sendJson(res, result.status || 200, result);
      return;
    }
  }
  if (req.method === 'POST' && pathname === '/api/bbs/threads') {
    let body;
    try { body = await readJsonBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const { board, subject, author, authorType, content, pinned } = body;
    if (!subject || !content || !author) {
      sendJson(res, 400, { error: 'subject, author, content required' });
      return;
    }
    const created = bbs.createThread({
      board: board || 'general',
      subject,
      author,
      authorType: authorType || 'agent',
      content,
      pinned: !!pinned,
    });
    broadcastBoardRecent();
    sendJson(res, 200, created);
    return;
  }
  if (req.method === 'POST' && pathname.startsWith('/api/bbs/threads/')) {
    const parts = pathname.split('/').filter(Boolean);
    const threadId = parts[3];
    const wantsReply = parts[4] === 'reply';
    if (wantsReply) {
      let body;
      try { body = await readJsonBody(req); }
      catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
      const { author, authorType, content } = body;
      if (!author || !content) {
        sendJson(res, 400, { error: 'author, content required' });
        return;
      }
      const post = bbs.reply({
        threadId,
        author,
        authorType: authorType || 'agent',
        content,
      });
      if (!post) { sendJson(res, 404, { error: 'Thread not found' }); return; }
      broadcastBoardRecent();
      sendJson(res, 200, post);
      return;
    }
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    }).end();
    return;
  }
  // static: index.html
  const file = pathname === '/' || pathname === '' ? 'index.html' : pathname.slice(1);
  const fp = path.join(__dir, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(fp);
    const ct = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'text/javascript'
        : ext === '.css' ? 'text/css'
          : ext === '.svg' ? 'image/svg+xml'
            : ext === '.webmanifest' ? 'application/manifest+json'
              : ext === '.json' ? 'application/json'
                : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => handleUpgrade(req, socket));

// Sweep stale agents (a session that died without SessionEnd).
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of agents) {
    if (now - a.lastSeen > 30 * 60 * 1000) remove(id);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  startCodexObserver();
  startOperator();
  console.log(`\n  The Office is open  →  http://localhost:${PORT}\n` +
    `  hook ingest:  POST http://localhost:${PORT}/hook\n` +
    `  state debug:  http://localhost:${PORT}/state\n`);
});

process.on('SIGINT', () => {
  shuttingDown = true;
  stopCodexObserver();
  stopOperator();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shuttingDown = true;
  stopCodexObserver();
  stopOperator();
  process.exit(0);
});
