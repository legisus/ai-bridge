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

function createOutbox(runId) {
  const dir = path.join(OUTBOX_DIR, String(runId).replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

function collect(dir, opts = {}) {
  const { maxFiles, maxFileBytes, maxTotalBytes } = { ...DEFAULTS, ...opts };
  const files = [];
  const skipped = [];
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return { files, skipped }; }
  let total = 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { skipped.push({ name, reason: "unreadable" }); continue; }
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

// Close every fd, unlink delivered names, remove the dir if nothing is left.
function finish(dir, delivered = [], files = []) {
  for (const f of files) try { fs.closeSync(f.fd); } catch {}
  for (const name of delivered) try { fs.unlinkSync(path.join(dir, name)); } catch {}
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}

module.exports = { OUTBOX_DIR, DEFAULTS, createOutbox, collect, finish };
