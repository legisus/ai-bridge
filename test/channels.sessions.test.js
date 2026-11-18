#!/usr/bin/env node
// SessionStore: rows, owner scoping, names, routing grammar, generation counter,
// compare-and-swap completion, recent/last, pauseAll/stop, persistence.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-sessions-"));
const S = require("../server/channels/sessions.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const file = path.join(process.env.AI_BRIDGE_HOME, "channels-sessions.json");
const dir = path.join(process.env.AI_BRIDGE_HOME, "sessions");
assert(S.SESSIONS_FILE === file && S.SESSIONS_DIR === dir, "paths live under AI_BRIDGE_HOME");
assert(S.MODELS.opus === "claude-opus-5-5" && S.MODELS.fable === "claude-fable-5-1" && S.MODELS.haiku === "claude-haiku-5-5" && S.MAX_PER_SENDER === 10 && eq(S.RESERVED, ["agent", "all", "none"]), "constants");

const owner = { channel: "fake", accountId: "default", senderId: "42", chatId: "42" };
const other = { channel: "fake", accountId: "default", senderId: "43", chatId: "43" };
const acct2 = { channel: "fake", accountId: "b", senderId: "42", chatId: "42" };
let clock = 1_700_000_000_000;

// names
assert(S.normalizeName("Turo") === "turo" && S.normalizeName("a_b-1") === "a_b-1", "normalizeName: ascii lower-case");
assert(["", "x".repeat(25), "tu ro", "türo", "agent", "ALL", "none"].every((n) => S.normalizeName(n) === null), "normalizeName: rejects length, spaces, non-ascii, reserved");
assert(S.ownerKey(owner) === "fake:default:42" && S.ownerKey({ channel: "fake", senderId: "42" }) === "fake:default:42" && S.ownerKey(acct2) === "fake:b:42", "ownerKey: channel:accountId:senderId");

// routing grammar
assert(eq(S.parseRoute("@Turo open the inbox"), { kind: "session", name: "turo", text: "open the inbox" }), "parseRoute: @name body");
assert(eq(S.parseRoute("@turo\nopen it"), { kind: "session", name: "turo", text: "open it" }), "parseRoute: newline after the name is a body separator");
assert(eq(S.parseRoute("@turo"), { kind: "usage", name: "turo" }) && eq(S.parseRoute("@turo   "), { kind: "usage", name: "turo" }), "parseRoute: bare @name (even with trailing spaces) is usage");
assert(eq(S.parseRoute("@@turo hi"), { kind: "plain", text: "@turo hi" }), "parseRoute: @@ escapes a literal leading @");
assert(eq(S.parseRoute("@tu ro x"), { kind: "session", name: "tu", text: "ro x" }) && S.parseRoute("hello @turo").kind === "plain" && S.parseRoute("@tü x").kind === "plain", "parseRoute: anchored at the start, name chars only");
assert(eq(S.parseRoute("plain text"), { kind: "plain", text: "plain text" }), "parseRoute: ordinary text is plain");

// store
const store = new S.SessionStore(file, { dir, now: () => clock });
const r = store.create(owner, "Turo");
assert(/^[0-9a-f]{12}$/.test(r.id) && /^[0-9a-f-]{36}$/.test(r.claudeSessionId) && r.name === "turo" && r.model === "claude-fable-5-1" && r.state === "active" && r.gen === 1 && r.started === false && r.turns === 0 && eq(r.recent, []) && eq(r.declined, []), "create: row defaults");
assert(r.channel === "fake" && r.accountId === "default" && r.senderId === "42" && r.chatId === "42" && r.createdAt && r.lastUsedAt === r.createdAt, "create: owner fields and timestamps");
assert((fs.statSync(store.dirOf(r.id)).mode & 0o777) === 0o700 && (fs.statSync(file).mode & 0o777) === 0o600, "create: dir 0700, file 0600");
assert(store.current(owner).id === r.id && store.current(other) === null && store.current(acct2) === null, "create: current for its owner only (sender id alone is not identity)");
assert(store.create(owner, "tz", "opus").model === "claude-opus-5-5", "create: model key mapped (default is fable, opus by name)");
for (const [name, model, msg] of [["turo", "opus", "already used"], ["TURO", "opus", "already used"], ["agent", "opus", "invalid"], ["x", "gpt", "unknown model"]]) {
  let e = null; try { store.create(owner, name, model); } catch (err) { e = err; }
  assert(e && e.message.includes(msg), `create: refuses ${name}/${model}`);
}
assert(store.create(other, "turo").name === "turo" && store.create(acct2, "turo").name === "turo", "create: names are per owner key");
for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  let e = null; try { store.create(other, `m-${bad.replace(/_/g, "")}`.toLowerCase(), bad); } catch (err) { e = err; }
  assert(e && /unknown model/.test(e.message), `create: inherited property "${bad}" is not a model`);
}
assert(store.get(owner, { name: "turo" }).id === r.id && store.get(owner, { name: "TURO" }).id === r.id && store.get(other, { id: r.id }) === null && store.get(acct2, { id: r.id }) === null, "get: by name (case-folded), scoped to the full owner key");
assert(store.list(owner).map((x) => x.name).join(",") === "turo,tz" && store.list(acct2).length === 1, "list: creation order, per owner");
for (let i = store.list(owner).length; i < 10; i++) store.create(owner, `s${i}`);
{ let e = null; try { store.create(owner, "s11"); } catch (err) { e = err; } assert(e && /max 10/.test(e.message), "create: 11th live session refused"); }

