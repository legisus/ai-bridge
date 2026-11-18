// Outbox: the per-run directory the ops models write deliverables into
// (it is their cwd, so `pdf --out x.pdf` lands here). Collection is hardened:
// regular files only, no symlinks, same uid, opened O_NOFOLLOW and re-checked by
// fstat; the fd is the only handle handed to adapters, so nothing is re-opened by
// path at delivery time. ~/.ai-browser-bridge/outbox/<runId>/
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");

const OUTBOX_DIR = path.join(DIR, "outbox");
const DEFAULTS = { maxFiles: 10, maxFileBytes: 45e6, maxTotalBytes: 100e6 };
// Inside a persistent session directory this name holds undelivered files of earlier
// turns; it is never collected, reported or stashed itself.
const RESERVED_NAME = "leftover";

function createOutbox(runId) {
  const dir = path.join(OUTBOX_DIR, String(runId).replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

// What a directory holds right now (name → identity), taken before a turn so the
// files it produced can be told from older ones. The reserved dir is excluded.
function snapshot(dir) {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === RESERVED_NAME) continue;
    try { const st = fs.lstatSync(path.join(dir, name)); out.set(name, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size }); } catch {}
  }
  return out;
}

// `since`: a snapshot; entries unchanged since it are neither collected nor reported.
function collect(dir, opts = {}) {
  const { maxFiles, maxFileBytes, maxTotalBytes, since } = { ...DEFAULTS, ...opts };
  const files = [];
  const skipped = [];
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return { files, skipped }; }
  let total = 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const name of names) {
    if (name === RESERVED_NAME) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { skipped.push({ name, reason: "unreadable" }); continue; }
    if (since) {
      const was = since.get(name);
      if (was && was.ino === st.ino && was.mtimeMs === st.mtimeMs && was.size === st.size) continue;
    }
    if (st.isSymbolicLink()) { skipped.push({ name, reason: "symlink" }); continue; }
    if (!st.isFile()) { skipped.push({ name, reason: "not a regular file" }); continue; }
    if (uid != null && st.uid !== uid) { skipped.push({ name, reason: "foreign owner" }); continue; }
    if (st.size > maxFileBytes) { skipped.push({ name, reason: "too large" }); continue; }
    if (files.length >= maxFiles) { skipped.push({ name, reason: "too many" }); continue; }
    if (total + st.size > maxTotalBytes) { skipped.push({ name, reason: "total too large" }); continue; }
    let fd;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const fst = fs.fstatSync(fd);
      if (fst.ino !== st.ino || fst.dev !== st.dev || fst.size !== st.size || !fst.isFile()) {
        fs.closeSync(fd); skipped.push({ name, reason: "changed" }); continue;
      }
    } catch { if (fd != null) try { fs.closeSync(fd); } catch {} skipped.push({ name, reason: "unreadable" }); continue; }
    files.push({ name, size: st.size, fd });
    total += st.size;
  }
  return { files, skipped };
}

// Close every fd, unlink delivered names, remove the dir if nothing is left
// (never with keepDir: a session directory outlives its turns).
function finish(dir, delivered = [], files = [], { keepDir = false } = {}) {
  for (const f of files) try { fs.closeSync(f.fd); } catch {}
  for (const name of delivered) try { fs.unlinkSync(path.join(dir, name)); } catch {}
  if (keepDir) return;
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}

// Move undelivered entries out of the way (into <dir>/leftover/<runId>/) so the next
// turn starts clean and never re-reports them. Returns the names actually moved.
function stash(dir, names = [], dest) {
  const moved = [];
  try { fs.mkdirSync(dest, { mode: 0o700, recursive: true }); } catch { return moved; }
  for (const name of names) {
    if (!name || name === RESERVED_NAME || name.includes("/") || name.includes("\\")) continue;
    try { fs.renameSync(path.join(dir, name), path.join(dest, name)); moved.push(name); } catch {}
  }
  return moved;
}

module.exports = { OUTBOX_DIR, DEFAULTS, RESERVED_NAME, createOutbox, snapshot, collect, finish, stash };
