# Voice models (Piper)

The conference-call voice sidecar (`voice-sidecar.mjs`) reads Piper voice models
from this directory. Models are large binaries and are **git-ignored** — drop them
here locally.

## Layout

Each voice is a pair of files named by its voice id:

```
voices/
  en_US-amy-medium.onnx
  en_US-amy-medium.onnx.json
  ...
```

The voice ids assigned to agents and to the Operator's announcer live in
`call-voices.mjs` (`VOICE_POOL` and `ANNOUNCER_VOICE`). Provide a `.onnx` for each
id you want spoken; any missing model makes the sidecar return 503 for that voice
and the browser falls back to the built-in Web Speech voice.

## Getting models

Install Piper and download voices from the Piper releases / HuggingFace voice
catalog (`rhasspy/piper-voices`), e.g.:

```
# binary on PATH (or set PIPER_BIN)
piper --version

# place <id>.onnx and <id>.onnx.json in this folder
```

## Running the sidecar

```
npm run voice            # node voice-sidecar.mjs
# OFFICE_VOICE_PORT  (default 4318)
# OFFICE_VOICE_DIR   (default ./voices)
# PIPER_BIN          (default "piper")
```

Check it: `curl http://localhost:4318/health` shows whether piper is found and
which models are present.
