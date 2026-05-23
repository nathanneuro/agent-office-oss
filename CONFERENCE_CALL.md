# Conference Call — Design Doc

A voice extension for The Office: each agent gets a distinct synthesized voice,
the human talks back by voice, and a hidden coordinator decides who speaks when
and who your replies are addressed to.

Status: **design / not yet built.** This doc is for markup before code.

---

## 1. Goal

Turn the existing text-based monitoring room into a spoken "conference call":

- Each agent instance speaks updates aloud in its own distinct voice.
- Updates are short and speech-shaped — no long number lists, charts, paths, or
  special characters read aloud.
- Agents **bid for your attention** and take turns one at a time, chosen by the
  Operator; you never hear two voices at once. Each granted turn is a brief update
  on recent work plus a question about what to do next.
- You reply by voice — by default to whoever just asked, or naming an agent to
  redirect — and the system routes it to the right instance even when
  speech-to-text mangles the name.

Latency is **not** a priority for this use case, which deliberately shapes
several decisions below (favor accuracy and deliberation over speed).

---

## 2. Core insight: audio is a rendering layer

The Office already has the hard infrastructure — a WebSocket bus, presence and
identity keyed on session id, a NEEDS-YOU inbox for "agent is blocked waiting on
the human," per-agent profiles, and a tmux relay that injects text into a live
agent's session. None of the hard coordination needs to be invented; it needs to
be mapped onto what exists.

The design therefore separates cleanly:

- **Agents never touch audio.** They emit and consume *text* over the bus,
  exactly as today. This matters because agents run headless in
  terminals/containers — they can't play sound or hold a mic.
- **The browser client is the audio hub.** `public/index.html` is already a real
  browser tab on the bus. It runs text-to-speech playback, mic capture, and
  speech-to-text. It's the only place with WebAudio / MediaRecorder.
- **The daemon is the chairperson.** It already holds global state and broadcasts
  to everyone. It becomes the floor manager that enforces one-voice-at-a-time.
- **The Operator (new) is the brain.** A hidden, voiceless coordinator agent that
  parses your speech, decides who you addressed, and prompts the other agents.

```
agents (text only) ──WS──► daemon (floor mgr) ──WS──► browser (TTS out / STT in) ──► you
        ▲                        ▲                          │
        │                        │                          │
   prompt-injection         Operator (hidden, ◄─────────────┘
   (tmux relay)             voiceless coordinator)
```

---

## 3. Components

### 3.1 Daemon — deterministic enforcement

No "thinking" here; it stays the zero-dependency, mechanical core.

- Holds the **speak-queue**: dispatches one utterance to the browser, waits for a
  `tts-done` ack, then dispatches the next. This is what guarantees one voice at a
  time.
- Runs the **speechifier sanitizer** as a safety floor on every utterance (see
  §5).
- Relays **prompt-injection** into a target agent's session (reusing the existing
  tmux-stdin path that already feeds NEEDS-YOU replies back to blocked agents).
- Provides a **dumb fallback**: if the Operator subprocess is down, the daemon
  reads NEEDS-YOU items aloud verbatim so the call doesn't go deaf.

### 3.2 Operator — hidden, voiceless coordinator

A new agent whose sole role is to process inputs and appropriately prompt the
others. It is the one continuously-live participant.

- **Hidden service agent.** Excluded from the `agents` projection the daemon
  broadcasts (a `hidden: true` flag filtered in `pub()`): no desk, no character,
  no presence animation, does not consume one of the 12 desk slots, never
  announced on the call, never a target for addressing.
- **Voiceless.** Never produces TTS. You only ever hear real participants.
- **Privileged, role-gated.** It alone may inject prompts into other agents'
  sessions and reorder the speak-queue. The daemon accepts those privileged calls
  only when they carry the Operator's reserved identity/token, never from a normal
  agent.
- **Daemon-managed subprocess with auto-restart**, following the existing
  `observe-codex.mjs` precedent.

