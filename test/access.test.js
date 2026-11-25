#!/usr/bin/env node
// Unit tests for server/access.js: the shape rules of the `access` message
// (until, browserSession, session, gen), the two access error strings and
// the CLI's recogniser for them.
const A = require("../server/access.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const bs = "a".repeat(32);
assert(A.normalizeAccess({ granted: true, until: null, gen: 3, session: "work-chrome", browserSession: bs }).granted === true, "granted indefinite");
assert(A.normalizeAccess({ granted: true, until: Date.now() + 60000, browserSession: bs }).granted === true, "granted timed future");
assert(A.normalizeAccess({ granted: true, until: Date.now() - 1, browserSession: bs }).reason === "bad_until", "until in the past → revoked");
for (const bad of [undefined, 0, NaN, "soon", "1700000000000"]) {
  assert(A.normalizeAccess({ granted: true, until: bad, browserSession: bs }).granted === false, `until ${String(bad)} → revoked`);
}
assert(A.normalizeAccess({ granted: true, until: null }).reason === "bad_browser_session", "missing browserSession → revoked");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: "A".repeat(32) }).granted === false, "uppercase browserSession rejected");
assert(A.normalizeAccess({ granted: "true", until: null, browserSession: bs }).reason === "not_granted", "granted must be boolean true");
const sess = A.normalizeAccess({ granted: true, until: null, browserSession: bs, session: "x\u0007y".padEnd(60, "z") });
assert(sess.session.length === 40 && !/\u0007/.test(sess.session) && sess.session.startsWith("xy"), "session sanitised and truncated");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: bs }).session === "chrome", "session defaults to chrome");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: bs, gen: -1 }).gen === 0 && A.normalizeAccess({ gen: 7 }).gen === 7, "gen normalised");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: bs }).reason === null, "reason null when granted");
assert(A.stateOf(null) === "not_granted" && A.stateOf(A.normalizeAccess({ granted: false, until: null, browserSession: bs })) === "revoked", "stateOf");
assert(A.stateOf(A.normalizeAccess({ granted: true, until: null, browserSession: bs })) === "granted", "stateOf granted");
assert(A.isGrantedNow({ granted: true, until: Date.now() + 1000 }) && !A.isGrantedNow({ granted: true, until: 5 }, 10), "isGrantedNow honours until");
assert(A.ACCESS_REVOKED("work-chrome") === 'access_revoked: access revoked by user (session "work-chrome")', "revoked string");
assert(A.ACCESS_NOT_GRANTED("chrome") === 'access_not_granted: access not granted yet (session "chrome")', "not granted string");
assert(A.isAccessError(A.ACCESS_REVOKED("x")) && A.isAccessError(A.ACCESS_NOT_GRANTED("x")) && !A.isAccessError("extension not connected") && !A.isAccessError(null), "isAccessError");

console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll access tests passed.");
process.exit(failures ? 1 : 0);
