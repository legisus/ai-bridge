#!/usr/bin/env node
// Intent gate: keyword hit → write without a model call; otherwise the model decides; fail closed.
const { DEFAULT_KEYWORDS, classifyIntent, explainIntent, intentPrompt } = require("../server/channels/intent.js");

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
  const pc = intentPrompt("continue", { context: ["open the turo inbox", "draft a reply to Ann"] });
  assert(/EARLIER MESSAGES IN THIS CONVERSATION:\n1\. open the turo inbox\n2\. draft a reply to Ann/.test(pc) && /NEW MESSAGE:\ncontinue/.test(pc) && /continuation/i.test(pc) && /answer write/i.test(pc), "intentPrompt: lists the context and classifies the new message against it");
  assert(!/NEW MESSAGE/.test(intentPrompt("x")) && !/NEW MESSAGE/.test(intentPrompt("x", { context: [] })), "intentPrompt: no context section without context");
  assert(/published prices, rates, availability, reviews or news/.test(p) && /unless the message asks to buy, book, apply, sign up, request a quote, submit a form or send anything/.test(p), "intentPrompt: looking up published prices is read; buying, booking, quote requests and form submissions are write");
  assert((await explainIntent("send the invoice to Bob", { classify })).reason === 'keyword "send"', "explainIntent: keyword reason names the word");
  assert((await explainIntent("open the dashboard", { classify: async () => "read" })).intent === "read" && (await explainIntent("open the dashboard", { classify: async () => "read" })).reason === "model", "explainIntent: model read");
  assert((await explainIntent("open the dashboard", { classify: async () => "write" })).reason === "model", "explainIntent: model write");
  assert((await explainIntent("open the dashboard", { classify: async () => "I think this reads data, honestly it is fine" })).reason === 'model reply unreadable: "I think this reads data, honestly it is…"', "explainIntent: unreadable reply quoted, truncated to 40 chars");
  assert((await explainIntent("open the dashboard", { classify: async () => { throw new Error("boom"); } })).reason === "classifier error: boom", "explainIntent: error reason");
  const leaky = await explainIntent("open the dashboard", { classify: async () => "Unexpected response: " + "x".repeat(15) + "example-secret-abcdef", redact: (t) => t.split("example-secret-abcdef").join("<redacted>") });
  assert(leaky.reason === 'model reply unreadable: "Unexpected response: xxxxxxxxxxxxxxx<red…"' && !/secret/.test(leaky.reason), "explainIntent: the reply is redacted before it is truncated (no partial secret)");
  assert((await explainIntent("open the dashboard", {})).reason === "no classifier", "explainIntent: no classifier reason");
  let got = null;
  await classifyIntent("continue", { classify: async (prompt) => { got = prompt; return "write"; }, context: ["send it"] });
  assert(got && /1\. send it/.test(got), "classifyIntent: context reaches the classifier");
  process.exit(failures ? 1 : 0);
})();
