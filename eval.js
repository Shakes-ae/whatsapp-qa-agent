// Accuracy benchmark: runs a set of questions with known answers through the
// same prompt the live agent uses, then has Claude grade each response.
//
//   node eval.js                     -> evaluates the default model (claude-haiku-4-5)
//   node eval.js claude-opus-4-8     -> evaluates another model for comparison
//
// Questions come from questions.json if present, else questions.example.json.
// Format: [{ "question": "...", "answer": "expected answer" }, ...]
require("dotenv").config();
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT } = require("./prompt");

const MODEL = process.argv[2] || "claude-haiku-4-5";
const JUDGE_MODEL = "claude-haiku-4-5";

const file = fs.existsSync("questions.json") ? "questions.json" : "questions.example.json";
const questions = JSON.parse(fs.readFileSync(file, "utf8"));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JUDGE_PROMPT = `You grade quiz answers. You get a question, the expected answer, and a \
given answer. Reply with exactly CORRECT if the given answer matches the expected answer in \
substance (same person, team, number, or fact — wording, spelling variants, and extra context \
don't matter). Otherwise reply with exactly INCORRECT.`;

async function ask(model, system, userText, maxTokens) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function main() {
  console.log(`Evaluating ${MODEL} on ${questions.length} questions from ${file}\n`);
  let correct = 0;
  let totalSeconds = 0;

  for (const [i, q] of questions.entries()) {
    const started = Date.now();
    const answer = await ask(MODEL, SYSTEM_PROMPT, q.question, 1024);
    const seconds = (Date.now() - started) / 1000;
    totalSeconds += seconds;

    const verdict = await ask(
      JUDGE_MODEL,
      JUDGE_PROMPT,
      `Question: ${q.question}\nExpected answer: ${q.answer}\nGiven answer: ${answer}`,
      10,
    );

    const pass = verdict === "CORRECT";
    if (pass) correct++;
    console.log(`${pass ? "✅" : "❌"} [${i + 1}/${questions.length}] (${seconds.toFixed(1)}s) ${q.question}`);
    if (!pass) console.log(`     expected: ${q.answer}\n     got:      ${answer}`);
  }

  const pct = ((correct / questions.length) * 100).toFixed(0);
  console.log(`\nScore: ${correct}/${questions.length} (${pct}%)  |  avg latency: ${(totalSeconds / questions.length).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
