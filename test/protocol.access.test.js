#!/usr/bin/env node
// Server-side access gate: the extension's `access` message decides whether
// CLI commands are forwarded; ping/status always pass and carry the identity
// triple (serverId, extGen, accessGen); pending requests are answered on
// revoke and on extension supersession; the CLI exits 8 on access errors.
const fs = require("fs");
const { startRelay, fakeExtension, cli, randomHex32, sleep } = require("./helpers/relay");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const errorOf = (r) => (/^ERROR: (.*?)(?: \(req [0-9a-f]+\))?$/m.exec(r.stderr) || [])[1] || "";

(async () => {
  const relay = await startRelay();
  try {
    // no access message yet
    let ext = await fakeExtension(relay, { access: false });
    let r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
    assert(r.code === 8 && errorOf(r) === 'access_not_granted: access not granted yet (session "chrome")', "not granted → exit 8, exact string");
    assert(ext.received.length === 0, "nothing forwarded while not granted");
    r = await cli(relay, ["ping", "--timeout", "3000"]);
    assert(r.json.pong === true && r.json.access === "not_granted" && r.json.accessGen === 0 && r.json.extGen === 1 && /^[0-9a-f]{32}$/.test(r.json.serverId) && r.json.until === null && r.json.session === "chrome", "ping forwarded while not granted, carries identity fields");
    const serverId = r.json.serverId;

    // granted
    ext.sendAccess({ granted: true, until: null, gen: 3, session: "work-chrome", browserSession: randomHex32() });
    await sleep(100);
    r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
    assert(r.code === 0 && ext.received.some((m) => m.cmd === "eval"), "granted → forwarded");
    r = await cli(relay, ["status", "--timeout", "3000"]);
    assert(r.json.session === "work-chrome" && r.json.access === "granted" && r.json.accessGen === 3 && r.json.until === null, "status merges session/access/accessGen");
    const until = Date.now() + 60000;
    ext.sendAccess({ granted: true, until, gen: 4 });
    await sleep(100);
    r = await cli(relay, ["ping", "--timeout", "3000"]);
    assert(r.json.until === until && r.json.access === "granted", "timed grant: until merged");

    // revoke: pending eval answered access_revoked, later evals refused locally
    let holdId = null;
    ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "eval") { holdId = id; return undefined; } return { pong: true }; } }); // gen 2
    await sleep(100);
    const pendingEval = cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
    await ext.waitFor("eval");
    ext.sendAccess({ granted: false, until: null, gen: 2 });
    r = await pendingEval;
    assert(r.code === 8 && errorOf(r) === 'access_revoked: access revoked by user (session "chrome")', "pending eval answered access_revoked on revoke");
    const evalsBefore = ext.received.filter((m) => m.cmd === "eval").length;
    r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
    assert(r.code === 8 && /^access_revoked:/.test(errorOf(r)) && ext.received.filter((m) => m.cmd === "eval").length === evalsBefore, "revoked → refused locally, extension receives nothing");
    r = await cli(relay, ["ping", "--timeout", "3000"]);
    assert(r.json.pong === true && r.json.access === "revoked" && r.json.extGen === 2 && r.json.accessGen === 2, "ping forwarded while revoked");
    const log1 = fs.readFileSync(relay.logFile, "utf8");
    assert(/access granted \(session "work-chrome", until never\)/.test(log1) && /access revoked \(session "chrome"\)/.test(log1), "grant and revoke logged");

    // until in the past → revoked, no message
    ext.sendAccess({ granted: true, until: Date.now() - 10, gen: 3 });
    await sleep(100);
    r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
    assert(r.code === 8, "until in the past → revoked");
    // until elapsing while granted: the server evaluates it on every request
    ext.sendAccess({ granted: true, until: Date.now() + 150, gen: 4 });
    await sleep(50);
    r = await cli(relay, ["listTabs", "--timeout", "3000"]);
    assert(r.code === 0, "timed grant still valid → forwarded");
    await sleep(200);
    r = await cli(relay, ["listTabs", "--timeout", "3000"]);
    assert(r.code === 8 && /^access_revoked:/.test(errorOf(r)), "until elapsed without a message → treated as revoked");
    // missing browserSession → revoked
    ext.sendAccess({ granted: true, until: null, gen: 5, browserSession: undefined });
    await sleep(100);
    assert((await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"])).code === 8, "access without browserSession → revoked");
    assert(/access message rejected: bad_browser_session/.test(fs.readFileSync(relay.logFile, "utf8")), "rejection logged");

    // a pending ping survives a revoke
    let heldPingId = null;
    ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "ping") { heldPingId = id; return undefined; } return { echo: cmd }; } }); // gen 3
    await sleep(100);
    let held = cli(relay, ["ping", "--timeout", "3000"]);
    await ext.waitFor("ping");
    ext.sendAccess({ granted: false, until: null, gen: 2 });
    await sleep(100);
    ext.respond(heldPingId, { ok: true, result: { pong: true } });
    r = await held;
    assert(r.code === 0 && r.json.pong === true && r.json.access === "revoked", "pending ping survives a revoke");

    // reloadExtension is the one command that revokes on purpose: the revoke it triggers must not cancel its own reply
    let heldReload = null;
    ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "reloadExtension") { heldReload = id; return undefined; } return { pong: true }; } });
    await sleep(100);
    const reloadP = cli(relay, ["reloadExtension", "--timeout", "3000"]);
    await ext.waitFor("reloadExtension");
    ext.sendAccess({ granted: false, until: null, gen: 7 }); await sleep(50);
    ext.respond(heldReload, { ok: true, result: { ok: true, reloading: true } });
    r = await reloadP;
    assert(r.code === 0 && r.json.reloading === true, "a pending reloadExtension survives the revoke it causes and gets its reply");
    ext.sendAccess({ granted: true, until: null, gen: 8 }); await sleep(50);

    // supersession: pending request on the old socket is cancelled, access resets, old socket's access is ignored
    const old = ext;
    const genBefore = (await cli(relay, ["ping", "--timeout", "3000"])).json.extGen;
    let heldPing2 = null;
    old.handlerOverride = (cmd, p, id) => { if (cmd === "ping") { heldPing2 = id; return undefined; } return { pong: true }; };
    held = cli(relay, ["ping", "--timeout", "3000"]);
    await old.waitFor("ping");
    await fakeExtension(relay, { access: false }); // gen + 1
    r = await held;
    assert(r.code === 1 && errorOf(r) === "extension disconnected", "pending request of the superseded socket gets extension disconnected");
    try { old.sendAccess({ granted: true, until: null, gen: 9 }); } catch {}
    await sleep(100);
    r = await cli(relay, ["ping", "--timeout", "3000"]);
    assert(r.json.access === "not_granted" && r.json.extGen === genBefore + 1 && r.json.accessGen === 0, "new extension socket resets access to not_granted and bumps extGen; old socket's access ignored");
    assert(new RegExp(`extension superseded \\(gen ${genBefore} → ${genBefore + 1}\\)`).test(fs.readFileSync(relay.logFile, "utf8")), "supersession logged");
    void heldPing2;
    assert(r.json.serverId === serverId, "serverId stable within one server process");

    // serverId differs between processes
    const relay2 = await startRelay();
    await fakeExtension(relay2);
    assert((await cli(relay2, ["ping", "--timeout", "3000"])).json.serverId !== serverId, "serverId differs between two server processes");
    relay2.stop();
  } catch (e) {
    assert(false, `threw: ${e.stack}`);
  } finally {
    relay.stop();
  }
  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll access-gate tests passed.");
  process.exit(failures ? 1 : 0);
})();
