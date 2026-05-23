// call-voices.mjs — distinct-voice assignment for the conference call
// (CONFERENCE_CALL.md §3.4, Phase 1). Pure, zero-dep. Names are Piper voice
// model basenames; the sidecar resolves each to `<name>.onnx` under its voice
// dir, and the browser falls back to a Web Speech voice when the sidecar or a
// model is missing.

// The Operator's announcer voice — reserved, distinct from every participant.
export const ANNOUNCER_VOICE = 'en_US-lessac-medium';

// Phonetically/timbrally spread pool, assigned deterministically to agents.
export const VOICE_POOL = Object.freeze([
  'en_US-amy-medium',
  'en_US-ryan-high',
  'en_GB-alba-medium',
  'en_US-kristin-medium',
  'en_GB-northern_english_male-medium',
  'en_US-joe-medium',
  'en_GB-cori-medium',
  'en_US-kusal-medium',
]);

// Stable per agent: same id → same voice across reconnects/restarts. An explicit
// override (profile or request body) always wins.
export function voiceFor(agentId, override) {
  if (override) return override;
  const key = String(agentId || '');
  if (!key) return VOICE_POOL[0];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return VOICE_POOL[h % VOICE_POOL.length];
}

// `node call-voices.mjs --selftest`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`
    && process.argv.includes('--selftest')) {
  let fail = 0;
  const a = voiceFor('agent-123');
  const b = voiceFor('agent-123');
  if (a !== b) { fail++; console.log('FAIL  not stable for same id'); }
  if (!VOICE_POOL.includes(a)) { fail++; console.log('FAIL  voice not in pool'); }
  if (voiceFor('x', 'custom-voice') !== 'custom-voice') { fail++; console.log('FAIL  override ignored'); }
  if (VOICE_POOL.includes(ANNOUNCER_VOICE)) { fail++; console.log('FAIL  announcer overlaps pool'); }
  // Spread: many ids should touch most of the pool.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(voiceFor('sess-' + i));
  if (seen.size < VOICE_POOL.length - 1) { fail++; console.log(`FAIL  poor spread (${seen.size}/${VOICE_POOL.length})`); }
  console.log(fail ? `\n${fail} failing` : `all passing (spread ${seen.size}/${VOICE_POOL.length})`);
  process.exit(fail ? 1 : 0);
}
