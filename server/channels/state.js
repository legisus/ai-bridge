// Durable channel state: transport dedup ring, per-account offsets, and the task
// queue with its status lifecycle (queued → running → awaiting-approval → done).
// Acceptance of an inbound event is ONE atomic write (seen + queue + offset), so
// a crash can neither lose nor double a task. ~/.ai-browser-bridge/channels-state.json
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");
const { atomicWrite } = require("../atomic");

const STATE_FILE = path.join(DIR, "channels-state.json");
const RING = 1000;
const STATUSES = ["queued", "running", "awaiting-approval", "done"];

class ChannelState {
  constructor(file = STATE_FILE) {
    this.file = file;
    this.data = this._read();
  }
  _read() {
    let d;
    try { d = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { d = {}; }
    return { seen: d.seen || {}, offsets: d.offsets || {}, queue: Array.isArray(d.queue) ? d.queue : [], notices: d.notices || {} };
  }
  _write(data) { atomicWrite(this.file, JSON.stringify(data) + "\n"); }
  save() { this._write(this.data); }

  // Apply a mutation to a copy; persist; only then adopt it. A failed write leaves
  // memory and disk as they were.
  _commit(mutate) {
    const next = JSON.parse(JSON.stringify(this.data));
    const result = mutate(next);
    this._write(next);
    this.data = next;
    return result;
  }

  isSeen(accountKey, eventId) {
    const ring = this.data.seen[accountKey] || [];
    return ring.includes(String(eventId));
  }

  // Returns false (and writes nothing) if the event was already accepted.
  accept({ accountKey, eventId, item, offset }) {
    if (eventId != null && this.isSeen(accountKey, eventId)) return false;
    this._commit((d) => {
      if (eventId != null) {
        const ring = d.seen[accountKey] || (d.seen[accountKey] = []);
        ring.push(String(eventId));
        while (ring.length > RING) ring.shift();
      }
      if (item) d.queue.push({ ...item, status: "queued", acceptedAt: item.acceptedAt || new Date().toISOString() });
      if (offset !== undefined) d.offsets[accountKey] = offset;
    });
    return true;
  }

  getOffset(accountKey) { return this.data.offsets[accountKey]; }
  setOffset(accountKey, value) { this._commit((d) => { d.offsets[accountKey] = value; }); }

  setStatus(runId, status) {
    if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
    this._commit((d) => { const it = d.queue.find((q) => q.runId === runId); if (it) it.status = status; });
  }

  // Patch bookkeeping fields of a queued item (pid, session metadata); the status
  // lifecycle stays with setStatus.
  update(runId, patch) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, "status")) throw new Error("use setStatus");
    this._commit((d) => { const it = d.queue.find((q) => q.runId === runId); if (it) Object.assign(it, patch); });
  }

  remove(predicate) {
    return this._commit((d) => { const before = d.queue.length; d.queue = d.queue.filter((q) => !predicate(q)); return before - d.queue.length; });
  }

  queue() { return this.data.queue.map((q) => ({ ...q })); }
  recoverable() { return this.queue().filter((q) => q.status === "queued"); }
  uncertain() { return this.queue().filter((q) => q.status === "running" || q.status === "awaiting-approval"); }

  // Small key/value for "last notice sent to sender" timestamps etc.
  getNotice(key) { return this.data.notices[key]; }
  setNotice(key, value) { this._commit((d) => { d.notices[key] = value; }); }
}

module.exports = { STATE_FILE, STATUSES, ChannelState };
