#!/usr/bin/env node
// Tab hygiene end to end: the relay records every tab it opened (tabs.json),
// independently of the CLI that asked; run leases close a run's tabs when the
// supervisor ends or dies; `bridge tabs` / `bridge closeTabs` work from the
// registry; nothing closes while access is not granted.
const fs = require("fs");
const path = require("path");
const { startRelay, fakeExtension, cli, leaseSocket, randomHex32, sleep } = require("./helpers/relay");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const readReg = (relay) => JSON.parse(fs.readFileSync(path.join(relay.home, "tabs.json"), "utf8"));

(async () => {
  let relay = await startRelay({ env: { BRIDGE_DRAIN_MS: "300" } });
  try {
    // ---- registry bookkeeping (Task 6) ------------------------------------
    const bs = randomHex32();
    let ext = await fakeExtension(relay, { browserSession: bs, hold: (cmd, p) => cmd === "newTab" && /hold|slow/.test(String(p.url)) });
    await sleep(150);
    assert(readReg(relay).browserSession === bs, "registry records the browser session from the access message");
    assert(ext.received.some((m) => m.cmd === "status"), "server issued its own status for reconciliation after access");
    assert(/ srv-\d+ server - cmd status /.test(fs.readFileSync(relay.logFile, "utf8")), "internal requests logged with srv- ids and client server");

    // CLI disconnects before the extension answers
    const p = cli(relay, ["newTab", '{"url":"https://hold.example/x"}', "--timeout", "300"], { env: { AI_BRIDGE_CLIENT: "t" } });
    const heldCmd = await ext.waitFor("newTab");
    const timedOut = await p; // CLI timed out and closed its socket
    assert(timedOut.code === 3, "CLI timed out (exit 3)");
    assert(readReg(relay).pending.some((x) => x.reqId === heldCmd.id && x.client === "t" && x.origin === "https://hold.example"), "creation recorded as pending when forwarded");
    ext.respond(heldCmd.id, { ok: true, result: { id: 777, windowId: 1 } });
    ext.agentTabs.push(777);
    await sleep(100);
    let reg = readReg(relay);
    const row = reg.tabs.find((r) => r.tabId === 777);
    assert(row && row.client === "t" && row.origin === "https://hold.example" && row.lastCmdAt === row.createdAt && row.browserSession === bs && row.runId === null && reg.pending.length === 0, "late response after CLI disconnect still recorded");

    // failed creation
    await cli(relay, ["newTab", '{"url":"https://fail.example/"}', "--timeout", "3000"]);
    reg = readReg(relay);
    assert(!reg.tabs.some((r) => r.origin === "https://fail.example") && reg.pending.length === 0, "failed newTab leaves no row and no pending entry");

    // touch, closeTab, user tab untouched
    await cli(relay, ["eval", '{"tabId":777,"code":"1"}', "--timeout", "3000"]);
    reg = readReg(relay);
    assert(reg.tabs.find((r) => r.tabId === 777).lastCmdAt > row.createdAt, "a command on the tab refreshes lastCmdAt");
    const before = reg.tabs.length;
    await cli(relay, ["closeTab", '{"tabId":4242}', "--timeout", "3000"]);
    assert(readReg(relay).tabs.length === before && ext.received.some((m) => m.cmd === "closeTab" && m.params.tabId === 4242), "closeTab on an unknown (user) tab is forwarded as before and leaves the registry untouched");
    await cli(relay, ["closeTab", '{"tabId":777}', "--timeout", "3000"]);
    assert(!readReg(relay).tabs.some((r) => r.tabId === 777), "closeTab removes the row");

    // run id and client on the row
    await cli(relay, ["newTab", '{"url":"https://a.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runZ00000001", AI_BRIDGE_CLIENT: "bridge agent" } });
    reg = readReg(relay);
    assert(reg.tabs.length === 1 && reg.tabs[0].runId === "runZ00000001" && reg.tabs[0].client === "bridge agent" && reg.tabs[0].origin === "https://a.example", "row carries runId, client, origin");

    // reconciliation on status
    ext.agentTabs = [];
    await cli(relay, ["status", "--timeout", "3000"]);
    assert(readReg(relay).tabs.length === 0, "status.agentTabs reconciles the registry");

    // relay restart loads and reconciles tabs.json
    await cli(relay, ["newTab", '{"url":"https://keep.example/"}', "--timeout", "3000"]);
    const keptId = readReg(relay).tabs[0].tabId;
    ext.close();
    relay.stop({ keepHome: true });
    const home = relay.home;
    relay = await startRelay({ home, env: { BRIDGE_DRAIN_MS: "300" } });
    assert(readReg(relay).tabs.some((r) => r.tabId === keptId), "tabs.json survives a relay restart");
    ext = await fakeExtension(relay, { browserSession: bs, agentTabs: [keptId] });
    await sleep(150); // the server's own status after access reconciles
    assert(readReg(relay).tabs.some((r) => r.tabId === keptId), "same browser session: row kept after reconciliation");
    ext.close();
    ext = await fakeExtension(relay, { browserSession: randomHex32() });
    await sleep(150);
    assert(!readReg(relay).tabs.some((r) => r.tabId === keptId), "different browser session after restart: dead row pruned");

    // ---- run leases (Task 7) ---------------------------------------------
    ext = await fakeExtension(relay, { browserSession: bs, hold: (cmd, p) => cmd === "newTab" && /slow/.test(String(p.url)) });
    await sleep(150);
    const runEnv = (runId) => ({ env: { AI_BRIDGE_RUN_ID: runId, AI_BRIDGE_CLIENT: "bridge agent" } });
    // lease closes without runEnd → closeTabs with exactly the run's live tabs after the drain; a creation answered during the drain is included
    let lease = await leaseSocket(relay, { runId: "runA00000001", client: "bridge agent" });
    assert(/run runA00000001 registered \(bridge agent, keepTabs=false\)/.test(fs.readFileSync(relay.logFile, "utf8")), "run registration logged");
    const a1 = (await cli(relay, ["newTab", '{"url":"https://a.example/1"}', "--timeout", "3000"], runEnv("runA00000001"))).json.id;
    const slow = cli(relay, ["newTab", '{"url":"https://slow.example/2"}', "--timeout", "3000"], runEnv("runA00000001"));
    const slowCmd = await ext.waitFor("newTab");
    const b1 = (await cli(relay, ["newTab", '{"url":"https://b.example/"}', "--timeout", "3000"], runEnv("runB00000001"))).json.id;
    lease.ws.terminate(); // simulated supervisor death
    await sleep(100);
    const close1P = ext.waitFor("closeTabs", { timeoutMs: 2000 });
    ext.respond(slowCmd.id, { ok: true, result: { id: 902, windowId: 1 } }); ext.agentTabs.push(902); // test-chosen ids are 900+, the handler's counter stays at 100+
    await slow;
    const close1 = await close1P;
    assert(JSON.stringify([...close1.params.tabIds].sort()) === JSON.stringify([a1, 902].sort()), "lease loss → closeTabs with exactly the run's tabs, including one answered during the drain");
    await sleep(100);
    assert(!readReg(relay).tabs.some((r) => r.runId === "runA00000001") && readReg(relay).tabs.some((r) => r.tabId === b1), "closed rows removed, other run's tab untouched");
    assert(/run runA00000001 ended \(lease_closed\): opened 2 closed 2 retained 0 kept 0/.test(fs.readFileSync(relay.logFile, "utf8")), "run end logged with counts");

    // runEnd with keepTabs sends nothing; ack carries counts
    lease = await leaseSocket(relay, { runId: "runK00000001", keepTabs: true });
    await cli(relay, ["newTab", '{"url":"https://k.example/"}', "--timeout", "3000"], runEnv("runK00000001"));
    let closeCount = ext.received.filter((m) => m.cmd === "closeTabs").length;
    const ack = await lease.end();
    assert(ack.ok === true && ack.tabs.opened === 1 && ack.tabs.kept === 1 && ack.tabs.closed === 0 && ext.received.filter((m) => m.cmd === "closeTabs").length === closeCount, "runEnd with keepTabs: no closeTabs, counts in the ack");
    assert(readReg(relay).tabs.some((r) => r.runId === "runK00000001" && r.status === "live"), "kept tab stays live in the registry");

    // run ended while revoked → retained, no closeTabs
    lease = await leaseSocket(relay, { runId: "runR00000001" });
    await cli(relay, ["newTab", '{"url":"https://r.example/"}', "--timeout", "3000"], runEnv("runR00000001"));
    ext.sendAccess({ granted: false, until: null, gen: 9 }); await sleep(100);
    const ack2 = await lease.end();
    assert(ack2.tabs.retained === 1 && ack2.tabs.closed === 0 && ext.received.filter((m) => m.cmd === "closeTabs").length === closeCount, "revoked at run end → retained, no closeTabs");
    assert(readReg(relay).tabs.find((r) => r.runId === "runR00000001").status === "retained", "row marked retained");
    ext.sendAccess({ granted: true, until: null, gen: 10 }); await sleep(150);

    // late creation after the drain
    lease = await leaseSocket(relay, { runId: "runL00000001" });
    const late = cli(relay, ["newTab", '{"url":"https://slow.example/late"}', "--timeout", "5000"], runEnv("runL00000001"));
    const lateCmd = await ext.waitFor("newTab");
    const journalFile = path.join(relay.home, "journal.jsonl"); // written with fs: journal.js binds AI_BRIDGE_HOME at require time
    fs.appendFileSync(journalFile, JSON.stringify({ runId: "runL00000001", startedAt: new Date().toISOString(), verdict: "pass", tabsOpened: 0, tabsClosed: 0, tabsRetained: 0, keptTabs: 0 }) + "\n");
    const ack3 = await lease.end(); // drain 300 ms expires with the creation pending
    assert(ack3.tabs.opened === 0 && readReg(relay).pending.some((x) => x.runId === "runL00000001"), "pending creation survives the drain deadline");
    const close3P = ext.waitFor("closeTabs", { timeoutMs: 2000 });
    ext.respond(lateCmd.id, { ok: true, result: { id: 903, windowId: 1 } }); ext.agentTabs.push(903);
    await late;
    const close3 = await close3P;
    assert(JSON.stringify(close3.params.tabIds) === "[903]", "late creation closed by a second closeTabs");
    await sleep(100);
    const jrec = fs.readFileSync(journalFile, "utf8").trim().split("\n").map(JSON.parse).find((r) => r.runId === "runL00000001");
    assert(jrec.tabsOpened === 1 && jrec.tabsClosed === 1 && jrec.late === true, "journal record patched in place with late: true");
    assert(/run runL00000001 late tab 903 closed/.test(fs.readFileSync(relay.logFile, "utf8")), "late closure logged");

    // stale browser session never included
    const keptRow = readReg(relay).tabs.find((r) => r.runId === "runK00000001");
    const stale = await fakeExtension(relay, { browserSession: randomHex32() }); await sleep(150); // supersedes `ext`; its status reports no agentTabs
    assert(readReg(relay).tabs.every((r) => r.tabId !== keptRow.tabId), "rows of the old browser session are pruned on reconciliation");
    await cli(relay, ["closeTabs", '{"tabIds":[' + keptRow.tabId + ']}', "--timeout", "3000"]);
    assert(stale.received.some((m) => m.cmd === "closeTabs") && !readReg(relay).tabs.some((r) => r.tabId === keptRow.tabId), "a stale row is never resurrected");

    // duplicate run refused; lease socket still serves requests; runEnd for an unknown run
    lease = await leaseSocket(relay, { runId: "runD00000001" });
    let dup = null; try { await leaseSocket(relay, { runId: "runD00000001" }); } catch (e) { dup = e; }
    assert(dup && /already live/.test(dup.message), "a run for a live runId is refused");
    lease.send({ type: "request", id: "feedfeedfeedfeed", cmd: "ping", params: {}, meta: { client: "lease" } });
    const pong = await new Promise((res) => lease.ws.once("message", (d) => res(JSON.parse(d))));
    assert(pong.type === "response" && pong.ok && pong.result.pong === true, "ordinary requests on a lease socket are served");
    lease.send({ type: "runEnd", runId: "runNOPE00001" });
    const unknown = await new Promise((res) => lease.ws.once("message", (d) => res(JSON.parse(d))));
    assert(unknown.type === "runEnd" && unknown.ok === false && /unknown run/.test(unknown.error), "runEnd for an unknown run → ok:false");
    await lease.end();
    let badRun = null; try { await leaseSocket(relay, { runId: "../x" }); } catch (e) { badRun = e; }
    assert(badRun && /bad runId/.test(badRun.message), "run with a bad runId is refused");

    // supervisor killed with SIGKILL (child process) drops the lease and the server cleans up (needs server/lease.js, Task 9)
    if (fs.existsSync(path.join(__dirname, "..", "server", "lease.js"))) {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "server", "lease.js"))}).openLease({ runId: "runX00000001", client: "child" }).then(() => setInterval(() => {}, 1000))`],
        { env: { ...process.env, BRIDGE_PORT: String(relay.port), AI_BRIDGE_HOME: relay.home }, stdio: "ignore" });
      for (let i = 0; i < 50 && !/run runX00000001 registered/.test(fs.readFileSync(relay.logFile, "utf8")); i++) await sleep(50);
      const x1 = (await cli(relay, ["newTab", '{"url":"https://x.example/"}', "--timeout", "3000"], runEnv("runX00000001"))).json.id;
      const closeXP = stale.waitFor("closeTabs", { timeoutMs: 2000 });
      child.kill("SIGKILL");
      const closeX = await closeXP;
      assert(JSON.stringify(closeX.params.tabIds) === JSON.stringify([x1]) && /run runX00000001 ended \(lease_closed\)/.test(fs.readFileSync(relay.logFile, "utf8")), "SIGKILLed supervisor: lease dropped, tabs closed");
    } else {
      console.log("SKIP  SIGKILL supervisor case (server/lease.js not yet present)");
    }

    // ---- bridge tabs / bridge closeTabs (Task 8) --------------------------
    ext = stale;
    await cli(relay, ["newTab", '{"url":"https://mine.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
    await cli(relay, ["newTab", '{"url":"https://other.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "other" } });
    let r = await cli(relay, ["tabs"]);
    assert(r.code === 0 && /mine\.example/.test(r.stdout) && /other\.example/.test(r.stdout) && /\bme\b/.test(r.stdout) && /live/.test(r.stdout), "bridge tabs lists current rows with client and status");
    r = await cli(relay, ["tabs", "--json"]);
    assert(Array.isArray(r.json.current) && r.json.current.length === 2 && Array.isArray(r.json.dead), "bridge tabs --json");
    r = await cli(relay, ["closeTabs", "--mine", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
    assert(r.code === 0 && r.json.closed.length === 1, "closeTabs --mine closes one tab");
    r = await cli(relay, ["tabs"]);
    assert(!r.stdout.includes("mine.example") && r.stdout.includes("other.example"), "closeTabs --mine closed only my tab");
    r = await cli(relay, ["closeTabs", "--older-than", "1", "--timeout", "3000"]);
    assert(r.code === 0 && r.json.closed.length === 0 && r.json.skipped.length === 0, "nothing older than a minute → empty result, no request");
    r = await cli(relay, ["closeTabs", "--older-than", "0", "--timeout", "3000"]);
    assert(r.code === 0 && r.json.closed.length === 1, "--older-than 0 selects the remaining tab");
    await cli(relay, ["newTab", '{"url":"https://run.example/"}', "--timeout", "3000"], runEnv("runQ00000001"));
    r = await cli(relay, ["closeTabs", "--run", "runQ00000001", "--timeout", "3000"]);
    assert(r.code === 0 && r.json.closed.length === 1 && (await cli(relay, ["tabs", "--json"])).json.current.length === 0, "closeTabs --run closes the run's tab");
    r = await cli(relay, ["closeTabs"]);
    assert(r.code === 2 && /usage/.test(r.stderr), "closeTabs without a selector → usage");
    r = await cli(relay, ["closeTabs", "--mine", "--run", "x"]);
    assert(r.code === 2, "two selectors → usage");
    r = await cli(relay, ["closeTabs", '{"tabIds":"nope"}', "--timeout", "3000"]);
    assert(r.code === 1 && /tabIds must be an array of integers/.test(r.stderr), "server refuses malformed tabIds");
    r = await cli(relay, ["closeTabs", '{"tabIds":[1, "2"]}', "--timeout", "3000"]);
    assert(r.code === 1 && /tabIds must be an array of integers/.test(r.stderr), "server refuses a non-integer id");
    await cli(relay, ["newTab", '{"url":"https://z.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
    ext.sendAccess({ granted: false, until: null, gen: 22 }); await sleep(100);
    r = await cli(relay, ["closeTabs", "--mine", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
    assert(r.code === 8, "closeTabs while revoked → exit 8 (gate unchanged)");
    r = await cli(relay, ["tabs"]);
    assert(r.code === 0 && /z\.example/.test(r.stdout), "bridge tabs works while revoked (reads the registry)");
    ext.sendAccess({ granted: true, until: null, gen: 23 }); await sleep(100);

    // ---- review fixes --------------------------------------------------------
    // (9) lastCmdAt is refreshed when a tab command is forwarded, not only when it succeeds
    ext.close();
    ext = await fakeExtension(relay, { browserSession: bs, hold: (cmd, p) => (cmd === "eval" && /hold/.test(String(p.code))) || (cmd === "closeTabs" && Array.isArray(p.tabIds) && p.tabIds.includes(1500)) });
    await sleep(150);
    const t9 = (await cli(relay, ["newTab", '{"url":"https://nine.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "nine" } })).json.id;
    const created9 = readReg(relay).tabs.find((x) => x.tabId === t9).lastCmdAt;
    await sleep(30);
    const heldEval = cli(relay, ["eval", JSON.stringify({ tabId: t9, code: "hold" }), "--timeout", "500"]);
    await ext.waitFor("eval");
    assert(readReg(relay).tabs.find((x) => x.tabId === t9).lastCmdAt > created9, "a pending command already refreshes lastCmdAt");
    await heldEval;
    await sleep(30);
    const beforeFail = readReg(relay).tabs.find((x) => x.tabId === t9).lastCmdAt;
    await cli(relay, ["newTab", '{"url":"https://fail.example/"}', "--timeout", "3000"]);
    ext.close();
    ext = await fakeExtension(relay, { browserSession: bs, agentTabs: [t9], handler: (cmd, p) => (cmd === "eval" ? { __error: "boom" } : cmd === "closeTabs" ? { closed: p.tabIds, skipped: [] } : cmd === "status" ? { agentTabs: [t9, 1500] } : cmd === "newTab" ? { id: 1500, windowId: 1 } : { pong: true }) });
    await sleep(150);
    await cli(relay, ["eval", JSON.stringify({ tabId: t9, code: "x" }), "--timeout", "3000"]);
    assert(readReg(relay).tabs.find((x) => x.tabId === t9).lastCmdAt > beforeFail, "a failed command refreshes lastCmdAt too");

    // (6) retained tabs can be closed explicitly once access is back
    lease = await leaseSocket(relay, { runId: "runT00000001" });
    await cli(relay, ["newTab", '{"url":"https://t.example/"}', "--timeout", "3000"], runEnv("runT00000001"));
    ext.sendAccess({ granted: false, until: null, gen: 30 }); await sleep(100);
    await lease.end();
    assert(readReg(relay).tabs.find((x) => x.runId === "runT00000001").status === "retained", "run ended while revoked → retained");
    ext.sendAccess({ granted: true, until: null, gen: 31 }); await sleep(150);
    r = await cli(relay, ["closeTabs", "--run", "runT00000001", "--timeout", "3000"]);
    assert(r.code === 0 && r.json.closed.length === 1 && !readReg(relay).tabs.some((x) => x.runId === "runT00000001"), "closeTabs --run closes a retained tab after re-grant");

    // (3) a creation that completes while closeTabs is in flight is still cleaned up
    ext.close();
    let heldClose = null;
    ext = await fakeExtension(relay, { browserSession: bs, hold: (cmd, p) => (cmd === "newTab" && /slow/.test(String(p.url))) || (cmd === "closeTabs" && !heldClose && (heldClose = true)) });
    await sleep(150);
    lease = await leaseSocket(relay, { runId: "runC00000001" });
    const c1 = (await cli(relay, ["newTab", '{"url":"https://c.example/1"}', "--timeout", "3000"], runEnv("runC00000001"))).json.id;
    const slowC = cli(relay, ["newTab", '{"url":"https://slow.example/c"}', "--timeout", "5000"], runEnv("runC00000001"));
    const slowCCmd = await ext.waitFor("newTab");
    const endP = lease.end(); // drain expires (300 ms) with the creation pending, then closeTabs [c1] goes out and is held
    const firstClose = await ext.waitFor("closeTabs", { timeoutMs: 2000 });
    assert(JSON.stringify(firstClose.params.tabIds) === JSON.stringify([c1]), "cleanup sends closeTabs for the tabs known at the deadline");
    const secondCloseP = ext.waitFor("closeTabs", { timeoutMs: 2000 });
    ext.respond(slowCCmd.id, { ok: true, result: { id: 905, windowId: 1 } }); ext.agentTabs.push(905);
    await slowC;
    ext.respond(firstClose.id, { ok: true, result: { closed: [c1], skipped: [] } });
    const secondClose = await secondCloseP;
    assert(JSON.stringify(secondClose.params.tabIds) === "[905]", "a creation completed during cleanup gets its own closeTabs before the run ends");
    const ackC = await endP;
    assert(ackC.tabs.opened === 2 && ackC.tabs.closed === 2 && !readReg(relay).tabs.some((x) => x.runId === "runC00000001"), "counts include the creation that completed during cleanup");

    // (4) a late creation whose journal record does not exist yet is patched once the supervisor writes it
    lease = await leaseSocket(relay, { runId: "runP00000001" });
    const lateP = cli(relay, ["newTab", '{"url":"https://slow.example/p"}', "--timeout", "5000"], runEnv("runP00000001"));
    const latePCmd = await ext.waitFor("newTab");
    await lease.end();
    const closeP = ext.waitFor("closeTabs", { timeoutMs: 2000 });
    ext.respond(latePCmd.id, { ok: true, result: { id: 906, windowId: 1 } }); ext.agentTabs.push(906);
    await lateP; await closeP; await sleep(100);
    assert(!fs.existsSync(journalFile) || !fs.readFileSync(journalFile, "utf8").includes("runP00000001"), "no journal record yet for the late run");
    fs.appendFileSync(journalFile, JSON.stringify({ runId: "runP00000001", startedAt: new Date().toISOString(), verdict: "pass", tabsOpened: 0, tabsClosed: 0 }) + "\n");
    let patched = null;
    for (let i = 0; i < 40 && !patched; i++) { await sleep(100); const rec = fs.readFileSync(journalFile, "utf8").trim().split("\n").map(JSON.parse).find((x) => x.runId === "runP00000001"); if (rec && rec.late) patched = rec; }
    assert(patched && patched.tabsOpened === 1 && patched.tabsClosed === 1, "late patch is retried until the supervisor's record exists");

    console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll tab-hygiene tests passed.");
  } catch (e) {
    assert(false, `threw: ${e.stack}`);
  } finally {
    relay.stop();
  }
  process.exit(failures ? 1 : 0);
})();
