// Append-only daemon log with size rotation and secret redaction.
// ~/.ai-browser-bridge/channels.log → .1 → .2 → .3 (older dropped).
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");

function makeLogger({ file = path.join(DIR, "channels.log"), maxBytes = 10e6, keep = 3, redact = (t) => t, verbose = false } = {}) {
  const dir = path.dirname(file);
  function rotate() {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < maxBytes) return;
    try { fs.unlinkSync(`${file}.${keep}`); } catch {}
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
    try { fs.renameSync(file, `${file}.1`); } catch {}
  }
  return function log(line) {
    const text = `${new Date().toISOString()} ${redact(String(line == null ? "" : line))}\n`;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
      rotate();
      fs.appendFileSync(file, text, { mode: 0o600 });
    } catch {}
    if (verbose) process.stderr.write(`[channels] ${text}`);
  };
}

module.exports = { makeLogger };
