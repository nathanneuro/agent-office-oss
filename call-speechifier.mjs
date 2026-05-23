// call-speechifier.mjs — turn an agent's text update into something that reads
// cleanly aloud. Pure, zero-dep. The deterministic safety floor under any
// Operator polishing (see CONFERENCE_CALL.md §5). Conservative by design: it
// would rather drop noise than mispronounce it.

const MAX_LEN = 600;

// Order matters: strip block-level noise before touching inline tokens.
function stripCodeBlocks(s) {
  return s.replace(/```[\s\S]*?```/g, ' shared a code snippet ')
    .replace(/~~~[\s\S]*?~~~/g, ' shared a code snippet ');
}

function stripInlineCode(s) {
  // Keep the words inside `backticks`, just drop the ticks.
  return s.replace(/`([^`]*)`/g, '$1');
}

function replaceUrls(s) {
  return s.replace(/\bhttps?:\/\/\S+/gi, ' a link ')
    .replace(/\bwww\.\S+/gi, ' a link ');
}

function shortenPaths(s) {
  // Anything that looks like a/b/c.ext or /abs/path → just the final segment.
  return s.replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/){2,}[\w.-]+/g, (m) => {
    const seg = m.split('/').filter(Boolean).pop() || m;
    return seg;
  });
}

function collapseLongTokens(s) {
  // Hex-ish hashes (sha, ids) → "a hash"; very long digit runs → "a long number".
  return s.replace(/\b[0-9a-f]{12,}\b/gi, ' a hash ')
    .replace(/\b\d{7,}\b/g, ' a long number ');
}

function expandSymbols(s) {
  return s
    .replace(/&/g, ' and ')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent ')
    .replace(/@/g, ' at ')
    .replace(/\+/g, ' plus ')
    .replace(/=/g, ' equals ');
}

function stripMarkdown(s) {
  return s
    .replace(/^#{1,6}\s+/gm, '')        // headings
    .replace(/^\s*[-*+]\s+/gm, '')      // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '')      // numbered list markers
    .replace(/^\s*>\s?/gm, '')          // blockquotes
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold
    .replace(/\*([^*]+)\*/g, '$1')      // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

// Drop characters that don't read aloud, keep sentence punctuation.
function stripSpecials(s) {
  // Remove emoji and other symbol/pictographic codepoints.
  let out = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ');
  // Keep letters, numbers, whitespace, and a small punctuation set.
  out = out.replace(/[^\p{L}\p{N}\s.,!?;:'\-]/gu, ' ');
  return out;
}

function tidy(s) {
  return s
    .replace(/\s+([.,!?;:])/g, '$1')    // no space before punctuation
    .replace(/([.,!?;:]){2,}/g, '$1')   // collapse repeats
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(s) {
  if (s.length <= MAX_LEN) return s;
  const cut = s.slice(0, MAX_LEN);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '),
    cut.lastIndexOf('! '));
  return (lastStop > 200 ? cut.slice(0, lastStop + 1) : cut.trim()) + '…';
}

export function speechify(input) {
  if (input == null) return '';
  let s = String(input);
  s = stripCodeBlocks(s);
  s = stripInlineCode(s);
  s = replaceUrls(s);
  s = shortenPaths(s);
  s = collapseLongTokens(s);
  s = stripMarkdown(s);
  s = expandSymbols(s);
  s = stripSpecials(s);
  s = tidy(s);
  s = clamp(s);
  return s;
}

// `node call-speechifier.mjs --selftest`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`
    && process.argv.includes('--selftest')) {
  const cases = [
    ['Done **building** the parser. Next?', 'Done building the parser. Next?'],
    ['See `src/lib/util/parse.mjs` for the fix', 'See parse.mjs for the fix'],
    ['Check https://example.com/x for details', 'Check a link for details'],
    ['Commit a1b2c3d4e5f60718 landed', 'Commit a hash landed'],
    ['Processed 1234567 rows', 'Processed a long number rows'],
    ['- item one\n- item two', 'item one item two'],
    ['Coverage at 87% now', 'Coverage at 87 percent now'],
    ['Ship it 🚀 today', 'Ship it today'],
  ];
  let fail = 0;
  for (const [inp, want] of cases) {
    const got = speechify(inp);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(inp)} -> ${JSON.stringify(got)}`
      + (ok ? '' : `  (want ${JSON.stringify(want)})`));
  }
  console.log(fail ? `\n${fail} failing` : '\nall passing');
  process.exit(fail ? 1 : 0);
}
