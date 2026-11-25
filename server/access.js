// Access contract shared by the relay and the CLI (design: docs/superpowers/
// specs/2026-11-21-docker-isolated-access-design.md, "Wire contract").
//
// The extension tells the relay whether the user has granted it the browser
// session with an `access` message; this module holds the one normalisation
// rule for that message (fail closed on any malformed field), the state it
// maps to, and the two error strings the CLI recognises verbatim (exit 8).
"use strict";

const SESSION_MAX = 40;
const BROWSER_SESSION_RE = /^[0-9a-f]{32}$/;

function cleanSession(v) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, SESSION_MAX);
  return s || "chrome";
}

// msg → { granted, until, session, gen, browserSession, reason }.
// granted is true only when every field has the right shape; `reason` names
// the first failing one (not_granted | bad_until | bad_browser_session).
function normalizeAccess(msg, now = Date.now()) {
  const m = msg && typeof msg === "object" ? msg : {};
  const session = cleanSession(m.session);
  const gen = Number.isInteger(m.gen) && m.gen >= 0 ? m.gen : 0;
  const browserSession = typeof m.browserSession === "string" && BROWSER_SESSION_RE.test(m.browserSession) ? m.browserSession : null;
  let reason = null;
  let until = null;
  if (m.granted !== true) reason = "not_granted";
  else if (browserSession === null) reason = "bad_browser_session";
  else if (m.until === null) until = null;
  else if (typeof m.until === "number" && Number.isFinite(m.until) && m.until > now) until = m.until;
  else reason = "bad_until";
  return { granted: reason === null, until, session, gen, browserSession, reason };
}

function isGrantedNow(a, now = Date.now()) {
  return !!(a && a.granted && (a.until === null || a.until > now));
}

function stateOf(a, now = Date.now()) {
  if (a == null) return "not_granted";
  return isGrantedNow(a, now) ? "granted" : "revoked";
}

const ACCESS_REVOKED = (session) => `access_revoked: access revoked by user (session "${session}")`;
const ACCESS_NOT_GRANTED = (session) => `access_not_granted: access not granted yet (session "${session}")`;
const isAccessError = (s) => typeof s === "string" && /^access_(revoked|not_granted):/.test(s);

module.exports = { normalizeAccess, isGrantedNow, stateOf, ACCESS_REVOKED, ACCESS_NOT_GRANTED, isAccessError, cleanSession, BROWSER_SESSION_RE };
