#!/usr/bin/env node
// Approvals: button data encoding, single-use bound records, TTL, abort.
const { encode, decode, digestOf, Approvals } = require("../server/channels/approvals.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  // encode / decode
  const id = "0123456789abcdef";
  assert(encode("intent", "a", id) === `ab1:intent:a:${id}`, "encode: ab1:<kind>:<decision>:<id>");
  assert(JSON.stringify(decode(`ab1:intent:a:${id}`)) === JSON.stringify({ kind: "intent", decision: "a", id }), "decode: round-trip");
  assert(decode("tga1:x:y:z") === null, "decode: foreign prefix → null");
  assert(JSON.stringify(decode("ab1:bad")) === '{"invalid":true}', "decode: ab1 with bad shape → invalid");
  assert(JSON.stringify(decode("ab1:intent:x:" + id)) === '{"invalid":true}', "decode: bad decision → invalid");
  assert(JSON.stringify(decode("ab1:intent:a:short")) === '{"invalid":true}', "decode: bad id → invalid");
  assert(/^[0-9a-f]{64}$/.test(digestOf("x")) && digestOf("x") === digestOf("x"), "digestOf: sha256 hex, deterministic");

  const base = { runId: "r1", kind: "intent", digest: digestOf("task"), channel: "telegram", accountId: "default", chatId: "100", senderId: "42" };

  // approve by originating sender
  {
    const A = new Approvals();
    const { id, promise } = A.create(base);
    assert(/^[0-9a-f]{16}$/.test(id), "create: 16-hex id");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "approved", "resolve: sender approves → approved");
    assert((await promise) === "approved", "promise resolves approved");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve: second click → stale");
  }
  // ownership is checked before "stale": a foreign account never learns a record settled
  {
    const A = new Approvals({ ttlMs: 1000, now: () => 0 });
    const { id } = A.create(base);
    A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "d" });
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "turo", chatId: "100", kind: "intent", decision: "a" }) === "forbidden", "resolve: a settled record answers forbidden, not stale, to another account");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve: the owner still gets stale after settlement");
    assert(A.resolve({ id: "ffffffffffffffff", actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve: an unknown id is stale");
  }
  {
    let t = 0;
    const A = new Approvals({ ttlMs: 1000, now: () => t });
    const { id, promise } = A.create(base);
    t = 2000;
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "turo", chatId: "100", kind: "intent", decision: "a" }) === "forbidden", "resolve: an expired record is forbidden to a foreign account");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale" && (await promise) === "expired", "resolve: the owner gets stale for an expired record, which settles expired");
  }
  // other actor forbidden, promise pending
  {
    const A = new Approvals();
    const { id, promise } = A.create(base);
    let settled = false; promise.then(() => { settled = true; });
    assert(A.resolve({ id, actorId: "99", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "forbidden", "resolve: other actor → forbidden");
    await new Promise((r) => setTimeout(r, 5));
    assert(settled === false, "forbidden click leaves the promise pending");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "999", kind: "intent", decision: "a" }) === "forbidden", "resolve: wrong chatId → forbidden");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "recipe", decision: "a" }) === "forbidden", "resolve: wrong kind → forbidden");
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "d" }) === "denied", "resolve: sender denies → denied");
    assert((await promise) === "denied", "promise resolves denied");
  }
  // unknown id
  {
    const A = new Approvals();
    assert(A.resolve({ id: "ffffffffffffffff", actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve: unknown id → stale");
  }
  // TTL expiry
  {
    let t = 0; const now = () => t;
    const A = new Approvals({ ttlMs: 600000, now });
    const { id, promise } = A.create(base);
    t = 11 * 60 * 1000;
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve after 11 min → stale");
    assert((await promise) === "expired", "expired record resolves expired (a timeout is not a refusal)");
    A.close();
  }
  // the TTL timer itself settles "expired"
  {
    const A = new Approvals({ ttlMs: 30 });
    const keep = setTimeout(() => {}, 5000);   // the TTL timer is unref'd; keep the loop alive for it
    const { id, promise } = A.create(base);
    assert((await promise) === "expired", "timer: an unanswered record resolves expired");
    clearTimeout(keep);
    assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "timer: a tap after expiry is stale, never approved");
    A.close();
  }
  // abort signal
  {
    const A = new Approvals();
    const ctl = new AbortController();
    const { promise } = A.create({ ...base, signal: ctl.signal });
    ctl.abort();
    assert((await promise) === "denied", "aborted signal → denied");
  }
  // pending lookup for the run
  {
    const A = new Approvals();
    const { id } = A.create(base);
    assert(A.pendingFor("r1").length === 1 && A.pendingFor("r1")[0].id === id, "pendingFor: lists the run's open approvals");
    A.close();
  }
  process.exit(failures ? 1 : 0);
})();
