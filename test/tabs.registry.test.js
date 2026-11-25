#!/usr/bin/env node
// Unit tests for server/tabs.js: the registry of tabs the bridge opened —
// pending creations, browser-session binding, lastCmdAt, selection for
// bridge closeTabs, reconciliation against the extension, persistence.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openRegistry } = require("../server/tabs.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-tabs-"));
const file = path.join(dir, "tabs.json");
const R = openRegistry(file);
const bs1 = "1".repeat(32), bs2 = "2".repeat(32);
assert(R.browserSession === null && R.list().current.length === 0, "fresh registry is empty");
R.setBrowserSession(bs1);
R.addPending({ reqId: "r1", runId: "run1", client: "bridge agent", origin: "https://example.com", createdAt: 1000, browserSession: bs1 });
assert(R.pendingForRun("run1") === 1 && R.completePending("zzz", 5) === null, "pending counted; unknown reqId → null");
const row = R.completePending("r1", 501);
assert(row.tabId === 501 && row.lastCmdAt === 1000 && row.status === "live" && row.reqId === "r1" && R.pendingForRun("run1") === 0, "completePending: lastCmdAt = createdAt");
R.addPending({ reqId: "r2", runId: null, client: "zsh", origin: "https://b.example", createdAt: 2000, browserSession: bs1 });
R.completePending("r2", 502);
assert(JSON.stringify(R.select({ olderThanMs: 500, now: 1800 })) === "[501]", "--older-than by lastCmdAt (never-touched tab selected by createdAt)");
R.touch(501, 5000);
assert(JSON.stringify(R.select({ olderThanMs: 500, now: 5100 })) === "[502]" && JSON.stringify(R.select({ olderThanMs: 500, now: 6000 })) === "[501,502]", "touch refreshes lastCmdAt");
assert(JSON.stringify(R.select({ client: "zsh" })) === "[502]" && JSON.stringify(R.select({ runId: "run1" })) === "[501]" && R.select({}).length === 0, "select by client / run / nothing");
assert(JSON.stringify(R.select({ client: "zsh", runId: "run1" })) === "[]", "filters are AND-ed");
assert(JSON.stringify(R.rowsForRun("run1").map((r) => r.tabId)) === "[501]", "rowsForRun");
R.setBrowserSession(bs2);
assert(R.select({ client: "zsh" }).length === 0 && R.list().dead.length === 2 && R.list().current.length === 0, "rows from another browser session are dead, never selected");
assert(R.rowsForRun("run1").length === 0 && R.touch(501, 1) === undefined && R.list().dead[0].lastCmdAt === 5000, "dead rows are never acted on");
R.addPending({ reqId: "r3", runId: "run2", client: "c", origin: "o", createdAt: 1, browserSession: bs2 });
R.completePending("r3", 7);
assert(R.reconcile([7]).dropped === 2 && R.list().dead.length === 0 && R.list().current.length === 1, "reconcile prunes dead rows, keeps listed live ones");
assert(R.reconcile([]).dropped === 1 && R.list().current.length === 0, "reconcile drops current rows the extension no longer owns");
R.addPending({ reqId: "r4", runId: "run3", client: "c", origin: "o", createdAt: 1, browserSession: bs2 });
R.completePending("r4", 8);
assert(R.markRetained("run3") === 1 && R.rowsForRun("run3").length === 0 && R.list().current[0].status === "retained", "markRetained");
assert(R.select({ runId: "run3" }).length === 0, "retained rows are not selected for automatic cleanup");
assert(JSON.stringify(R.select({ runId: "run3", includeRetained: true })) === "[8]" && JSON.stringify(R.select({ client: "c", includeRetained: true })) === "[8]", "explicit selection can include retained rows");
R.touch(8, 99);
assert(R.list().current[0].lastCmdAt === 99, "touch works on retained rows");
assert(R.remove([8, 9999]) === 1 && R.list().current.length === 0, "remove returns the count removed");
R.addPending({ reqId: "r5", runId: "run4", client: "c", origin: "o", createdAt: 1, browserSession: bs2 });
R.dropPending("r5");
assert(R.pendingForRun("run4") === 0 && R.completePending("r5", 9) === null, "dropPending");
// persistence
R.addPending({ reqId: "r6", runId: null, client: "c", origin: "o", createdAt: 1, browserSession: bs2 });
R.completePending("r6", 9);
R.addPending({ reqId: "r7", runId: "run5", client: "c", origin: "o", createdAt: 1, browserSession: bs2 });
const R2 = openRegistry(file);
assert(R2.browserSession === bs2 && R2.list().current.length === 1 && R2.list().current[0].tabId === 9 && R2.pendingForRun("run5") === 1, "reloaded from disk (rows and pending)");
assert((fs.statSync(file).mode & 0o777) === 0o600, "tabs.json mode 600");
assert(R.originOf("https://a.example/x?y=1") === "https://a.example" && R.originOf("nope") === "unknown" && R.originOf(undefined) === "unknown", "originOf");
// corrupt file
fs.writeFileSync(file, "{not json");
const logged = [];
const R3 = openRegistry(file, { log: (l) => logged.push(l) });
assert(R3.list().current.length === 0 && logged.length === 1 && /unreadable/.test(logged[0]) && fs.readdirSync(dir).some((f) => /^tabs\.json\.corrupt-\d+$/.test(f)), "corrupt tabs.json → empty registry, file kept aside, logged once");
R3.setBrowserSession(bs1);
assert(JSON.parse(fs.readFileSync(file, "utf8")).browserSession === bs1, "registry writes a fresh file after a corrupt one");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll tab-registry tests passed.");
process.exit(failures ? 1 : 0);
