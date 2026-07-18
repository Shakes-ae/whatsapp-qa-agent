# WhatsApp Real-Time Q&A Agent

A low-latency agent that listens to a WhatsApp chat, routes incoming
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
- **Configurable routing** — watch any chat, deliver to any recipient
- **Domain-tuned prompting** — currently configured for football Q&A
  (tested on Premier League and World Cup question sets); the system
  prompt in `index.js` is easily swapped for any Q&A domain

## Architecture

```
WhatsApp chat ──> Baileys listener ──> question filter ──> Claude API
                                                                │
              recipient DM  <── notification relay <────────────┘
```

The listener stays read-only in the watched chat — answers are delivered
out-of-band to the configured recipient.

## Stack

- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web
  protocol client (Node.js, WebSocket-based — no browser)
- Anthropic Claude API (Haiku 4.5) — fast multimodal inference
- Node.js

## Setup

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
Health check: send `ping` to the agent's number from any chat — it
replies `pong`.

To run it 24/7 on a server instead of a laptop, see [DEPLOY.md](DEPLOY.md).

## Teaching it corrections

The agent learns from its mistakes. From the recipient's phone:

- **Fix a wrong answer**: reply to the agent's ⚽ answer DM with
  `correct: <right answer>`
- **Teach proactively**: DM the agent `learn: <question> = <answer>`

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
