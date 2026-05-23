# Conference Call — Design Doc

A voice extension for The Office: each agent gets a distinct synthesized voice,
the human talks back by voice, and a hidden coordinator decides who speaks when
and who your replies are addressed to.

Status: **Phases 0–2 built — feature complete for the intended scope.** Phase 0
(speak-queue + speechifier), Phase 1 (Piper voice sidecar, per-agent voices,
announcer voice), and Phase 2 (the Operator coordinator + bidding + routing +
clarification re-bids, plus browser mic capture and a Whisper STT sidecar with
barge-in) are implemented. The Operator brain runs on OpenRouter with a
deterministic no-key fallback. Note: the audio paths (Piper, Whisper, in-browser
mic/playback) are built with graceful Web Speech fallbacks but were not exercised
end to end in CI — they need a real browser plus the model binaries to verify live.

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

**Scope.** This is strictly **operator-orchestrated agent → human → agent**
next-task assignment: agents report and ask, you decide by voice, the Operator
routes your decision back. Agent-to-agent audio dialogue is **out of scope** — the
only voices on the call are the participating agents (one at a time) and the
Operator's announcer; agents never talk to each other over audio.

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
- **The Operator (new) is the brain.** A hidden coordinator agent that parses your
  speech, decides who you addressed, prompts the other agents — and speaks in its
  own **announcer voice** to introduce whoever is about to take the floor.

```
agents (text only) ──WS──► daemon (floor mgr) ──WS──► browser (TTS out / STT in) ──► you
        ▲                        ▲                          │
        │                        │                          │
   prompt-injection         Operator (hidden coordinator ◄──┘
   (tmux relay)             with an announcer voice)
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

### 3.2 Operator — hidden coordinator with an announcer voice

A new agent whose sole role is to process inputs and appropriately prompt the
others. It is the one continuously-live participant.

- **Hidden service agent.** Excluded from the `agents` projection the daemon
  broadcasts (a `hidden: true` flag filtered in `pub()`): no desk, no character,
  no presence animation, does not consume one of the 12 desk slots, never a
  participant and never itself a target for addressing.
- **Has an announcer voice.** A distinct MC voice, used to introduce the next
  speaker before they talk ("Blue Otter") — an audible turn cue that tells you who
  is about to speak and therefore who your next reply will go to. It does not hold
  participant-style conversations; it announces, and may optionally voice
  disambiguation (§6). All other agents still speak in their own voices.
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
agents bid ──► Operator selects + announces ──► agent speaks: [update] + [question]
   ▲              ("Blue Otter")                                │
   │                                                            ▼
   └──── agent resumes work ◄── Operator routes answer ◄── you answer by voice
```

Worked example:

```
Operator:   "Blue Otter."
Blue Otter: "I completed building the four-dimensional keyboard interface.
             Which component next?"
You:        "The Frobenius-normed meta equalizer."
Operator:   (resolves the spoken phrase against Blue Otter's open components,
             then injects as text) → "Build the Frobenius-normed meta equalizer next."
```

- **Bid.** An agent signals it wants the floor with a structured bid —
  `{agentId, urgency, blockedOn, summary, question}`. A bid is essentially "I have
  a decision point for you." An agent with nothing to ask doesn't bid (or bids
  low).
- **Selection.** The Operator picks the next speaker from outstanding bids, ranked
  by urgency, staleness (don't starve a long-waiting agent), and whether the agent
  is **blocking others**. One grant at a time.
- **Announce.** The Operator speaks the chosen agent's name in its announcer voice
  ("Blue Otter") as the turn-handoff cue, then releases that agent's utterance to
  the speak-queue.
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

### Question forms

Most turns fit one of three canonical shapes. Standardizing them matters because
the question *type* is itself the strongest prior for parsing your answer (§6/§7B)
— it tells the Operator what the answer space looks like before you even speak.

1. **Proceed / pause** — *"I've done X. Y is up next. Pause or proceed?"* Answer
   space is a tiny fixed vocabulary (go / hold / stop). Easiest to parse; "yep",
   "go ahead", "hang on" all resolve cleanly.
2. **Multiple choice** — *"I've done X. Which next? One, W. Two, Y. Three, Z."*
   Answer space is the enumerated options. The Operator matches your reply against
   them by **ordinal or content** ("the second one" / "do Y" / "number three"),
   which makes garbled speech easy to recover — it only has to land on one of a
   known short list.
3. **Open / diagnostic** — *"I tried X and saw result Y. What next?"* Open answer
   space — the hardest case, where full speech-recovery (§7B) and the rephrase
   floor earn their keep.

Note this is the one place short enumerations *are* spoken aloud (contra §5's
"no lists"): a 2–4 option choice is the actual decision, so the Operator renders it
as a clean spoken enumeration rather than stripping it. The agent emits the choice
structurally (`{update, question, options:[…]}`); the Operator speaks it and uses
the same options list to bound answer parsing.

---

## 5. Speech-appropriate updates

Two layers, belt-and-suspenders:

1. **Generation-side** — a skill instruction (same mechanism as the existing
   `the-office` skill) telling agents that call-channel posts must be short,
   spoken-style, no lists/paths/hashes. Reinforced per-turn by the Operator's
   standing meta note appended to every injected prompt — *"(User is on the vocal
   interface. Please be succinct.)"* (§6) — so the reminder rides along with the
   actual instruction instead of relying on the agent remembering a one-time rule.
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
- **Disambiguation.** Because the Operator has a voice, it resolves uncertainty in
  escalating ways, by how unclear the input is:
  - **Best-guess + voice-correctable** (happy path): route to the most likely
    target, inject the prompt, and the UI highlights which agent got it. If wrong,
    you say "no, the other one" and it re-routes.
  - **Spoken confirmation** for genuine ambiguity: the announcer voice asks a quick
    "Otter on infra, or Otto on web?" rather than guessing.
  - **Request rephrase** when the transcript is too garbled to make sense of at all
    — i.e. even the best candidate interpretation falls below a hard confidence
    floor. The Operator does *not* guess or inject anything; it asks you to say it
    again ("Sorry, I didn't catch that — could you rephrase?"). This is the last
    resort that keeps a bad transcription from turning into a wrong instruction.
  - **Visual fallback**: surface a text prompt on screen (NEEDS-YOU overlay) when
    you'd rather not interrupt the audio.
