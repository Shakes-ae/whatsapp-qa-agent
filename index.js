require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Anthropic = require("@anthropic-ai/sdk");

const { ANTHROPIC_API_KEY, WATCH_GROUP_NAME, OWNER_NUMBER } = process.env;

for (const [name, value] of Object.entries({ ANTHROPIC_API_KEY, WATCH_GROUP_NAME, OWNER_NUMBER })) {
  if (!value) {
    console.error(`Missing ${name} in .env — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// Hard latency budget: fail fast instead of delivering a useless late answer.
// timeout is per-request in milliseconds; maxRetries 0 stops the SDK's default
// retry-with-backoff (which could push a bad request past the 10s window).
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 0 });
const ownerChatId = `${OWNER_NUMBER.replace(/\D/g, "")}@c.us`;

const { SYSTEM_PROMPT } = require("./prompt");

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

let watchedGroupId = null;

client.on("qr", (qr) => {
  console.log("\nScan this QR code with the agent phone (WhatsApp > Linked devices > Link a device):\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("Connected to WhatsApp.");
  const chats = await client.getChats();
  const target = WATCH_GROUP_NAME.toLowerCase();
  const group = chats.find((c) => c.isGroup && c.name.toLowerCase().includes(target));

  if (group) {
    watchedGroupId = group.id._serialized;
    console.log(`Watching group: "${group.name}"`);
    await client.sendMessage(ownerChatId, `🤖 Q&A agent online. Watching "${group.name}".`);
  } else {
    console.error(`No group matching "${WATCH_GROUP_NAME}" found. Groups visible to this account:`);
    chats.filter((c) => c.isGroup).forEach((c) => console.error(`  - ${c.name}`));
    console.error("Fix WATCH_GROUP_NAME in .env and restart.");
  }
});

client.on("message", async (msg) => {
  // Health check: DM "ping" to the agent number from any chat
  if (msg.body.trim().toLowerCase() === "ping" && !msg.from.endsWith("@g.us")) {
    await msg.reply("pong 🏓");
    return;
  }

  if (!watchedGroupId || msg.from !== watchedGroupId) return;

  const text = msg.body.trim();
  const hasMedia = msg.hasMedia;
  if (!text && !hasMedia) return;
  if (text.length < 8 && !hasMedia) return; // skip "lol", "nice", emoji reactions

  const started = Date.now();
  console.log(`[group] ${text.slice(0, 80) || "(image)"}`);

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
      system: SYSTEM_PROMPT,
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
      `⚽ *Q:* ${text.slice(0, 120) || "(image question)"}\n\n✅ *A:* ${answer}${lateTag}`,
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

console.log("Starting WhatsApp Q&A agent...");
client.initialize();
