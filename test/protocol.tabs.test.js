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
    ext.close();

    console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll tab-hygiene tests passed.");
  } catch (e) {
    assert(false, `threw: ${e.stack}`);
  } finally {
    relay.stop();
  }
  process.exit(failures ? 1 : 0);
})();
