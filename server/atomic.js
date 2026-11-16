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

module.exports = { atomicWrite };