- **What the agent receives is processed text, never raw speech.** The pipeline is
  `your voice → STT → Operator (clean + interpret + resolve references) → text
  injected into the target agent's session`. The agent only ever sees the
  Operator's polished prompt — a clear instruction in plain text — not the audio
  and not the garbled transcript. The Operator absorbs STT errors, expands terse
  spoken answers ("yeah do the first one" → "Proceed with option A: the in-place
  migration"), and attaches any context the agent needs to act.
- **Standing meta note on every injection.** The Operator auto-appends a short
  standing instruction to the text it injects — *"(User is on the vocal interface.
  Please be succinct.)"* — so agents keep their next bid/reply short and
  speech-shaped at the source. This shapes generation up front and complements the
  brevity-edit template (§7A) that cleans up whatever still comes back too long.
- **Payoff:** that processed text drops straight into the existing
  `POST /api/prompts/<id>/reply` path (which already relays into the agent's
  session via tmux). Voice mode becomes an audio skin over the inbox that already
  exists.

### Two kinds of "unclear", two different handlers

There are two distinct failure modes, and they're handled at different layers:

1. **The Operator can't parse your speech** (STT too garbled). Handled *before*
   anything reaches an agent: the Operator requests a rephrase (the confidence-floor
   path above). Nothing is injected.
2. **Your answer parsed fine, but the agent still can't act on the resulting
   instruction** (it's ambiguous or insufficient *in the agent's own context* — the
   Operator has no way to know the cache has three variants, say). The agent is the
   only party that can detect this, so the agent **re-bids for a second human
   round** rather than guessing.

The clarification re-bid loop (case 2):

```
agent gets routed instruction ──► can't act on it ──► re-bids {kind:"clarification",
   ▲                                                   question:"You said use the
   │                                                   cache — which one?"}
   └── routed answer ◄── you answer ◄── Operator grants it NEXT (jumps the queue)
```

- A clarification bid (`office-call.mjs bid --clarify "…"`,
  `POST /api/call/bid {kind:"clarification"}`) **outranks fresh turns** in
  arbitration (§7D), so a half-finished exchange closes before new agents start —
  no agent is left blocked on an instruction it can't use.
- The loop is re-entrant: a clarified answer that's *still* too unclear just
  produces another clarification bid. Each round is a normal turn, so it composes
  with everything else (announce, speech-shaping, routing).
- **Agent-side contract:** an agent that receives a routed instruction it cannot
  confidently act on must re-bid with `--clarify` and a specific question, rather
  than guess. This belongs in the agents' call skill alongside the succinctness
  rule.

---

## 7. Operator prompt templates

