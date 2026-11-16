// Pairing store: who may talk to the channel daemon.
//
// An unknown sender gets a 6-char code; the operator approves it from the
// terminal (`bridge pairing approve <channel> <code>`). Approval is never done
// in-band by the sender. State: ~/.ai-browser-bridge/pairing.json (0600).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DIR } = require("../token");
const { atomicWrite, withLock } = require("../atomic");

const PAIRING_FILE = path.join(DIR, "pairing.json");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LEN = 6;
const PENDING_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_PER_CHANNEL = 20;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function load({ now = Date.now() } = {}) {
  let st;
  try { st = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf8")); } catch { st = {}; }
  const pending = Array.isArray(st.pending) ? st.pending : [];
  const approved = Array.isArray(st.approved) ? st.approved : [];
  // Expired pending entries are pruned from the returned view; the next mutation
  // persists the pruned state (reads never write, so they need no lock).
  const fresh = pending.filter((p) => now - Date.parse(p.createdAt || 0) < PENDING_TTL_MS);
  return { pending: fresh, approved };
}

function save(state) {
  atomicWrite(PAIRING_FILE, JSON.stringify(state, null, 2) + "\n");
}

const same = (a, b) => a.channel === b.channel && (a.accountId || "default") === (b.accountId || "default") && String(a.senderId) === String(b.senderId);

// Upsert a pending request. Returns { code, created }.
function request({ channel, accountId = "default", senderId, meta = {} }, lockOpts) {
  return withLock(PAIRING_FILE, () => {
  const st = load();
  const existing = st.pending.find((p) => same(p, { channel, accountId, senderId }));
  if (existing) { existing.meta = { ...existing.meta, ...meta }; save(st); return { code: existing.code, created: false }; }
  const taken = new Set(st.pending.map((p) => p.code));
  let code = generateCode();
  while (taken.has(code)) code = generateCode();
  const mine = st.pending.filter((p) => p.channel === channel);
  while (mine.length >= MAX_PENDING_PER_CHANNEL) {
    const oldest = mine.shift();
    st.pending.splice(st.pending.indexOf(oldest), 1);
  }
  st.pending.push({ channel, accountId, senderId: String(senderId), code, meta, createdAt: new Date().toISOString() });
  save(st);
  return { code, created: true };
  }, lockOpts);
}

function isApproved({ channel, accountId = "default", senderId }) {
  return load().approved.some((a) => same(a, { channel, accountId, senderId }));
}

// Operator approves a pending code. Returns the entry or null.
function approve(channel, code, lockOpts) {
  return withLock(PAIRING_FILE, () => {
  const st = load();
  const idx = st.pending.findIndex((p) => p.channel === channel && p.code === String(code).toUpperCase());
  if (idx === -1) return null;
  const [p] = st.pending.splice(idx, 1);
  st.approved = st.approved.filter((a) => !same(a, p));
  st.approved.push({ channel: p.channel, accountId: p.accountId, senderId: p.senderId, meta: p.meta, approvedAt: new Date().toISOString() });
  save(st);
  return { senderId: p.senderId, accountId: p.accountId, meta: p.meta || {} };
  }, lockOpts);
}

function revoke(channel, senderId, lockOpts) {
  return withLock(PAIRING_FILE, () => {
    const st = load();
    const before = st.approved.length;
    st.approved = st.approved.filter((a) => !(a.channel === channel && String(a.senderId) === String(senderId)));
    if (st.approved.length === before) return false;
    save(st);
    return true;
  }, lockOpts);
}

function metaLine(meta) {
  const m = meta || {};
  return Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ") : "";
}

function main(argv) {
  const sub = argv[0];
  if (sub === "list" || !sub) {
    const st = load();
    if (!st.pending.length) console.log("no pending pairing requests");
    for (const p of st.pending) console.log(`pending  ${p.channel.padEnd(10)} code ${p.code}  sender ${p.senderId}  ${metaLine(p.meta)}  (${p.createdAt})`);
    for (const a of st.approved) console.log(`approved ${a.channel.padEnd(10)} sender ${a.senderId}  ${metaLine(a.meta)}  (${a.approvedAt})`);
    return;
  }
  if (sub === "approve") {
    const [, channel, code] = argv;
    if (!channel || !code) { console.error("usage: bridge pairing approve <channel> <code>"); process.exitCode = 2; return; }
    const r = approve(channel, code);
    if (!r) { console.error(`no pending request on ${channel} with code ${code}`); process.exitCode = 1; return; }
    console.log(`approved ${channel} sender ${r.senderId} ${metaLine(r.meta)}`.trim());
    return;
  }
  if (sub === "revoke") {
    const [, channel, senderId] = argv;
    if (!channel || !senderId) { console.error("usage: bridge pairing revoke <channel> <senderId>"); process.exitCode = 2; return; }
    if (!revoke(channel, senderId)) { console.error(`${senderId} is not approved on ${channel}`); process.exitCode = 1; return; }
    console.log(`revoked ${channel} sender ${senderId}`);
    return;
  }
  console.error("usage: bridge pairing list | approve <channel> <code> | revoke <channel> <senderId>");
  process.exitCode = 2;
}

module.exports = { PAIRING_FILE, ALPHABET, generateCode, load, save, request, isApproved, approve, revoke, main };
