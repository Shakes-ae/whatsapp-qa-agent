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
- **Event-driven** — messages arrive over the live WhatsApp Web session,
  no polling
- **Configurable routing** — watch any chat, deliver to any recipient
- **Domain-tuned prompting** — currently configured for football Q&A
  (tested on Premier League and World Cup question sets); the system
  prompt in `index.js` is easily swapped for any Q&A domain

## Architecture

```
WhatsApp chat ──> whatsapp-web.js listener ──> question filter ──> Claude API
                                                                        │
              recipient DM  <── notification relay <────────────────────┘
```

The listener stays read-only in the watched chat — answers are delivered
out-of-band to the configured recipient.

## Stack

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) —
  WhatsApp Web client (Node.js, headless Chromium under the hood)
- Anthropic Claude API (Haiku 4.5) — fast multimodal inference
- Node.js

## Setup

1. **Install Node.js** (v18+) from https://nodejs.org

2. **Install dependencies** (in this folder):
   ```
   npm install
   ```
   The first install downloads a bundled Chromium (~200 MB) — that's
   normal; whatsapp-web.js drives a hidden browser.

3. **Get an Anthropic API key** at https://console.anthropic.com/settings/keys

4. **Configure**: copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — your API key
   - `WATCH_GROUP_NAME` — name of the chat to watch (partial match is fine)
   - `OWNER_NUMBER` — the recipient's WhatsApp number, digits only with
     country code

5. **Run**:
   ```
   npm start
   ```
   A QR code appears in the terminal — scan it with the agent's phone
   (WhatsApp → Settings → Linked devices → Link a device). The session is
   saved in `./session`, so you only scan once.

The agent DMs the recipient a startup confirmation when it's watching.
Health check: send `ping` to the agent's number from any chat — it
replies `pong`.

To run it 24/7 on a server instead of a laptop, see [DEPLOY.md](DEPLOY.md).

## Notes and disclaimers

- This project uses an unofficial WhatsApp library and is not affiliated
  with or endorsed by WhatsApp/Meta. Automating a WhatsApp account is
  against WhatsApp's Terms of Service and may result in account bans —
  use a dedicated secondary number, never your primary account.
- Claude answers from trained knowledge with a cutoff date; very recent
  events may be answered incorrectly.
- Built for personal experimentation and learning. Be transparent with
  the people in any chat you point this at.
