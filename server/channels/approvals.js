// Approval records: one tap (or one text reply) per risky operation, before it runs.
//
// A record binds consent to the operation (run, kind, digest) and to the
// conversation (channel, account, chat, sender). Button data carries only a
// locator — `ab1:<kind>:<a|d>:<id>` — never state or secrets. Records are
// single-use and expire after ttlMs; denied, expired, aborted all resolve "denied".
const crypto = require("crypto");

const PREFIX = "ab1";
const DATA_RE = /^ab1:([a-z]+):([ad]):([0-9a-f]{16})$/;

function encode(kind, decision, id) { return `${PREFIX}:${kind}:${decision}:${id}`; }

// null for data that is not ours; { invalid: true } for our prefix with a bad shape.
function decode(data) {
  const s = String(data || "");
  if (!s.startsWith(PREFIX + ":")) return null;
  const m = DATA_RE.exec(s);
  if (!m) return { invalid: true };
  return { kind: m[1], decision: m[2], id: m[3] };
}

function digestOf(text) { return crypto.createHash("sha256").update(String(text)).digest("hex"); }

class Approvals {
  constructor({ ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.records = new Map(); // id -> record
  }

  create({ runId, kind, digest, channel, accountId = "default", chatId, senderId, signal }) {
    const id = crypto.randomBytes(8).toString("hex");
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const rec = { id, runId, kind, digest, channel, accountId, chatId: String(chatId), senderId: String(senderId),
      createdAt: this.now(), resolved: null, _resolve: resolveFn };
    rec._timer = setTimeout(() => this._settle(rec, "denied"), this.ttlMs);
    if (rec._timer.unref) rec._timer.unref();
    if (signal) {
      if (signal.aborted) this._settle(rec, "denied");
      else signal.addEventListener("abort", () => this._settle(rec, "denied"), { once: true });
    }
    this.records.set(id, rec);
    return { id, promise };
  }

  _settle(rec, decision) {
    if (rec.resolved) return;
    rec.resolved = decision;
    clearTimeout(rec._timer);
    rec._resolve(decision);
  }

  _expired(rec) { return this.now() - rec.createdAt >= this.ttlMs; }

  // "approved" | "denied" | "stale" | "forbidden"
  resolve({ id, actorId, channel, accountId = "default", chatId, kind, decision }) {
    const rec = this.records.get(id);
    if (!rec) return "stale";
    // Ownership first: a settled or expired record must not tell another conversation
    // anything (not even that it existed). `kind` is checked when the caller knows it
    // (button data); the /approve text fallback passes undefined.
    if (String(actorId) !== rec.senderId || channel !== rec.channel || (accountId || "default") !== rec.accountId ||
        String(chatId) !== rec.chatId || (kind !== undefined && kind !== rec.kind)) return "forbidden";
    if (rec.resolved) return "stale";
    if (this._expired(rec)) { this._settle(rec, "denied"); return "stale"; }
    const d = decision === "a" || decision === "approved" || decision === "yes" ? "approved" : "denied";
    this._settle(rec, d);
    return d;
  }

  pendingFor(runId) {
    return [...this.records.values()].filter((r) => r.runId === runId && !r.resolved && !this._expired(r))
      .map(({ id, kind, digest, chatId, senderId, createdAt }) => ({ id, kind, digest, chatId, senderId, createdAt }));
  }

  close() { for (const r of this.records.values()) clearTimeout(r._timer); }
}

module.exports = { PREFIX, encode, decode, digestOf, Approvals };