The Operator's quality lives almost entirely in its prompts — this is the part to
invest in. It runs several small, **single-purpose** templates rather than one
mega-prompt: each is easier to tune, emits structured output, and shares a stable
system preamble (cacheable) plus variable context (roster, the open question, the
target agent's vocabulary, recent transcript).

### A. Brevity edit — agent request → speech (inbound polish)

Takes an agent's raw bid/update plus its task context and rewrites it into the
fixed turn shape: a short spoken update plus exactly **one** clear question. Drops
lists, paths, hashes, and jargon dumps; preserves the actual decision the human
must make. Output: `{update, question}`. This is the Operator-side polish referenced
in §5, sitting above the deterministic speechifier floor.

### B. Speech recovery — your STT → agent instruction (the hard one)

This is the **logical extrapolation of plausible misparsings**. The template treats
the raw transcript as noisy and reasons *explicitly* about how speech-to-text could
have mangled what you actually said, then picks the most plausible intended meaning
given context. Inputs deliberately include the corrective context:

- the **open question** you're answering — including its **type and answer space**
  (proceed/pause vocabulary, or the enumerated options list), per §4's question
  forms; this is the strongest single constraint on what you could have meant,
- the **target agent's domain vocabulary** (e.g. its open component names),
- the **roster** (for redirect names),
- recent call transcript.

The prompt instructs the model to enumerate candidate interpretations —
**phonetic neighbors, homophones, mangled technical terms, dropped or inserted
words** — score them against context, and emit
`{instruction, targetAgentId, confidence, alternatives}`. Worked case: raw STT
`"frobenius norm metta equaliser"` + the agent's open component
`"Frobenius-normed meta equalizer"` → high-confidence match. Context is the
corrector; STT never has to be perfect.

When even the best candidate scores below a **hard confidence floor**, the template
returns a `rephrase` outcome instead of an instruction — the Operator asks you to
say it again rather than injecting a guess (§6). Better a re-ask than a wrong
instruction shipped to an agent.

### C. Addressing / redirect detection

Decides whether you named a different agent (overriding the default "reply to whoever
just asked"), fuzzy/phonetic-matching the spoken token against the roster (§6).

### D. Bid arbitration

Chooses the next speaker — see §4. Order: **clarification re-bids first** (close a
half-finished exchange before starting new ones), then urgency, then longest-
waiting. This tier is deterministic and runs regardless of brain.

### E. Disambiguation phrasing

When confidence from B/C is low, generates the short spoken clarifying question for
the announcer voice ("Otter on infra, or Otto on web?") or the rephrase request
("Sorry, I didn't catch that — could you rephrase?").

### Design notes

- **Confidence is first-class, in bands.** Every interpretation carries a confidence
  that gates the response: **high** → act (best-guess inject), **medium** →
  spoken-confirm or visual fallback, **below the hard floor** → request rephrase and
  inject nothing (§6). No silent misroutes, and no guessing on garbage.
- **Single-purpose beats monolith.** Separate templates are independently tunable and
  testable; misparse-recovery quality can be regression-tested against a fixture set
  of `(raw STT, context) → expected instruction` pairs.
- **Stable preamble + variable context** makes the templates cache-friendly, which
  matters for cost/consistency even though latency is relaxed.

---

## 8. Agent names

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

## 9. Phasing

Each phase is independently useful.

- **Phase 0 — output-only, no models. [built]** speak-queue + speechifier + daemon
  one-voice-at-a-time + browser reads utterances aloud. De-risks turn-taking before
  any audio model exists. (`call-speechifier.mjs`, `call-store.mjs`, daemon
  `/api/call/{speak,ack,state}`, `office-call.mjs`.)
- **Phase 1 — distinct voices. [built]** Piper voice sidecar (`voice-sidecar.mjs`),
  deterministic per-agent voice (`call-voices.mjs`), and the Operator's announcer
  voice introducing each turn ("Blue Otter"). Falls back to Web Speech when the
  sidecar/model is absent. (Announcing is just TTS of a name — no parsing — so it
  lands here, before the mic exists.) Curated call-names still TODO.
- **Phase 2 — you talk back (the meat).** _2a [built]_: the Operator
  (`operator.mjs`, hidden daemon-managed subprocess) — agents bid
  (`/api/call/bid`), it arbitrates, brevity-edits each turn, and routes the
  human's transcript into agent sessions (`/api/call/route`, with the standing
  succinctness note). Brain is OpenRouter (`OPENROUTER_API_KEY`,
  `OFFICE_OPERATOR_MODEL`) with a deterministic no-key fallback; enabled via
  `OFFICE_OPERATOR=1`. _2b [built]_: browser push-to-talk mic capture + Whisper STT
  sidecar (`stt-sidecar.mjs`, `npm run stt`) + barge-in (mic ducks the current
  utterance), feeding `/api/call/transcript`. Falls back to the Web Speech
  recognition API when the sidecar is down. Includes the **clarification re-bid**
  loop (§6): an agent that can't act on a routed instruction re-bids
  (`--clarify`), and that bid jumps the queue.

**Out of scope: agent-to-agent audio dialogue.** Earlier drafts floated a "Phase 3"
where agents converse over audio. That is explicitly not part of this feature (see
Scope, §1). The call is operator-orchestrated agent → human → agent task
assignment only.

---

## 10. Risks & open questions

- **Event-driven agents.** Instances think only when prompted, so free-flowing
  spontaneous conversation is genuinely hard — lean on lifecycle-event-triggered
  utterances plus Operator-initiated wakes.
- **Operator is a single point of failure.** If it stalls the call goes deaf —
  hence the daemon's dumb verbatim fallback. (Relaxed latency removes the
  *bottleneck* concern but not the *failure* concern.)
- **Routing quality** is what makes or breaks the feel; the best-guess +
  voice-correct loop and high-accuracy STT are the mitigations.
- **Operator prompt templates are the primary quality lever** (§7). Brevity edits
  and misparse-recovery are where the experience is won or lost — budget real tuning
  time and build a fixture set of `(raw STT, context) → expected instruction` pairs
  to regression-test recovery as templates change.
- **Open:** final call-name set; whether the Operator should also accept silent
  voice *commands* ("mute Otter", "who's on the call?") in addition to routing.
