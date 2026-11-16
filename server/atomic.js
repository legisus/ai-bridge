// Crash-safe file writes for JSON state (jobs, recipes, pairing, channel state):
// write a sibling temp file, then rename over the target. A reader never sees a
// half-written file, and two processes writing the same file cannot interleave.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function atomicWrite(file, text, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Cross-process mutual exclusion for a small JSON store shared by the daemon and
// the CLI (pairing.json): an exclusive lock file next to the store. Synchronous
// on purpose (the callers are sync read-modify-write); waits up to timeoutMs,
// reclaims a lock older than staleMs (a crashed holder), always releases.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function withLock(file, fn, { timeoutMs = 2000, staleMs = 10000, pollMs = 20 } = {}) {
  const lock = `${file}.lock`;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, "wx", 0o600); fs.writeSync(fd, String(process.pid)); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > staleMs) { fs.unlinkSync(lock); continue; }
      } catch (e2) { if (e2.code === "ENOENT") continue; throw e2; }
      if (Date.now() >= deadline) throw new Error(`${file} is busy (lock ${lock} held by another process)`);
      sleepSync(pollMs);
    }
  }
  try { return fn(); }
  finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
}

module.exports = { atomicWrite, withLock };
