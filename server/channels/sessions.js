// Session store: named, persistent Claude conversations owned by one messenger sender.
//
// ~/.ai-browser-bridge/channels-sessions.json (0600; atomic write under a file lock,
// like pairing.json):
//   { sessions: [Row], current: { ownerKey: sessionId }, last: { ownerKey: { text, sessionId|"agent" } } }
// Each row has a directory ~/.ai-browser-bridge/sessions/<id>/ (0700) that is the cwd and
// outbox of every turn. `gen` is the execution generation: pause/stop bump it durably
// before anything is aborted, and a turn may only run while its gen still matches.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DIR } = require("../token");
const { atomicWrite, withLock } = require("../atomic");

const SESSIONS_FILE = path.join(DIR, "channels-sessions.json");
const SESSIONS_DIR = path.join(DIR, "sessions");
const MODELS = { opus: "claude-opus-5-5", fable: "claude-fable-5-1", haiku: "claude-haiku-5-5" };
const DEFAULT_MODEL_KEY = "fable";   // every session runs on Fable unless /new names another model
const RESERVED = ["agent", "all", "none"];
const MAX_PER_SENDER = 10;
const NAME_RE = /^[a-z0-9_-]{1,24}$/;
const RECENT_KEEP = 3;
const DECLINED_KEEP = 5;

const USAGE_RE = /^@([A-Za-z0-9_-]{1,24})\s*$/;
const ROUTE_RE = /^@([A-Za-z0-9_-]{1,24})\s+([\s\S]*\S[\s\S]*)$/;

function normalizeName(raw) {
  const s = String(raw == null ? "" : raw).toLowerCase();
  if (!NAME_RE.test(s) || RESERVED.includes(s)) return null;
  return s;
}

function ownerKey({ channel, accountId, senderId }) {
  return `${channel}:${accountId || "default"}:${senderId}`;
}

// `@@…` → literal text; `@name` → usage; `@name body` → session; else plain.
function parseRoute(text) {
  const s = String(text == null ? "" : text);
  if (s.startsWith("@@")) return { kind: "plain", text: s.slice(1) };
  let m = USAGE_RE.exec(s);
  if (m) return { kind: "usage", name: m[1].toLowerCase() };
  m = ROUTE_RE.exec(s);
  if (m) return { kind: "session", name: m[1].toLowerCase(), text: m[2].trim() };
  return { kind: "plain", text: s };
}

const sameOwner = (row, owner) => row.channel === owner.channel && (row.accountId || "default") === (owner.accountId || "default") && String(row.senderId) === String(owner.senderId);

class SessionStore {
  constructor(file = SESSIONS_FILE, { dir = SESSIONS_DIR, now = Date.now } = {}) {
    this.file = file;
    this.dir = dir;
    this.now = now;
  }

