require("dotenv").config();
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./prompt");
const { addCorrection, findCorrection, correctionsPromptBlock, count } = require("./memory");

const { ANTHROPIC_API_KEY, OWNER_NUMBER } = process.env;
// Comma-separated list of group names to watch (WATCH_GROUP_NAME also accepted)
const WATCH_GROUP_NAMES = process.env.WATCH_GROUP_NAMES || process.env.WATCH_GROUP_NAME;

for (const [name, value] of Object.entries({ ANTHROPIC_API_KEY, WATCH_GROUP_NAMES, OWNER_NUMBER })) {
  if (!value) {
    console.error(`Missing ${name} in .env — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const watchTargets = WATCH_GROUP_NAMES.split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Hard latency budget: fail fast instead of delivering a useless late answer.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 0 });
const ownerJid = `${OWNER_NUMBER.replace(/\D/g, "")}@s.whatsapp.net`;

const logger = pino({ level: "silent" });
const groupNames = new Map(); // group jid -> subject (confirmed matches)
const ignoredGroups = new Set(); // group jids checked and not matched

function extractText(m) {
  const msg = m.message;
  return (msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || "").trim();
}

async function handleOwnerCommand(sock, m, text) {
  if (text.toLowerCase() === "ping") {
    await sock.sendMessage(ownerJid, { text: "pong 🏓" });
    return;
  }

  // Reply to one of the bot's ⚽ answer DMs with: correct: <right answer>
  if (/^correct:/i.test(text)) {
    const answer = text.replace(/^correct:/i, "").trim();
    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || "";
    const match = quotedText.match(/\*Q:\* (.+)/);
    if (match && answer) {
      addCorrection(match[1].trim(), answer);
      await sock.sendMessage(ownerJid, {
        text: `📌 Noted. I'll answer "${answer}" next time. (${count()} corrections saved)`,
      });
    } else {
      await sock.sendMessage(ownerJid, {
        text: "To correct me, reply to one of my ⚽ answer messages with:\ncorrect: <right answer>",
      });
    }
    return;
  }

  // Teach proactively: learn: <question> = <answer>
  if (/^learn:/i.test(text)) {
    const rest = text.replace(/^learn:/i, "").trim();
    const eq = rest.indexOf("=");
    if (eq > 0) {
      addCorrection(rest.slice(0, eq).trim(), rest.slice(eq + 1).trim());
      await sock.sendMessage(ownerJid, { text: `📌 Learned. (${count()} corrections saved)` });
    } else {
      await sock.sendMessage(ownerJid, { text: "Format: learn: <question> = <answer>" });
    }
  }
}

async function handleGroupMessage(sock, m, jid) {
  // Resolve and filter the group by name, caching the result
  let groupName = groupNames.get(jid);
  if (!groupName) {
    if (ignoredGroups.has(jid)) return;
    const meta = await sock.groupMetadata(jid);
    if (meta.subject && watchTargets.some((t) => meta.subject.toLowerCase().includes(t))) {
      groupNames.set(jid, meta.subject);
      groupName = meta.subject;
      console.log(`Watching group: "${meta.subject}"`);
    } else {
      ignoredGroups.add(jid);
      return;
    }
  }

  const text = extractText(m);
  const hasImage = !!m.message.imageMessage;
  if (!text && !hasImage) return;
  if (text.length < 8 && !hasImage) return; // skip "lol", "nice", emoji reactions

  const started = Date.now();
  console.log(`[${groupName}] ${text.slice(0, 80) || "(image)"}`);

  // Repeated question with a saved correction: answer instantly from memory
  const known = text ? findCorrection(text) : null;
  if (known) {
    await sock.sendMessage(ownerJid, {
      text: `⚽ _${groupName}_\n*Q:* ${text.slice(0, 120)}\n\n✅ *A:* ${known.answer} 📌`,
    });
    console.log(`  -> answered from corrections (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return;
  }

  try {
    const content = [];

    if (hasImage) {
      const buffer = await downloadMediaMessage(m, "buffer", {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: m.message.imageMessage.mimetype || "image/jpeg",
          data: buffer.toString("base64"),
        },
      });
    }
    content.push({ type: "text", text: text || "Answer this picture-based question." });

    // Haiku 4.5: fastest model, ideal for short factual recall.
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT + correctionsPromptBlock(),
      messages: [{ role: "user", content }],
    });

    const answer = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!answer || answer === "SKIP") {
      console.log(`  -> skipped (${elapsed}s)`);
      return;
    }

    const lateTag = Date.now() - started > 10_000 ? " ⏰ _(late)_" : "";
    await sock.sendMessage(ownerJid, {
      text: `⚽ _${groupName}_\n*Q:* ${text.slice(0, 120) || "(image question)"}\n\n✅ *A:* ${answer}${lateTag}`,
    });
    console.log(`  -> answered in ${elapsed}s: ${answer.slice(0, 80)}`);
  } catch (err) {
    console.error("  -> error:", err.message);
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      await sock.sendMessage(ownerJid, { text: "⚠️ Claude took too long on that one — answer skipped." });
    } else if (err instanceof Anthropic.RateLimitError) {
      await sock.sendMessage(ownerJid, { text: "⚠️ Rate limited by the Claude API — answer skipped." });
    } else if (err instanceof Anthropic.AuthenticationError) {
      await sock.sendMessage(ownerJid, { text: "⚠️ Invalid ANTHROPIC_API_KEY — check your .env." });
    }
  }
}

async function handleMessage(sock, m) {
  if (!m.message || m.key.fromMe) return;
  const jid = m.key.remoteJid;
  if (!jid) return;

  // Skip stale messages delivered after downtime — old answers are useless
  const ts = Number(m.messageTimestamp) * 1000;
  if (ts && Date.now() - ts > 2 * 60_000) return;

  if (jid === ownerJid) {
    await handleOwnerCommand(sock, m, extractText(m));
    return;
  }

  if (jid.endsWith("@g.us")) {
    await handleGroupMessage(sock, m, jid);
    return;
  }

  // Health check from any other DM
  if (extractText(m).toLowerCase() === "ping") {
    await sock.sendMessage(jid, { text: "pong 🏓" });
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys-session");
  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false, // keep notifications on the agent phone
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan this QR code with the agent phone (WhatsApp > Linked devices > Link a device):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Connected to WhatsApp.");
      sock
        .sendMessage(ownerJid, {
          text: `🤖 Q&A agent online. Watching for questions in groups matching: ${watchTargets.join(", ")}.`,
        })
        .catch((err) => console.warn("Could not send online DM:", err.message));
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("Logged out by WhatsApp. Delete the baileys-session folder and restart to re-link.");
        process.exit(1);
      }
      console.warn("Connection closed — reconnecting...");
      start();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handleMessage(sock, m);
      } catch (err) {
        console.error("message handling error:", err.message);
      }
    }
  });
}

console.log("Starting WhatsApp Q&A agent...");
start();
