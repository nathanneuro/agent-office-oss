#!/usr/bin/env node
// operator.mjs — the hidden conference-call coordinator (CONFERENCE_CALL.md §3.2).
//
// A daemon-managed subprocess (started when OFFICE_OPERATOR=1). It never appears
// in the room and holds no desk. Its whole job: watch bids, grant one turn at a
// time, brevity-edit each agent's update into a spoken turn, and route the human's
// transcribed replies back into the right agent's session.
//
// Brain: uses OpenRouter (OPENROUTER_API_KEY) for the §7 judgment templates when a
// key is set; otherwise a deterministic brain keeps the whole loop running with no
// key — preserving the repo's "no API keys needed" default.
import { requestJson } from './office-http.mjs';

const PORT = process.env.OFFICE_PORT || 4317;
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = Number(process.env.OFFICE_OPERATOR_POLL_MS || 1500);
const CONFIDENCE_FLOOR = Number(process.env.OFFICE_OPERATOR_FLOOR || 0.45);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OFFICE_OPERATOR_MODEL || 'anthropic/claude-3.7-sonnet';
const REPHRASE = "Sorry, I didn't catch that — could you rephrase?";

const j = (path, opt = {}) => requestJson(BASE + path, opt);
const postJson = (path, body) =>
  j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const log = (...a) => console.log(...a);

const URGENCY_RANK = { high: 3, normal: 2, low: 1 };