  // A missing file is an empty store. Anything else (unreadable, corrupt) throws: silently
  // routing to the agent, or overwriting the file on the next write, would lose sessions.
  _read() {
    let raw;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) {
      if (e.code === "ENOENT") return { sessions: [], current: {}, last: {} };
      throw new Error(`${path.basename(this.file)} unreadable: ${e.message}`);
    }
    let d;
    try { d = JSON.parse(raw); } catch (e) { throw new Error(`${path.basename(this.file)} is corrupt (invalid JSON: ${e.message}); fix or move it before restarting`); }
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${path.basename(this.file)} is corrupt (expected an object)`);
    return { sessions: Array.isArray(d.sessions) ? d.sessions : [], current: d.current || {}, last: d.last || {} };
  }
  _write(d) { atomicWrite(this.file, JSON.stringify(d) + "\n"); }
  _mutate(fn) { return withLock(this.file, () => { const d = this._read(); const out = fn(d); this._write(d); return out; }); }
  _iso() { return new Date(this.now()).toISOString(); }

  dirOf(id) { return path.join(this.dir, String(id).replace(/[^0-9a-f]/g, "")); }

  _rows(d, owner) { return d.sessions.filter((s) => sameOwner(s, owner)); }
  _find(d, owner, sel) {
    const rows = this._rows(d, owner);
    if (sel.id != null) return rows.find((s) => s.id === sel.id) || null;
    const name = String(sel.name || "").toLowerCase();
    return rows.find((s) => s.name === name) || null;
  }
  _copy(row) { return row ? JSON.parse(JSON.stringify(row)) : null; }

  create(owner, rawName, modelKey = DEFAULT_MODEL_KEY) {
    const name = normalizeName(rawName);
    if (!name) throw new Error("invalid session name");
    const key = String(modelKey || DEFAULT_MODEL_KEY).toLowerCase();
    const model = Object.prototype.hasOwnProperty.call(MODELS, key) ? MODELS[key] : null;
    if (!model) throw new Error("unknown model");
    return this._mutate((d) => {
      const rows = this._rows(d, owner);
      if (rows.some((s) => s.name === name)) throw new Error("session name already used");
      if (rows.length >= MAX_PER_SENDER) throw new Error(`too many sessions (max ${MAX_PER_SENDER})`);
      let id = crypto.randomBytes(6).toString("hex");
      while (d.sessions.some((s) => s.id === id)) id = crypto.randomBytes(6).toString("hex");
      const ts = this._iso();
      const row = {
        id, name, channel: owner.channel, accountId: owner.accountId || "default", senderId: String(owner.senderId), chatId: String(owner.chatId),
        claudeSessionId: crypto.randomUUID(), model, state: "active", gen: 1, started: false, turns: 0, recent: [], declined: [],
        createdAt: ts, lastUsedAt: ts,
      };
      fs.mkdirSync(this.dirOf(id), { mode: 0o700, recursive: true });
      d.sessions.push(row);
      d.current[ownerKey(owner)] = id;
      return this._copy(row);
    });
  }

  list(owner) { return this._rows(this._read(), owner).map((s) => this._copy(s)); }
  get(owner, sel) { return this._copy(this._find(this._read(), owner, sel)); }
  current(owner) {
    const d = this._read();
    const id = d.current[ownerKey(owner)];
    return id ? this._copy(this._find(d, owner, { id })) : null;
  }

  setCurrent(owner, id) {
    this._mutate((d) => {
      if (id == null) { delete d.current[ownerKey(owner)]; return; }
      if (!this._find(d, owner, { id })) throw new Error("no such session");
      d.current[ownerKey(owner)] = id;
    });
  }

  pause(owner, id) {
    return this._mutate((d) => { const s = this._find(d, owner, { id }); if (!s) return null; s.gen += 1; s.state = "paused"; return this._copy(s); });
  }
  resume(owner, id) {
    return this._mutate((d) => { const s = this._find(d, owner, { id }); if (!s) return null; s.state = "active"; return this._copy(s); });
  }
  stop(owner, id) {
    return this._mutate((d) => {
      const s = this._find(d, owner, { id });
      if (!s) return null;
      d.sessions = d.sessions.filter((x) => x.id !== s.id);
      if (d.current[ownerKey(owner)] === s.id) delete d.current[ownerKey(owner)];
      return this._copy(s);
    });
  }
  pauseAll(owner) {
    return this._mutate((d) => {
      const rows = this._rows(d, owner);
      for (const s of rows) { s.gen += 1; s.state = "paused"; }
      delete d.current[ownerKey(owner)];
      return rows.length;
    });
  }

  // Remember the sender's last message and, for a session, its context. Returns the
  // session's `recent` as it was BEFORE this text (the classifier's context).
  recordInbound(owner, { text, sessionId }) {
    return this._mutate((d) => {
      d.last[ownerKey(owner)] = { text: String(text), sessionId: sessionId || "agent" };
      if (!sessionId || sessionId === "agent") return [];
      const s = this._find(d, owner, { id: sessionId });
      if (!s) return [];
      const before = (s.recent || []).slice();
      s.recent = before.concat([String(text)]).slice(-RECENT_KEEP);
      return before;
    });
  }
  last(owner) { const l = this._read().last[ownerKey(owner)]; return l ? { ...l } : null; }

  markStarted(id) {
    return this._mutate((d) => { const s = d.sessions.find((x) => x.id === id); if (!s) return null; s.started = true; return this._copy(s); });
  }

  // Compare-and-swap on gen: a turn that finished after a pause/stop changes nothing.
  // Never writes `state`.
  complete(id, gen, { declined = [], countTurn = true } = {}) {
    return this._mutate((d) => {
      const s = d.sessions.find((x) => x.id === id);
      if (!s || s.gen !== gen) return false;
      if (countTurn) s.turns += 1;
      s.lastUsedAt = this._iso();
      s.declined = (s.declined || []).concat((declined || []).map(String)).slice(-DECLINED_KEEP);
      return true;
    });
  }
}

module.exports = { SESSIONS_FILE, SESSIONS_DIR, MODELS, DEFAULT_MODEL_KEY, RESERVED, MAX_PER_SENDER, NAME_RE, RECENT_KEEP, DECLINED_KEEP, normalizeName, ownerKey, parseRoute, SessionStore };
