# WhatsApp Real-Time Q&A Agent

A low-latency agent that listens to WhatsApp group chats, routes incoming
questions to Claude, and delivers answers to a designated recipient —
typically in 3 to 6 seconds end-to-end.

Built as an experiment in real-time agentic messaging: how fast can you
go from "message received" to "LLM-generated answer delivered on your
phone"?

## Features

- **Low latency** — hard 8-second API timeout with retries disabled; the
  agent fails fast rather than delivering a stale answer late
- **Multimodal** — handles text questions and image-based questions
  (photos are sent directly to Claude's vision capability, no separate
  OCR step)
- **Event-driven** — Baileys socket listener, no polling, no headless browser
- **Multiple chats** — watches any number of groups (comma-separated
  config), with per-group tagging on delivered answers
- **Remote control** — pause, resume, and query the agent from WhatsApp
  itself; no server access needed day-to-day
- **Self-improving** — learns corrections three ways: manual commands,
  and automatically from the chat's own answer reveals (see Learning)
- **Domain-tuned prompting** — currently configured for football Q&A;
  the system prompt in `prompt.js` is easily swapped for any Q&A domain

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │                 VPS (pm2)                   │
WhatsApp groups ──────> │  Baileys socket ──> filters ──> Claude API  │
                        │       │                │        (Haiku 4.5) │
                        │       │          corrections.json           │
                        │       │           (learning store)          │
                        └───────┼─────────────────────────────────────┘
                                v
                        recipient DM (answers, notifications, commands)
```

- **WhatsApp layer**: [Baileys](https://github.com/WhiskeySockets/Baileys)
  speaks the WhatsApp Web protocol over a WebSocket — no browser, ~100 MB
  RAM footprint, resilient to WhatsApp Web UI changes.
- **Group filtering**: groups are recognized lazily from incoming
  messages (name match against `WATCH_GROUP_NAMES`), so the agent works
  even when chat-list syncing is unavailable.
- **Identity handling**: WhatsApp increasingly addresses chats with
  privacy LIDs instead of phone numbers. The agent resolves the
  recipient's LID at startup and accepts commands from (and delivers to)
  either identity.
- **Answer path**: messages that pass the filters go to Claude with a
  domain-tuned system prompt plus any saved corrections; `SKIP` responses
  (chit-chat) are dropped, answers are DM'd to the recipient with the
  source group tagged.
- **Learning store**: `corrections.json` persists question→answer pairs.
  Exact repeats are answered from memory with zero API latency (tagged 📌);
  reworded repeats are handled by injecting corrections into the prompt.

## Stack

- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web
  protocol client (Node.js, WebSocket-based — no browser)
- Anthropic Claude API (Haiku 4.5) — fast multimodal inference
- Node.js, [pm2](https://pm2.keymetrics.io/) for process management in
  production

## Setup (local)

1. **Install Node.js** (v18+) from https://nodejs.org

2. **Install dependencies** (in this folder):
   ```
   npm install
   ```

3. **Get an Anthropic API key** at https://console.anthropic.com/settings/keys

4. **Configure**: copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — your API key
   - `WATCH_GROUP_NAMES` — chats to watch, comma-separated (partial match is fine)
   - `OWNER_NUMBER` — the recipient's WhatsApp number, digits only with
     country code

5. **Run**:
   ```
   npm start
   ```
   A QR code appears in the terminal — scan it with the agent's phone
   (WhatsApp → Settings → Linked devices → Link a device). The session is
   saved in `./baileys-session`, so you only scan once.

The agent DMs the recipient a startup confirmation when it's watching.

## Deployment (24/7)

The agent is designed to run unattended on a small Linux server so
answers arrive regardless of whether any personal machine is on:

- **Host**: any ~$5/month VPS (Hetzner, DigitalOcean, Lightsail) or a
  free-tier cloud VM. No browser means minimal RAM requirements.
- **Process management**: pm2 keeps the agent alive through crashes and
  reboots (`pm2 start index.js --name qa-agent`, `pm2 save`, `pm2 startup`).
- **Session**: the WhatsApp link (one QR scan, done over SSH) persists in
  `baileys-session/` on the server.
- **Updates**: `git pull && pm2 restart qa-agent` — the repo is the
  deployment artifact.

Step-by-step instructions: [DEPLOY.md](DEPLOY.md).

## Owner commands (DM the agent from the recipient number)

| Command | Effect |
|---|---|
| `stop` / `pause` | Pause answer DMs (the agent keeps watching and learning) |
| `start` / `resume` | Resume answering |
| `status` | Running/paused, watched groups, corrections count |
| `ping` | Health check — replies `pong` |
| `correct: <answer>` (as a reply to an answer DM) | Fix a wrong answer |
| `learn: <question> = <answer>` | Teach proactively |

## Learning

The agent learns from its mistakes three ways:

- **Manual corrections** — the `correct:` and `learn:` commands above.
- **Automatic, from the chat itself** — when a message containing ✅/✔️/☑️ or
  the word "correct" appears within 10 minutes of a question, the agent
  extracts the winning answer (from the message it replies to, or the tagged
  person's latest answer) and saves it. If that differs from what the agent
  answered, it notifies the recipient.

Corrections persist in `corrections.json`. When a saved question repeats
exactly, the agent answers instantly from memory (tagged 📌, no API call);
reworded repeats are handled by injecting corrections into Claude's prompt.

## Measuring accuracy

`eval.js` benchmarks the agent's prompt + model against questions with known
answers, using a second Claude call as the grader:

```
node eval.js                    # evaluate the default model (Haiku 4.5)
node eval.js claude-opus-4-8    # compare against a stronger model
```

Add your own question set as `questions.json` (same format as
`questions.example.json`) — real questions from the chat you watch make the
best benchmark. The script reports per-question pass/fail, overall accuracy,
and average latency.

## Notes and disclaimers

- This project uses an unofficial WhatsApp library and is not affiliated
  with or endorsed by WhatsApp/Meta. Automating a WhatsApp account is
  against WhatsApp's Terms of Service and may result in account bans —
  use a dedicated secondary number, never your primary account.
- Claude answers from trained knowledge with a cutoff date; very recent
  events may be answered incorrectly.
- Built for personal experimentation and learning. Be transparent with
  the people in any chat you point this at.
