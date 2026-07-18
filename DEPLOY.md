# Deploying the Q&A agent to a server (24/7)

These steps assume a fresh **Ubuntu 22.04+** VPS. Any small instance works —
the agent is lightweight (no browser). Hetzner, DigitalOcean, AWS Lightsail,
and Oracle Cloud free tier are all fine.

## 1. Install Node.js on the server

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Copy the project to the server

Clone it from GitHub:

```bash
git clone https://github.com/Shakes-ae/whatsapp-qa-agent.git /opt/qa-agent
```

(Or copy the folder directly with `scp`. Never commit `.env` or `session/` —
the `.gitignore` already excludes them.)

## 3. Configure and install on the server

```bash
cd /opt/qa-agent
cp .env.example .env
nano .env          # fill in API key, group name, recipient number
npm install
```

## 4. First run — scan the QR over SSH

```bash
node index.js
```

The QR code renders as text in your SSH terminal. Scan it with the **agent phone**
(WhatsApp → Linked devices). When you see "Connected to WhatsApp." and get the
"Q&A agent online" DM, press Ctrl+C. The session is now saved in
`./baileys-session`.

## 5. Keep it running forever with pm2

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

- **Re-linking**: if WhatsApp ever unlinks the session (e.g. after a long offline
  period on the agent phone), `pm2 logs qa-agent` will show a fresh QR code —
  just scan it again.
- The agent phone doesn't need to stay online, but open WhatsApp on it at least
  once every ~2 weeks so the linked device isn't expired.