// Deterministic selection — judgment-free, so it lives in the core regardless of
// brain (CONFERENCE_CALL.md §7D): highest urgency, then longest-waiting.
function arbitrate(bids) {
  if (!bids || !bids.length) return null;
  return [...bids].sort((a, b) =>
    (URGENCY_RANK[b.urgency] || 2) - (URGENCY_RANK[a.urgency] || 2)
    || a.createdAt - b.createdAt)[0];
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---- Brains --------------------------------------------------------------

// No-LLM fallback: pass the bid through; route replies to whoever just spoke,
// overridden by a name detected in the transcript (§6 addressing).
const deterministicBrain = {
  name: 'deterministic',
  async brevityEdit(bid) {
    return {
      update: bid.summary || `Update from ${bid.agentName}.`,
      question: bid.question || 'What should I do next?',
      options: bid.options || [],
    };
  },
  async recover(text, ctx) {
    const clean = String(text || '').trim();
    if (!clean) return { outcome: 'rephrase', confidence: 0 };
    let targetAgentId = ctx.lastSpeaker && ctx.lastSpeaker.agentId;
    let targetName = ctx.lastSpeaker && ctx.lastSpeaker.agentName;
    const hay = normName(clean);
    for (const a of ctx.roster || []) {
      if (hay.includes(normName(a.name))) { targetAgentId = a.id; targetName = a.name; break; }
    }
    return { outcome: 'route', instruction: clean, targetAgentId, targetName, confidence: 0.7 };
  },
};

// OpenRouter brain — the §7 templates. Any failure delegates to deterministic so
// the call degrades instead of stalling.
function openRouterBrain() {
  async function chatJson(system, user) {
    const res = await requestJson('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPENROUTER_KEY}`,
        'x-title': 'The Office — Conference Call Operator',
      },
      body: {
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });
    const content = res && res.choices && res.choices[0]
      && res.choices[0].message && res.choices[0].message.content;
    const match = String(content || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in completion');
    return JSON.parse(match[0]);
  }

  const BREVITY_SYS =
    'You turn a software agent\'s status into ONE short spoken turn for a voice '
    + 'call. Output strict JSON: {"update": string, "question": string, "options": '
    + 'string[]}. The update is one or two plain spoken sentences — no code, paths, '
    + 'hashes, lists, or markdown. The question is a single clear question about '
    + 'what to do next. Copy options verbatim if present, else [].';

  const RECOVER_SYS =
    'You interpret a noisy speech-to-text transcript of a human answering an '
    + 'agent\'s question on a voice call. The transcript may contain phonetic '
    + 'errors, homophones, and mangled technical terms. Use the context to recover '
    + 'the intended meaning. Output strict JSON: {"outcome": "route" | "rephrase", '
    + '"instruction": string, "targetAgentId": string, "confidence": number}. '
    + 'confidence is 0..1. If even the best interpretation is too uncertain to act '
    + 'on, set outcome "rephrase". Otherwise "route": targetAgentId is who the reply '
    + 'is for (default: the agent who just asked unless a name in the transcript '
    + 'redirects it), and instruction is a clear plain-text directive for that agent.';

  return {
    name: 'openrouter',
    async brevityEdit(bid) {
      try {
        const out = await chatJson(BREVITY_SYS, JSON.stringify(bid));
        return {
          update: out.update || bid.summary || '',
          question: out.question || bid.question || 'What next?',
          options: Array.isArray(out.options) ? out.options : (bid.options || []),
        };
      } catch (e) {
        log(`brevityEdit fell back (${e.message})`);
        return deterministicBrain.brevityEdit(bid);
      }
    },
    async recover(text, ctx) {
      try {
        const out = await chatJson(RECOVER_SYS, JSON.stringify({
          transcript: text,
          openQuestion: ctx.lastSpeaker ? ctx.lastSpeaker.question : '',
          options: ctx.lastSpeaker ? ctx.lastSpeaker.options : [],
          defaultTargetAgentId: ctx.lastSpeaker ? ctx.lastSpeaker.agentId : null,
          roster: ctx.roster,
        }));
        return {
          outcome: out.outcome === 'rephrase' ? 'rephrase' : 'route',
          instruction: out.instruction || String(text || '').trim(),
          targetAgentId: out.targetAgentId || (ctx.lastSpeaker && ctx.lastSpeaker.agentId),
          confidence: typeof out.confidence === 'number' ? out.confidence : 0.5,
        };
      } catch (e) {
        log(`recover fell back (${e.message})`);
        return deterministicBrain.recover(text, ctx);
      }
    },
  };
}

const brain = OPENROUTER_KEY ? openRouterBrain() : deterministicBrain;

// ---- Loop ----------------------------------------------------------------

let lastSpeaker = null;   // { agentId, agentName, question, options }

async function roster() {
  try {
    const agents = await j('/state');
    return (agents || []).map((a) => ({ id: a.id, name: a.name }));
  } catch { return []; }
}

async function handleTranscript(t, people) {
  const ctx = { lastSpeaker, roster: people };
  const r = await brain.recover(t.text, ctx);
  if (r.outcome === 'rephrase' || (r.confidence || 0) < CONFIDENCE_FLOOR) {
    log(`transcript too unclear (conf ${r.confidence}) — asking for a rephrase`);
    await postJson('/api/call/speak', { operator: true, text: REPHRASE });
    return;
  }
  const out = await postJson('/api/call/route', {
    targetAgentId: r.targetAgentId,
    instruction: r.instruction,
  });
  log(`routed to ${out.targetName || r.targetAgentId || '?'} `
    + `(${out.delivered ? 'delivered' : 'no live session'}): ${r.instruction}`);
}

async function grantNextTurn(bids) {
  const bid = arbitrate(bids);
  if (!bid) return;
  const edited = await brain.brevityEdit(bid);
  const text = [edited.update, edited.question].filter(Boolean).join(' ');
  await postJson('/api/call/speak', {
    agentId: bid.agentId,
    agentName: bid.agentName,
    text,
    options: edited.options,
  });
  await postJson('/api/call/bid/clear', { agentId: bid.agentId });
  lastSpeaker = {
    agentId: bid.agentId,
    agentName: bid.agentName,
    question: edited.question,
    options: edited.options,
  };
  log(`granted turn to ${bid.agentName}: ${text}`);
}

async function tick() {
  let view;
  try { view = await j('/api/call/state'); }
  catch { return; }                              // daemon not ready yet

  // Human replies first — they unblock agents.
  let drained = [];
  try { drained = (await j('/api/call/transcripts')).transcripts || []; }
  catch { drained = []; }
  if (drained.length) {
    const people = await roster();
    for (const t of drained) {
      try { await handleTranscript(t, people); }
      catch (e) { log(`transcript error: ${e.message}`); }
    }
  }

  // Grant a turn only when the floor is truly idle.
  if (!view.speaking && (view.queued || 0) === 0 && view.bids && view.bids.length) {
    try { await grantNextTurn(view.bids); }
    catch (e) { log(`grant error: ${e.message}`); }
  }
}

log(`operator up · brain=${brain.name}${brain.name === 'openrouter' ? ` model=${MODEL}` : ''} · poll=${POLL_MS}ms`);
let stopped = false;
async function loop() {
  while (!stopped) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
loop();
