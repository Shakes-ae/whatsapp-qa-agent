// Correction memory: question -> corrected answer pairs, persisted to
// corrections.json. Lets the agent learn from mistakes when questions repeat.
const fs = require("fs");

const FILE = "corrections.json";
let corrections = [];
try {
  corrections = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  corrections = [];
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addCorrection(question, answer) {
  const norm = normalize(question);
  corrections = corrections.filter((c) => normalize(c.question) !== norm);
  corrections.push({ question, answer, correctedAt: new Date().toISOString() });
  fs.writeFileSync(FILE, JSON.stringify(corrections, null, 2));
}

// Exact match (after normalization) — used for the instant-answer path
function findCorrection(question) {
  const norm = normalize(question);
  return corrections.find((c) => normalize(c.question) === norm);
}

// Injected into the system prompt so Claude applies corrections to reworded repeats
function correctionsPromptBlock() {
  if (corrections.length === 0) return "";
  const recent = corrections.slice(-50);
  return (
    "\n\nThe user has corrected some of your past answers. If a question matches one of " +
    "these (even reworded), use the corrected answer:\n" +
    recent.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n")
  );
}

function count() {
  return corrections.length;
}

module.exports = { addCorrection, findCorrection, correctionsPromptBlock, count };
