#!/usr/bin/env node
// stt-sidecar.mjs — open-source speech-to-text for the conference call (Whisper).
// Standalone Node service the *browser* posts mic audio to, keeping the daemon
// dependency-free (CONFERENCE_CALL.md §3.4). Zero npm deps: shells out to a
// Whisper CLI. Degrades cleanly — if the binary is missing it returns 503 and the
// browser falls back to the Web Speech recognition API.
//
// Run:   npm run stt            (or: node stt-sidecar.mjs)
// Config:
//   OFFICE_STT_PORT   (default 4319)
//   OFFICE_STT_BIN    (default "whisper" — the openai-whisper CLI)
//   OFFICE_STT_MODEL  (default "base.en")
//   OFFICE_STT_CMD    full override; a shell-free template with {input} and
//                     {model}, expected to print the transcript to stdout, e.g.
//                     "whisper-cli -m {model} -f {input} -nt"
// Note: openai-whisper reads webm/ogg via ffmpeg — install ffmpeg for browser
// MediaRecorder audio, or point OFFICE_STT_CMD at a pipeline that accepts it.
import http from 'node:http';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PORT = Number(process.env.OFFICE_STT_PORT || 4319);
const STT_BIN = process.env.OFFICE_STT_BIN || 'whisper';
const STT_MODEL = process.env.OFFICE_STT_MODEL || 'base.en';
const STT_CMD = process.env.OFFICE_STT_CMD || '';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function sttAvailable() {
  if (STT_CMD) return true;
  const probe = cp.spawnSync(STT_BIN, ['--help'], { stdio: 'ignore' });
  return !probe.error;
}

function readAudio(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 25e6) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function run(bin, args, opt = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = cp.spawn(bin, args, opt); }
    catch (e) { reject(e); return; }
    let out = '', err = '';
    proc.on('error', reject);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => code === 0
      ? resolve(out)
      : reject(new Error(`${bin} exited ${code}: ${err.trim()}`)));
  });
}

// Transcribe an audio buffer → text.
async function transcribe(audio) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-stt-'));
  const input = path.join(dir, `clip-${crypto.randomUUID()}.webm`);
  fs.writeFileSync(input, audio);
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  try {
    if (STT_CMD) {
      const parts = STT_CMD.split(/\s+/)
        .map((p) => p.replace('{input}', input).replace('{model}', STT_MODEL));
      const out = await run(parts[0], parts.slice(1));
      return out.trim();
    }
    // openai-whisper default: write a .txt next to a chosen output dir, read it.
    await run(STT_BIN, [input, '--model', STT_MODEL, '--language', 'en',
      '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False']);
    const txt = fs.readdirSync(dir).find((f) => f.endsWith('.txt'));
    return txt ? fs.readFileSync(path.join(dir, txt), 'utf8').trim() : '';
  } finally {
    cleanup();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', stt: sttAvailable(), bin: STT_CMD || STT_BIN, model: STT_MODEL });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/stt') {
    let audio;
    try { audio = await readAudio(req); }
    catch { sendJson(res, 400, { error: 'could not read audio' }); return; }
    if (!audio || !audio.length) { sendJson(res, 400, { error: 'empty audio' }); return; }
    try {
      const text = await transcribe(audio);
      sendJson(res, 200, { text });
    } catch (e) {
      const missing = /ENOENT/.test(String(e && e.message));
      sendJson(res, missing ? 503 : 500, {
        error: missing ? `whisper binary not found (${STT_BIN})` : String(e.message),
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  Office STT sidecar  →  http://localhost:${PORT}\n`
    + `  whisper: ${sttAvailable() ? (STT_CMD || STT_BIN) : `NOT FOUND (${STT_BIN}) — browser will fall back to Web Speech`}\n`
    + `  model:   ${STT_MODEL}\n`);
});
