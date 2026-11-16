#!/usr/bin/env node
// dmPolicy truth table + RateLimiter (per sender, global, unknown bucket, LRU).
const { decide, RateLimiter } = require("../server/channels/policy.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const d = (policy, allowFrom, senderId, paired) => decide({ policy, allowFrom, senderId, paired });

// pairing (default)
assert(d("pairing", ["1"], "1", false) === "run", "pairing: known → run");
assert(d("pairing", [], "2", true) === "run", "pairing: paired → run");
assert(d("pairing", [], "3", false) === "pair", "pairing: unknown → pair");
assert(d(undefined, [], "3", false) === "pair", "pairing is the default policy");
// allowlist
assert(d("allowlist", ["1"], "1", false) === "run", "allowlist: known → run");
assert(d("allowlist", ["1"], "2", true) === "drop", "allowlist: paired-but-not-listed → drop");
assert(d("allowlist", ["1"], "3", false) === "drop", "allowlist: unknown → drop");
// open
assert(d("open", ["*"], "9", false) === "run", "open with * : unknown → run");
assert(d("open", ["*"], "9", true) === "run", "open with * : paired → run");
assert(d("open", ["1"], "1", false) === "run", "open without * : known → run");
assert(d("open", ["1"], "2", true) === "drop", "open without * : paired → drop (behaves as allowlist)");
assert(d("open", ["1"], "3", false) === "drop", "open without * : unknown → drop");
// disabled
assert(d("disabled", ["1"], "1", true) === "drop", "disabled: everything → drop");
// id matching is string-exact
assert(d("allowlist", [123], "123", false) === "run", "allowFrom numbers compare as strings");

// RateLimiter
{
  let t = 1_000_000;
  const now = () => t;
  const rl = new RateLimiter({ perSender: 20, global: 200, unknown: 5, windowMs: 60000, maxSenders: 4096, now });
  let ok = 0;
  for (let i = 0; i < 21; i++) if (rl.allow("a")) ok++;
  assert(ok === 20, "per sender: 20 allowed, 21st refused");
  t += 60001;
  assert(rl.allow("a") === true, "per sender: window reset after 60 s");
}
{
  let t = 0; const rl = new RateLimiter({ perSender: 1000, global: 200, now: () => t });
  let ok = 0;
  for (let i = 0; i < 201; i++) if (rl.allow(`s${i}`)) ok++;
  assert(ok === 200, "global: 200 allowed across senders, 201st refused");
}
{
  let t = 0; const rl = new RateLimiter({ unknown: 5, now: () => t });
  let ok = 0;
  for (let i = 0; i < 6; i++) if (rl.allow("stranger", { unknown: true })) ok++;
  assert(ok === 5, "unknown bucket: 5 per minute");
  assert(rl.allow("paired") === true, "unknown bucket does not consume a paired sender's allowance");
}
{
  let t = 0; const rl = new RateLimiter({ maxSenders: 3, now: () => t });
  rl.allow("x1"); t++; rl.allow("x2"); t++; rl.allow("x3"); t++; rl.allow("x1"); t++; rl.allow("x4");
  assert(rl.trackedSenders() === 3, "LRU: at most maxSenders tracked");
  assert(!rl.isTracked("x2") && rl.isTracked("x1"), "LRU: least recently seen sender evicted");
}

process.exit(failures ? 1 : 0);
