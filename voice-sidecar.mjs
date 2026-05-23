#!/usr/bin/env node
// voice-sidecar.mjs — open-source TTS for the conference call (Piper).
// Standalone Node service the *browser* talks to, so the daemon stays
// dependency-free (CONFERENCE_CALL.md §3.4). Zero npm deps: shells out to the
// `piper` binary. Degrades cleanly — if piper or a voice model is missing it
// returns 503 and the browser falls back to Web Speech.
//
// Run:   npm run voice          (or: node voice-sidecar.mjs)
// Models: drop Piper `<name>.onnx` (+ `.onnx.json`) files in ./voices
//         (override dir with OFFICE_VOICE_DIR). See voices/README.md.
import http from 'node:http';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.OFFICE_VOICE_PORT || 4318);
const PIPER_BIN = process.env.PIPER_BIN || 'piper';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = process.env.OFFICE_VOICE_DIR || path.join(HERE, 'voices');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function listModels() {
  try {
    return fs.readdirSync(VOICE_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.slice(0, -'.onnx'.length));
  } catch { return []; }
}

function piperAvailable() {
  const probe = cp.spawnSync(PIPER_BIN, ['--help'], { stdio: 'ignore' });
  return !probe.error;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Synthesize `text` with the given Piper model file → WAV buffer.
function synth(text, modelPath) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `office-tts-${crypto.randomUUID()}.wav`);
    let proc;
    try {
      proc = cp.spawn(PIPER_BIN, ['--model', modelPath, '--output_file', out]);
    } catch (e) { reject(e); return; }
    let err = '';
    proc.on('error', reject);                 // ENOENT → piper not installed
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      if (code !== 0) {
        fs.unlink(out, () => {});
        reject(new Error(`piper exited ${code}: ${err.trim()}`));
        return;
      }
      fs.readFile(out, (e, buf) => {
        fs.unlink(out, () => {});
        e ? reject(e) : resolve(buf);
      });
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      piper: piperAvailable(),
      voiceDir: VOICE_DIR,
      models: listModels(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/voices') {
    sendJson(res, 200, { voices: listModels() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tts') {
    let body;
    try { body = await readBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const text = String(body.text || '').trim();
    const voice = String(body.voice || '').trim();
    if (!text) { sendJson(res, 400, { error: 'text required' }); return; }
    if (!voice) { sendJson(res, 400, { error: 'voice required' }); return; }

    const modelPath = path.join(VOICE_DIR, `${voice}.onnx`);
    if (!fs.existsSync(modelPath)) {
      sendJson(res, 503, { error: `voice model not found: ${voice}`, voiceDir: VOICE_DIR });
      return;
    }
    try {
      const wav = await synth(text, modelPath);
      res.writeHead(200, { 'content-type': 'audio/wav', ...CORS });
      res.end(wav);
    } catch (e) {
      const missing = /ENOENT/.test(String(e && e.message));
      sendJson(res, missing ? 503 : 500, {
        error: missing ? `piper binary not found (${PIPER_BIN})` : String(e.message),
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  const models = listModels();
  console.log(`\n  Office voice sidecar  →  http://localhost:${PORT}\n`
    + `  piper:   ${piperAvailable() ? PIPER_BIN : `NOT FOUND (${PIPER_BIN}) — browser will fall back to Web Speech`}\n`
    + `  voices:  ${VOICE_DIR}\n`
    + `  models:  ${models.length ? models.join(', ') : '(none yet — see voices/README.md)'}\n`);
});
