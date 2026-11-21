// Intent gate: does this task look like it will change something out in the world?
// A keyword hit decides "write" for free; otherwise a cheap model is asked for the
// single word read or write. Anything unclear — bad reply, error, no classifier —
// is "write", because the cost of a wrong "read" is an unapproved side effect.

const DEFAULT_KEYWORDS = [
  "send", "submit", "post", "pay", "buy", "book", "order", "reply", "publish", "delete", "cancel",
  "transfer", "message", "email", "sign", "accept", "purchase", "checkout", "unsubscribe", "approve",
];

function keywordHit(task, keywords) { return keywordFor(task, keywords) !== undefined; }

// `context`: earlier messages of the same conversation (session turns). The new
// message is classified by what it will make the agent DO given that context, so a
// bare continuation inherits the risk of what it continues.
function intentPrompt(task, { context = [] } = {}) {
  const head = `Classify the following browser task. Answer with exactly one word: read or write.
"read" = it only looks things up, reads pages, downloads or reports information.
"write" = it sends, submits, posts, pays, books, deletes, replies, signs or otherwise changes anything outside the browser tab.
Looking up or comparing published prices, rates, availability, reviews or news, and summarising or reporting what was found, is read — even on insurance, shopping or booking sites — unless the message asks to buy, book, apply, sign up, request a quote, submit a form or send anything.
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

function keywordFor(task, keywords) {
  const text = String(task || "");
  return keywords.find((k) => new RegExp(`\\b${String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

// { intent, reason }: the verdict and why, for the log. Reasons: `keyword "send"`, `model`,
// `model reply unreadable: "…"`, `classifier error: …`, `no classifier`. `redact` is applied to
// the whole reply before it is quoted, so truncation never leaves part of a secret.
async function explainIntent(task, { keywords = DEFAULT_KEYWORDS, classify, context, redact } = {}) {
  const hit = keywordFor(task, keywords);
  if (hit !== undefined) return { intent: "write", reason: `keyword "${hit}"` };
  if (typeof classify !== "function") return { intent: "write", reason: "no classifier" };
  try {
    const reply = String((await classify(intentPrompt(task, { context }))) || "");
    if (/^\s*read\b/i.test(reply)) return { intent: "read", reason: "model" };
    if (/^\s*write\b/i.test(reply)) return { intent: "write", reason: "model" };
    const short = (typeof redact === "function" ? redact(reply) : reply).trim().replace(/\s+/g, " ");   // redacted whole, then cut
    return { intent: "write", reason: `model reply unreadable: "${short.length > 40 ? short.slice(0, 40).trimEnd() + "…" : short}"` };
  } catch (e) {
    return { intent: "write", reason: `classifier error: ${e && e.message ? e.message : e}` };
  }
}

async function classifyIntent(task, opts) { return (await explainIntent(task, opts)).intent; }

module.exports = { DEFAULT_KEYWORDS, keywordHit, intentPrompt, classifyIntent, explainIntent };
