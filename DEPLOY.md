# Deploying the Q&A agent to a server (24/7)

These steps assume a fresh **Ubuntu 22.04 or 24.04** VPS with at least **1 GB RAM**
(Chromium needs it). Any provider works — Hetzner, DigitalOcean, AWS Lightsail,
Oracle Cloud free tier.

## 1. Install Node.js on the server

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Install Chromium's system libraries

whatsapp-web.js downloads its own Chromium, but it needs these shared libraries:

```bash
sudo apt-get install -y ca-certificates fonts-liberation libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxkbcommon0 libxrandr2 xdg-utils
```

> On Ubuntu 24.04, if `libasound2` errors, use `libasound2t64` instead.

## 3. Copy the project to the server

Clone it from GitHub:

```bash
git clone https://github.com/Shakes-ae/whatsapp-qa-agent.git /opt/qa-agent
```

(Or copy the folder directly with `scp`. Never commit `.env` or `session/` —
the `.gitignore` already excludes them.)

## 4. Configure and install on the server

```bash
cd /opt/qa-agent
cp .env.example .env
nano .env          # fill in API key, group name, recipient number
npm install
```

## 5. First run — scan the QR over SSH

```bash
node index.js
```

The QR code renders as text in your SSH terminal. Scan it with the **agent phone**
(WhatsApp → Linked devices). When you see "Connected to WhatsApp." and get the
"Q&A agent online" DM, press Ctrl+C. The session is now saved in `./session`.

## 6. Keep it running forever with pm2

```bash
sudo npm install -g pm2
pm2 start index.js --name qa-agent
pm2 save
pm2 startup        # prints one command — run it to auto-start after reboots
```

Useful pm2 commands:

```bash
pm2 logs qa-agent     # live logs (see questions/answers as they happen)
pm2 restart qa-agent
pm2 status
```

## Notes

- **RAM**: if the server has exactly 1 GB, add swap so Chromium doesn't get killed:
  ```bash
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  ```
- **Re-linking**: if WhatsApp ever unlinks the session (e.g. after a long offline
  period on the agent phone), `pm2 logs qa-agent` will show a fresh QR code —
  just scan it again.
- The agent phone doesn't need to stay online, but open WhatsApp on it at least
  once every ~2 weeks so the linked device isn't expired.