Why an agent and not daemon code: it solves the "agents are event-driven and
won't spontaneously contribute" problem (it's the live thing that wakes the
others), and the judgment-heavy work — parsing noisy speech, inferring intent,
choosing turn order — is exactly what you do *not* want as brittle code in the
zero-dependency daemon.

### 3.3 Browser — audio hub

- Plays queued utterances (per-agent voice), emits `tts-done` acks.
- Captures the mic, streams to the speech-to-text sidecar, forwards transcripts to
  the Operator over the bus.
- Renders **who a reply was routed to** (highlight the chosen agent) so a wrong
  guess is visible and voice-correctable.
- Hosts the **visual disambiguation fallback** (reuse the NEEDS-YOU overlay) for
  the rare genuinely-ambiguous case.

### 3.4 Voice sidecar — open-source models

A small local service the *browser* talks to (not the daemon, keeping the daemon
dependency-free):

- **Text-to-speech: Piper.** Fast, local, many distinct voice models →
  `agentId → voice` mapping is trivial and slots into existing `profiles.json`.
- **Speech-to-text: faster-whisper.** Because latency isn't critical, run a
  large-model / beam-search configuration for maximum accuracy — fewer addressing
  errors at the source, before the Operator has to correct anything.

---

## 4. Turn-taking — an attention market

The interaction is a **bidding loop**: agents bid for your attention, the Operator
grants the floor to one at a time, and each granted turn has a fixed shape — a
brief update on recent work followed by a question about what to do next. Every
turn therefore ends by handing a decision back to you. This makes the whole call a
sequence of self-contained decision requests rather than free-form chatter, which
also sidesteps the spontaneity problem (agents never need to converse with each
other to keep the call moving).

The enabling fact: TTS playback consumes real wall-clock seconds and there's one
human listening, so you *want* exactly one voice at a time regardless. The Operator
decides order; the daemon enforces serialization.

The cycle:

```
agents bid ──► Operator selects one ──► agent speaks: [update] + [question]
   ▲                                                          │
   │                                                          ▼
   └──── agent resumes work ◄── Operator routes answer ◄── you answer by voice
```

- **Bid.** An agent signals it wants the floor with a structured bid —
  `{agentId, urgency, blockedOn, summary, question}`. A bid is essentially "I have
  a decision point for you." An agent with nothing to ask doesn't bid (or bids
  low).
