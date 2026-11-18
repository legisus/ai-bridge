// Intent gate: does this task look like it will change something out in the world?
// A keyword hit decides "write" for free; otherwise a cheap model is asked for the
// single word read or write. Anything unclear — bad reply, error, no classifier —
// is "write", because the cost of a wrong "read" is an unapproved side effect.

const DEFAULT_KEYWORDS = [
  "send", "submit", "post", "pay", "buy", "book", "order", "reply", "publish", "delete", "cancel",
  "transfer", "message", "email", "sign", "accept", "purchase", "checkout", "unsubscribe", "approve",
];

function keywordHit(task, keywords) {
  const text = String(task || "");
  return keywords.some((k) => new RegExp(`\\b${String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

// `context`: earlier messages of the same conversation (session turns). The new
// message is classified by what it will make the agent DO given that context, so a
// bare continuation inherits the risk of what it continues.
function intentPrompt(task, { context = [] } = {}) {
  const head = `Classify the following browser task. Answer with exactly one word: read or write.
"read" = it only looks things up, reads pages, downloads or reports information.
"write" = it sends, submits, posts, pays, books, deletes, replies, signs or otherwise changes anything outside the browser tab.
When unsure, answer write.`;
  if (!context || !context.length) return `${head}

TASK:
${task}`;
  const earlier = context.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `${head}

The task is the NEW message in an ongoing conversation. Classify what the NEW message will make the agent do, given the earlier messages: a bare continuation ("continue", "yes", "do it", "the second one") inherits the risk of what it continues. If that is unclear, answer write.

EARLIER MESSAGES IN THIS CONVERSATION:
${earlier}

NEW MESSAGE:
${task}`;
}

async function classifyIntent(task, { keywords = DEFAULT_KEYWORDS, classify, context } = {}) {
  if (keywordHit(task, keywords)) return "write";
  if (typeof classify !== "function") return "write";
  try {
    const reply = String((await classify(intentPrompt(task, { context }))) || "");
    return /^\s*read\b/i.test(reply) ? "read" : "write";
  } catch {
    return "write";
  }
}

module.exports = { DEFAULT_KEYWORDS, keywordHit, intentPrompt, classifyIntent };
