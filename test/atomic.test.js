#!/usr/bin/env node
// atomicWrite: tmp file + rename, parent dir created, mode applied, no leftovers.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { atomicWrite } = require("../server/atomic.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-atomic-"));
const file = path.join(dir, "nested", "state.json");

atomicWrite(file, '{"a":1}\n');
assert(fs.readFileSync(file, "utf8") === '{"a":1}\n', "writes content (creating parent dir)");
assert(!fs.readdirSync(path.dirname(file)).some((n) => n.includes(".tmp-")), "no tmp leftovers");
assert((fs.statSync(file).mode & 0o777) === 0o600, "default mode 0600");
assert((fs.statSync(path.dirname(file)).mode & 0o777) === 0o700, "parent dir 0700");

atomicWrite(file, '{"a":2}\n');
assert(fs.readFileSync(file, "utf8") === '{"a":2}\n', "second write replaces content");

atomicWrite(path.join(dir, "pub.json"), "x", { mode: 0o644 });
assert((fs.statSync(path.join(dir, "pub.json")).mode & 0o777) === 0o644, "explicit mode honoured");

// withLock: exclusive lock file, timeout when held, stale lock reclaimed, always released
const { withLock } = require("../server/atomic.js");
const target = path.join(dir, "store.json");
let ran = false;
withLock(target, () => { ran = true; assert(fs.existsSync(target + ".lock"), "withLock: lock file present inside"); });
assert(ran && !fs.existsSync(target + ".lock"), "withLock: runs fn and removes the lock");
fs.writeFileSync(target + ".lock", "held");
let threw = null; try { withLock(target, () => {}, { timeoutMs: 120 }); } catch (e) { threw = e; }
assert(threw && /busy|lock/.test(threw.message), "withLock: held lock → throws after timeout");
const old = Date.now() / 1000 - 60;
fs.utimesSync(target + ".lock", old, old);
ran = false; withLock(target, () => { ran = true; }, { staleMs: 10000 });
assert(ran && !fs.existsSync(target + ".lock"), "withLock: stale lock reclaimed");
let inner = null; try { withLock(target, () => { throw new Error("boom"); }); } catch (e) { inner = e; }
assert(inner && inner.message === "boom" && !fs.existsSync(target + ".lock"), "withLock: lock released when fn throws");

fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
