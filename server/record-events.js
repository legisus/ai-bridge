// While a window recording is active (the macOS app drops <recId>.active into
// ~/.ai-browser-bridge/recordings/), the relay journals the bridge's own input
// commands with wall-clock timestamps. The app merges them into <out>.steps.json.
// Typed text is NOT stored (it may be a password) — only its length.
const fs = require("fs");
const path = require("path");
const { DIR } = require("./token");

const REC_DIR = path.join(DIR, "recordings");
const STEP_CMDS = new Set(["click", "type", "insertText", "key", "navigate", "scroll", "newTab", "selectTab", "activateTab"]);

function activeIds() {
  try { return fs.readdirSync(REC_DIR).filter((f) => f.endsWith(".active")).map((f) => f.slice(0, -7)); }
  catch { return []; }
}

function append(id, obj) {
  try { fs.appendFileSync(path.join(REC_DIR, `${id}.events.jsonl`), JSON.stringify(obj) + "\n"); } catch {}
}

const open = new Set(); // request ids that were journaled

function logRecordedStep(msg) {
  if (!STEP_CMDS.has(msg.cmd)) return;
  const ids = activeIds();
  if (!ids.length) return;
  const p = msg.params || {};
  const ev = { id: msg.id, at: Date.now(), type: msg.cmd };
  if (p.tabId != null) ev.tabId = p.tabId;
  if (p.selector) ev.selector = String(p.selector).slice(0, 300);
  if (p.x != null && p.y != null) { ev.x = p.x; ev.y = p.y; }
  if (p.url) ev.url = String(p.url).slice(0, 500);
  if (p.key) ev.key = String(p.key);
  if (p.text != null) ev.textLength = String(p.text).length;
  open.add(msg.id);
  for (const id of ids) append(id, ev);
}

function logRecordedEnd(id) {
  if (!open.delete(id)) return;
  const end = { id, end: Date.now() };
  for (const r of activeIds()) append(r, end);
}

module.exports = { logRecordedStep, logRecordedEnd, REC_DIR };