// pause / resume / gen
const p = store.pause(owner, r.id);
assert(p.state === "paused" && p.gen === 2 && store.resume(owner, r.id).gen === 2 && store.get(owner, { id: r.id }).state === "active", "pause bumps gen; resume keeps gen");
assert(store.pause(other, r.id) === null && store.pause(acct2, r.id) === null && store.resume(other, r.id) === null, "pause/resume: foreign owners cannot touch the row");

// complete: compare-and-swap on gen, never writes state
assert(store.complete(r.id, 1) === false && store.get(owner, { id: r.id }).turns === 0, "complete: stale gen ignored");
clock += 1000;
assert(store.complete(r.id, 2, { declined: ["send it", "pay it"] }) === true && store.get(owner, { id: r.id }).turns === 1 && eq(store.get(owner, { id: r.id }).declined, ["send it", "pay it"]) && store.get(owner, { id: r.id }).lastUsedAt !== r.lastUsedAt, "complete: current gen counts the turn, appends each declined action, bumps lastUsedAt");
store.complete(r.id, 2, { declined: ["a", "b", "c", "d"], countTurn: false });
assert(store.get(owner, { id: r.id }).turns === 1 && eq(store.get(owner, { id: r.id }).declined, ["pay it", "a", "b", "c", "d"]), "complete: countTurn=false leaves turns; declined capped at 5 (oldest dropped)");
store.pause(owner, r.id);
assert(store.complete(r.id, 3) === true && store.get(owner, { id: r.id }).state === "paused", "complete: never un-pauses");
assert(store.complete("000000000000", 1) === false, "complete: unknown id is false");

// recordInbound / last
assert(eq(store.recordInbound(owner, { text: "a", sessionId: r.id }), []) && eq(store.recordInbound(owner, { text: "b", sessionId: r.id }), ["a"]), "recordInbound: returns the context before this text");
store.recordInbound(owner, { text: "c", sessionId: r.id });
assert(eq(store.recordInbound(owner, { text: "d", sessionId: r.id }), ["a", "b", "c"]) && eq(store.get(owner, { id: r.id }).recent, ["b", "c", "d"]) && eq(store.last(owner), { text: "d", sessionId: r.id }), "recordInbound: recent keeps 3, last stores the target id");
assert(eq(store.recordInbound(owner, { text: "plain", sessionId: "agent" }), []) && store.last(owner).sessionId === "agent" && store.last(acct2) === null, "recordInbound: agent target; last is per owner key");

// pauseAll / stop / setCurrent
store.setCurrent(owner, r.id);
assert(store.pauseAll(owner) === 10 && store.list(owner).every((x) => x.state === "paused") && store.current(owner) === null && store.list(other)[0].state === "active" && store.list(acct2)[0].state === "active", "pauseAll: every row of the owner paused, current cleared, other owners untouched");
assert(store.list(owner).find((x) => x.id === r.id).gen === 4, "pauseAll: bumps gen on every row");
store.setCurrent(owner, r.id);
assert(store.stop(owner, r.id).id === r.id && store.get(owner, { id: r.id }) === null && store.current(owner) === null && fs.existsSync(store.dirOf(r.id)), "stop: row removed, current cleared, dir kept");
assert(store.stop(owner, r.id) === null && store.stop(other, store.list(owner)[0].id) === null, "stop: unknown or foreign id is null");
{ let e = null; try { store.setCurrent(owner, "000000000000"); } catch (err) { e = err; } assert(e && /no such session/.test(e.message), "setCurrent: unknown id refused"); }
{ let e = null; try { store.setCurrent(owner, store.list(other)[0].id); } catch (err) { e = err; } assert(e && /no such session/.test(e.message), "setCurrent: foreign id refused"); }
store.setCurrent(owner, null); assert(store.current(owner) === null, "setCurrent: null clears");
assert(store.markStarted(store.list(owner)[0].id).started === true && store.markStarted("000000000000") === null, "markStarted: durable flag; unknown id null");
assert(new S.SessionStore(file, { dir }).list(owner).length === 9 && new S.SessionStore(file, { dir }).list(owner)[0].started === true, "persistence: a fresh instance reads the same file");
{
  // a missing file is an empty store; a corrupt or unreadable one fails loudly instead of silently routing to the agent
  const fresh = new S.SessionStore(path.join(process.env.AI_BRIDGE_HOME, "nope.json"), { dir });
  assert(fresh.list(owner).length === 0 && fresh.current(owner) === null, "read: ENOENT is an empty store");
  const corrupt = path.join(process.env.AI_BRIDGE_HOME, "corrupt.json"); fs.writeFileSync(corrupt, "{ not json");
  let e = null; try { new S.SessionStore(corrupt, { dir }).list(owner); } catch (err) { e = err; }
  assert(e && /channels-sessions|corrupt|JSON/i.test(e.message) && fs.readFileSync(corrupt, "utf8") === "{ not json", "read: corrupt JSON throws and the file is left alone");
  fs.chmodSync(file, 0o000);
  e = null; try { new S.SessionStore(file, { dir }).list(owner); } catch (err) { e = err; }
  fs.chmodSync(file, 0o600);
  assert(e && /EACCES|unreadable|permission/i.test(e.message), "read: an unreadable file throws");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll sessions tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures ? 1 : 0);
