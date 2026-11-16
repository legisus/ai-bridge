// Who gets to run a task (dmPolicy) and how often (RateLimiter).
//
// dmPolicy truth table (known = in allowFrom, paired = approved in the pairing store):
//   pairing (default) | known run | paired run | unknown pair
//   allowlist         | known run | paired drop| unknown drop
//   open              | needs "*" in allowFrom, else behaves as allowlist
//   disabled          | drop everything
// Paired senders count only under "pairing", so approvals never widen a stricter mode.

const POLICIES = ["pairing", "allowlist", "open", "disabled"];

function decide({ policy = "pairing", allowFrom = [], senderId, paired = false }) {
  const list = (allowFrom || []).map(String);
  const known = list.includes(String(senderId));
  switch (policy) {
    case "disabled": return "drop";
    case "open": return list.includes("*") || known ? "run" : "drop";
    case "allowlist": return known ? "run" : "drop";
    case "pairing":
    default: return known || paired ? "run" : "pair";
  }
}

// Sliding-window counters: per sender, global, and a separate small bucket for
// unknown senders. Sender keys are kept in an LRU map bounded by maxSenders.
class RateLimiter {
  constructor({ perSender = 20, global = 200, unknown = 5, windowMs = 60000, maxSenders = 4096, now = Date.now } = {}) {
    Object.assign(this, { perSender, global, unknown, windowMs, maxSenders, now });
    this.senders = new Map();   // key -> timestamps[]
    this.globalHits = [];
    this.unknownHits = [];
  }
  _prune(arr, t) {
    while (arr.length && t - arr[0] >= this.windowMs) arr.shift();
    return arr;
  }
  allow(senderKey, { unknown = false } = {}) {
    const t = this.now();
    if (unknown) {
      const u = this._prune(this.unknownHits, t);
      if (u.length >= this.unknown) return false;
      u.push(t);
      return true;
    }
    const g = this._prune(this.globalHits, t);
    if (g.length >= this.global) return false;
    let hits = this.senders.get(senderKey);
    if (hits) this.senders.delete(senderKey); // re-insert → most recent
    hits = this._prune(hits || [], t);
    if (hits.length >= this.perSender) { this.senders.set(senderKey, hits); return false; }
    hits.push(t);
    this.senders.set(senderKey, hits);
    g.push(t);
    while (this.senders.size > this.maxSenders) this.senders.delete(this.senders.keys().next().value);
    return true;
  }
  trackedSenders() { return this.senders.size; }
  isTracked(key) { return this.senders.has(key); }
}

module.exports = { POLICIES, decide, RateLimiter };
