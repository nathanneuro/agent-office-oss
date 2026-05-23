#!/usr/bin/env node
// office-call.mjs — speak into the conference call (CONFERENCE_CALL.md, Phase 0).
//
// Usage:
//   node office-call.mjs speak <message...>
//   echo "done with the parser, what next?" | node office-call.mjs speak
//   node office-call.mjs state
//
// Phase 0 is output-only: an utterance is sanitized for speech and queued; the
// browser reads it aloud one at a time. (Bidding, the Operator, and your spoken
// replies arrive in later phases.)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { requestJson } from './office-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.OFFICE_PORT || 4317;
const BASE = `http://127.0.0.1:${PORT}`;
const GLOBAL_PROFILES = path.join(os.homedir(), '.claude', 'agent-office', 'profiles.json');
const LOCAL_PROFILES = path.join(HERE, 'data', 'profiles.local.json');
const argv = process.argv.slice(2);

function help() {
  console.log(
    'node office-call.mjs speak <message...>\n'
    + 'node office-call.mjs state\n'
    + '\n'
    + 'If <message> is omitted, stdin is used.'
  );
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { bySession: {}, byCwd: {} }; }
}

function loadProfiles() {
  const global = readJson(GLOBAL_PROFILES);
  const local = readJson(LOCAL_PROFILES);
  return {
    bySession: { ...(global.bySession || {}), ...(local.bySession || {}) },
    byCwd: { ...(global.byCwd || {}), ...(local.byCwd || {}) },
  };
}

function sessionId() {
  return process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '';
}

function resolveSelf() {
  const profiles = loadProfiles();
  const cwd = process.cwd();
  const sid = sessionId();
  const prof = { ...(cwd && profiles.byCwd[cwd]), ...(sid && profiles.bySession[sid]) };
  return {
    sessionId: sid || null,
    name: prof.name || process.env.OFFICE_AUTHOR || process.env.USER || 'Agent',
  };
}

function readMessage(parts) {
  if (parts.length) return parts.join(' ').trim();
  try { return fs.readFileSync(0, 'utf8').trim(); }
  catch { return ''; }
}

const j = (pathname, opt = {}) => requestJson(BASE + pathname, opt);

const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') { help(); process.exit(0); }

if (cmd === 'state') {
  const state = await j('/api/call/state');
  if (state.current) {
    console.log(`speaking: ${state.current.agentName}: ${state.current.speech}`);
  } else {
    console.log('speaking: (idle)');
  }
  console.log(`queued: ${state.queued}`);
  process.exit(0);
}

if (cmd === 'speak') {
  const text = readMessage(argv.slice(1));
  if (!text) { console.error('office-call: message required.'); process.exit(1); }
  const me = resolveSelf();
  const res = await j('/api/call/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      agentId: me.sessionId,
      agentName: me.name,
    }),
  });
  console.log(`queued utterance ${res.id} · ${res.state.queued} ahead`);
  console.log(`  speech: ${res.speech}`);
  process.exit(0);
}

console.error(`office-call: unknown command "${cmd}"`);
help();
process.exit(1);
