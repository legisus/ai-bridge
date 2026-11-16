#!/usr/bin/env node
// Intent gate: keyword hit → write without a model call; otherwise the model decides; fail closed.
const { DEFAULT_KEYWORDS, classifyIntent, intentPrompt } = require("../server/channels/intent.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  assert(["send", "submit", "pay", "buy", "book", "delete", "cancel", "reply", "publish", "order", "transfer", "message", "email", "sign", "accept", "post"].every((k) => DEFAULT_KEYWORDS.includes(k)),
    "DEFAULT_KEYWORDS: spec list present");

  let calls = 0;
  const classify = async () => { calls++; return "read"; };
  assert((await classifyIntent("send the invoice to Bob", { classify })) === "write" && calls === 0, "keyword hit → write, classifier not called");
  assert((await classifyIntent("Please PAY the toll", { classify })) === "write", "keyword match is case-insensitive");
  assert((await classifyIntent("what is the postage balance", { classify })) === "read" && calls === 1, "'postage' does not match 'post' (word boundary); classifier consulted → read");

  assert((await classifyIntent("open the dashboard", { classify: async () => "write" })) === "write", "classifier says write → write");
  assert((await classifyIntent("open the dashboard", { classify: async () => " READ — it only looks" })) === "read", "classifier reply starting with read → read");
  assert((await classifyIntent("open the dashboard", { classify: async () => "I think this reads data" })) === "write", "unreadable reply → write (fail closed)");
  assert((await classifyIntent("open the dashboard", { classify: async () => { throw new Error("boom"); } })) === "write", "classifier throws → write (fail closed)");
  assert((await classifyIntent("open the dashboard", {})) === "write", "no classifier → write (fail closed)");
  assert((await classifyIntent("open the dashboard", { keywords: ["dashboard"], classify })) === "write", "custom keyword list honoured");

  const p = intentPrompt("open the dashboard");
  assert(p.includes("open the dashboard") && /\bread\b/.test(p) && /\bwrite\b/.test(p), "intentPrompt: contains the task and asks for read or write");
  process.exit(failures ? 1 : 0);
})();
