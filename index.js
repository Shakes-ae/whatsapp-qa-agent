require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Anthropic = require("@anthropic-ai/sdk");

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
// timeout is per-request in milliseconds; maxRetries 0 stops the SDK's default
// retry-with-backoff (which could push a bad request past the 10s window).
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 0 });
const ownerChatId = `${OWNER_NUMBER.replace(/\D/g, "")}@c.us`;

const { SYSTEM_PROMPT } = require("./prompt");
const { addCorrection, findCorrection, correctionsPromptBlock, count } = require("./memory");

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

const watchedGroups = new Map(); // group chat id -> group name

client.on("qr", (qr) => {
  console.log("\nScan this QR code with the agent phone (WhatsApp > Linked devices > Link a device):\n");
  qrcode.generate(qr, { small: true });
});

// Right after a fresh link, WhatsApp may still be syncing chats to this
// device and getChats() can throw — retry with a delay before giving up.
async function getChatsWithRetry(retries = 6, delayMs = 5000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.getChats();
    } catch (err) {
      console.warn(`getChats failed (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

client.on("ready", async () => {
  console.log("Connected to WhatsApp.");
  const chats = await getChatsWithRetry();
  const groups = chats.filter((c) => c.isGroup);

  for (const group of groups) {
    if (watchTargets.some((t) => group.name.toLowerCase().includes(t))) {
      watchedGroups.set(group.id._serialized, group.name);
    }
  }

  const unmatched = watchTargets.filter(
    (t) => !groups.some((g) => g.name.toLowerCase().includes(t)),
  );
  for (const t of unmatched) {
    console.warn(`Warning: no group matching "${t}" found.`);
  }

  if (watchedGroups.size > 0) {
    const names = [...watchedGroups.values()];
    names.forEach((n) => console.log(`Watching group: "${n}"`));
    await client.sendMessage(
      ownerChatId,
      `🤖 Q&A agent online. Watching: ${names.map((n) => `"${n}"`).join(", ")}.`,
    );
  } else {
    console.error(`No groups matching "${WATCH_GROUP_NAMES}" found. Groups visible to this account:`);
    groups.forEach((c) => console.error(`  - ${c.name}`));
    console.error("Fix WATCH_GROUP_NAMES in .env and restart.");
  }
});

client.on("message", async (msg) => {
  // Health check: DM "ping" to the agent number from any chat
  if (msg.body.trim().toLowerCase() === "ping" && !msg.from.endsWith("@g.us")) {
    await msg.reply("pong 🏓");
    return;
  }

  // Owner commands (DMs from the recipient number only)
  if (msg.from === ownerChatId) {
    const body = msg.body.trim();

    // Reply to one of the bot's ⚽ answer DMs with: correct: <right answer>
    if (/^correct:/i.test(body)) {
      const answer = body.replace(/^correct:/i, "").trim();
      const quoted = msg.hasQuotedMsg ? await msg.getQuotedMessage() : null;
      const match = quoted && quoted.body.match(/\*Q:\* (.+)/);
      if (match && answer) {
        addCorrection(match[1].trim(), answer);
        await msg.reply(`📌 Noted. I'll answer "${answer}" next time. (${count()} corrections saved)`);
      } else {
        await msg.reply('To correct me, reply to one of my ⚽ answer messages with:\ncorrect: <right answer>');
      }
      return;
    }

    // Teach proactively: learn: <question> = <answer>
    if (/^learn:/i.test(body)) {
      const rest = body.replace(/^learn:/i, "").trim();
      const eq = rest.indexOf("=");
      if (eq > 0) {
        addCorrection(rest.slice(0, eq).trim(), rest.slice(eq + 1).trim());
        await msg.reply(`📌 Learned. (${count()} corrections saved)`);
      } else {
        await msg.reply("Format: learn: <question> = <answer>");
      }
      return;
    }
  }

  const groupName = watchedGroups.get(msg.from);
  if (!groupName) return;

  const text = msg.body.trim();
  const hasMedia = msg.hasMedia;
  if (!text && !hasMedia) return;
  if (text.length < 8 && !hasMedia) return; // skip "lol", "nice", emoji reactions

  const started = Date.now();
  console.log(`[group] ${text.slice(0, 80) || "(image)"}`);

  // Repeated question with a saved correction: answer instantly from memory
  const known = text ? findCorrection(text) : null;
  if (known) {
    await client.sendMessage(
      ownerChatId,
      `⚽ _${groupName}_\n*Q:* ${text.slice(0, 120)}\n\n✅ *A:* ${known.answer} 📌`,
    );
    console.log(`  -> answered from corrections (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return;
  }

  try {
    const content = [];

    if (hasMedia) {
      const media = await msg.downloadMedia();
      if (media && media.mimetype.startsWith("image/")) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: media.mimetype, data: media.data },
        });
      }
    }
    content.push({ type: "text", text: text || "Answer this picture-based question." });

    // Haiku 4.5: fastest model, ideal for short factual recall.
    // (It doesn't support the output_config.effort parameter.)
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
    await client.sendMessage(
      ownerChatId,
      `⚽ _${groupName}_\n*Q:* ${text.slice(0, 120) || "(image question)"}\n\n✅ *A:* ${answer}${lateTag}`,
    );
    console.log(`  -> answered in ${elapsed}s: ${answer.slice(0, 80)}`);
  } catch (err) {
    console.error("  -> error:", err.message);
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      await client.sendMessage(ownerChatId, "⚠️ Claude took too long on that one — answer skipped.");
    } else if (err instanceof Anthropic.RateLimitError) {
      await client.sendMessage(ownerChatId, "⚠️ Rate limited by the Claude API — answer skipped.");
    } else if (err instanceof Anthropic.AuthenticationError) {
      await client.sendMessage(ownerChatId, "⚠️ Invalid ANTHROPIC_API_KEY — check your .env.");
    }
  }
});

client.on("disconnected", (reason) => {
  console.error("WhatsApp disconnected:", reason);
  process.exit(1);
});

// Exit cleanly on unexpected async errors so the process manager restarts us
process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", (err && err.message) || err);
  process.exit(1);
});

console.log("Starting WhatsApp Q&A agent...");
client.initialize();