- **Selection.** The Operator picks the next speaker from outstanding bids, ranked
  by urgency, staleness (don't starve a long-waiting agent), and whether the agent
  is **blocking others**. One grant at a time.
- **The turn (fixed format).** The granted agent delivers a short spoken update on
  its recent work, then asks one clear question about what to do next. The
  speechifier (§5) and Operator polishing enforce this two-part shape and keep it
  brief.
- **Your answer.** You reply by voice; the Operator routes it back to that agent
  via prompt-injection (§6); the agent resumes work and may bid again later.
- **You are privileged**: mic activity ducks/pauses the current utterance
  (barge-in), and you can grab the floor or call on a specific agent out of band at
  any time. The human always wins.

This maps directly onto the existing **NEEDS-YOU inbox**: a bid is a structured
"agent is waiting on a human decision," and the turn's question is that decision
point.

---

## 5. Speech-appropriate updates

Two layers, belt-and-suspenders:

1. **Generation-side** — a skill instruction (same mechanism as the existing
   `the-office` skill) telling agents that call-channel posts must be short,
   spoken-style, no lists/paths/hashes.
2. **Deterministic speechifier sanitizer** in the daemon — the safety net, since
   the model can't be trusted to always comply. Transforms before TTS: code block
   → "shared a snippet", long number → rounded / "about X", file path → basename,
   URL → "a link"; strips markdown/emoji/special characters; caps utterance
   length.

Because latency is relaxed, the Operator can additionally **rewrite** each raw
update into clean spoken form (and re-prompt an agent to clarify a vague update
before it's queued), with the deterministic sanitizer remaining underneath as the
floor.

---

## 6. Parsing your responses (the hard part)

Speech-to-text output is noisy and unaddressed. Two questions: *who* are you
talking to, and *what* did you actually say. The leverage is context the daemon
already has.

- **Addressing.** In the bidding loop the default target is **whoever just took
  their turn and asked the question** — your answer is presumed to be a reply to
  the open question unless you say otherwise. That gives the Operator a very strong
  prior and makes most replies need no name at all. A spoken **name** overrides the
  default to redirect to a different agent: the Operator keeps a `name → agentId`
  map for the active call and matches your spoken token with **fuzzy + phonetic**
  matching (edit distance plus Metaphone/Soundex), so "quite otter" still lands on
  Quiet Otter. Remaining fallback: who is in the NEEDS-YOU inbox waiting on you.
- **Cleanup & routing in one pass.** The Operator (an LLM) takes raw transcript +
  recent call transcript + roster + open prompts and produces structured
  `{targetAgentId, intent, cleanedText, confidence}`. It's robust to garble
  *because* it has the context to disambiguate.
- **No spoken confirmation** (the Operator is voiceless). Disambiguation resolves
  two silent ways:
  - **Best-guess + voice-correctable** (happy path): route to the most likely
    target, inject the prompt, and the UI highlights which agent got it. If wrong,
    you say "no, the other one" and it re-routes.
  - **Visual fallback** for true ambiguity: surface a text prompt on screen
    (NEEDS-YOU overlay) rather than interrupting the audio.
- **Payoff:** a routed reply to a blocked agent drops straight into the existing
  `POST /api/prompts/<id>/reply` path. Voice mode becomes an audio skin over the
  inbox that already exists.

---

## 7. Agent names

Names already exist (`agent.name`, auto-generated adjective+animal, overridable in
`profiles.json`), so the addressing handle is there. The work is making names
survive being spoken and transcribed:

- **Short, single-word, phonetically spread** so a garbled token resolves to
  exactly one agent.
- **Not collidable** with command words ("yes", "stop", "next") or with each other
  ("Otter"/"Otto").
- **Pronounceable on sight.**
- Each agent **announces itself on join** ("Otter here, on infra") so you learn the
  active names by ear.
- Names shown on each desk in the UI so you can see who's who while you talk.

**Recommendation: a curated single-name set** assigned for the call's duration,
rather than the two-word generated names, with the Operator's fuzzy/phonetic
matching absorbing residual errors either way.

---

## 8. Phasing

Each phase is independently useful.

- **Phase 0 — output-only, no models.** `call` channel + speechifier + daemon
  speak-queue + browser reads utterances aloud with one voice. De-risks
  turn-taking before any audio model exists.
- **Phase 1 — distinct voices.** Piper sidecar, per-agent voice from profiles;
  curated call-names + join announcements.
- **Phase 2 — you talk back (the meat).** Mic + Whisper + barge-in/ducking +
  the Operator (hidden coordinator) doing parsing/addressing/routing, wired into
  NEEDS-YOU.
- **Phase 3 — agent-to-agent dialogue.** The expensive event-driven-agent
  problem; easier here because the Operator can prompt agents to respond to each
  other, not just to you. Decide later if it's worth it.

---

## 9. Risks & open questions

- **Event-driven agents.** Instances think only when prompted, so free-flowing
  spontaneous conversation is genuinely hard — lean on lifecycle-event-triggered
  utterances plus Operator-initiated wakes.
- **Operator is a single point of failure.** If it stalls the call goes deaf —
  hence the daemon's dumb verbatim fallback. (Relaxed latency removes the
  *bottleneck* concern but not the *failure* concern.)
- **Routing quality** is what makes or breaks the feel; the best-guess +
  voice-correct loop and high-accuracy STT are the mitigations.
- **Open:** final call-name set; whether the Operator should also accept silent
  voice *commands* ("mute Otter", "who's on the call?") in addition to routing.
