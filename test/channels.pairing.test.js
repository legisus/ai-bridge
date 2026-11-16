#!/usr/bin/env node
// Pairing store: codes, upsert, caps, expiry, approve/revoke, atomic persistence, CLI.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-pairing-"));
const pairing = require("../server/channels/pairing.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// codes
{
  const codes = new Set(Array.from({ length: 100 }, () => pairing.generateCode()));
  assert([...codes].every((c) => ALPHABET.test(c)), "generateCode: 6 chars from the unambiguous alphabet");
  assert(codes.size === 100, "generateCode: 100 calls unique");
}

// upsert
const base = { channel: "telegram", accountId: "default", senderId: "42", meta: { username: "bob" } };
const r1 = pairing.request(base);
const r2 = pairing.request(base);
assert(r1.created === true && ALPHABET.test(r1.code), "request: first call creates a code");
assert(r2.created === false && r2.code === r1.code, "request: repeat is an upsert with the same code");
assert(pairing.isApproved(base) === false, "isApproved: pending is not approved");

// approve / revoke
assert(pairing.approve("telegram", "ZZZZZZ") === null, "approve: wrong code → null");
const ap = pairing.approve("telegram", r1.code);
assert(ap && ap.senderId === "42" && ap.meta.username === "bob", "approve: returns sender id and meta");
assert(pairing.isApproved(base) === true, "isApproved: true after approve");
assert(pairing.load().pending.length === 0, "approve: pending entry removed");
assert(pairing.revoke("telegram", "42") === true, "revoke: true for an approved sender");
assert(pairing.isApproved(base) === false, "isApproved: false after revoke");
assert(pairing.revoke("telegram", "42") === false, "revoke: false when nothing to revoke");

// cap: 21 pending → 20, oldest evicted
{
  for (let i = 0; i < 21; i++) pairing.request({ channel: "slack", accountId: "default", senderId: `u${i}` });
  const pend = pairing.load().pending.filter((p) => p.channel === "slack");
  assert(pend.length === 20, "cap: at most 20 pending per channel");
  assert(!pend.some((p) => p.senderId === "u0") && pend.some((p) => p.senderId === "u20"), "cap: oldest evicted");
}

// expiry: entry older than 1 h pruned on load
{
  const st = pairing.load();
  st.pending.push({ channel: "x", accountId: "default", senderId: "old", code: "AAAAAA", createdAt: new Date(Date.now() - 2 * 3600e3).toISOString() });
  pairing.save(st);
  assert(!pairing.load().pending.some((p) => p.senderId === "old"), "expiry: 2h-old pending pruned");
}

// atomic persistence
assert(!fs.readdirSync(path.dirname(pairing.PAIRING_FILE)).some((n) => n.includes(".tmp-")), "persistence: no tmp leftovers");
assert((fs.statSync(pairing.PAIRING_FILE).mode & 0o777) === 0o600, "persistence: mode 0600");

// CLI
{
  const out = [];
  const orig = console.log; console.log = (...a) => out.push(a.join(" "));
  pairing.request({ channel: "telegram", accountId: "default", senderId: "7", meta: { firstName: "Ann" } });
  const code = pairing.load().pending.find((p) => p.senderId === "7").code;
  pairing.main(["list"]);
  pairing.main(["approve", "telegram", code]);
  pairing.main(["list"]);
  console.log = orig;
  assert(out.some((l) => l.includes(code) && l.includes("7")), "cli list: shows code and sender id");
  assert(out.some((l) => /approved/i.test(l) && l.includes("7") && l.includes("Ann")), "cli approve: prints sender id and meta");
  assert(pairing.isApproved({ channel: "telegram", accountId: "default", senderId: "7" }), "cli approve: sender approved");
}
{
  pairing.save({ pending: [], approved: [] });
  const out = [];
  const orig = console.log; console.log = (...a) => out.push(a.join(" "));
  pairing.main(["list"]);
  console.log = orig;
  assert(out.some((l) => /no pending/i.test(l)), "cli list: empty store prints 'no pending'");
}

// cross-process safety: mutations take the store lock
{
  fs.writeFileSync(pairing.PAIRING_FILE + ".lock", "other");
  let threw = null; try { pairing.request({ channel: "x", accountId: "default", senderId: "lockme" }, { timeoutMs: 100 }); } catch (e) { threw = e; }
  assert(threw && /busy|lock/.test(threw.message), "request: held store lock → throws instead of clobbering");
  fs.unlinkSync(pairing.PAIRING_FILE + ".lock");
  pairing.request({ channel: "x", accountId: "default", senderId: "lockme" });
  assert(!fs.existsSync(pairing.PAIRING_FILE + ".lock"), "request: lock released after the write");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
