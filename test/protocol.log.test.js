#!/usr/bin/env node
// Request-id correlation: every terminal outcome (forwarded result, local
// refusal, cancellation) is logged and traced exactly once with the wire id,
// the client label and the run id; the CLI prints "(req <id>)" on failure and
// a JSON error line with reqId; `bridge journal --trace` shows the ids.
const fs = require("fs");
const path = require("path");
const { startRelay, fakeExtension, cli, sleep } = require("./helpers/relay");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  const relay = await startRelay();
  try {
    const env = { AI_BRIDGE_RUN_ID: "logrun0001", AI_BRIDGE_CLIENT: "unit test" };
    const ext = await fakeExtension(relay, { handler: (cmd, p) => (cmd === "eval" ? undefined : cmd === "newTab" ? { id: 1, windowId: 1 } : { pong: true }) });
    // forwarded result
    let r = await cli(relay, ["newTab", '{"url":"https://example.com/a?b=1"}', "--timeout", "3000"], { env });
    assert(r.code === 0 && r.json.id === 1, "newTab ok");
    // local refusal
    ext.sendAccess({ granted: false, until: null, gen: 2 }); await sleep(100);
    r = await cli(relay, ["newTab", '{"url":"https://example.com/"}', "--timeout", "3000"], { env });
    const m = /^ERROR: (.*) \(req ([0-9a-f]{16})\)$/m.exec(r.stderr);
    assert(r.code === 8 && m && /^access_revoked: /.test(m[1]), "refusal prints ERROR: … (req <id>) and exits 8");
    assert(r.json && r.json.error === m[1] && r.json.reqId === m[2], "stdout gets one JSON line {error, reqId}");
    // cancellation
    ext.sendAccess({ granted: true, until: null, gen: 3 }); await sleep(100);
    const held = cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"], { env });
    await ext.waitFor("eval"); ext.close();
    r = await held;
    assert(r.code === 1 && r.json.error === "extension disconnected" && /\(req [0-9a-f]{16}\)/.test(r.stderr), "cancellation prints (req <id>) and exits 1");

    // log lines
    const lines = fs.readFileSync(relay.logFile, "utf8").split("\n");
    const cmdLine = lines.find((l) => / cmd newTab /.test(l));
    assert(/^\S+ [0-9a-f]{16} unit test logrun0001 cmd newTab \{"url":"https:\/\/example\.com\/a\?b=1","direct":true\}$/.test(cmdLine), "cmd line: <ts> <reqId> <client> <runId> cmd …");
    const reqId = cmdLine.split(" ")[1];
    const same = lines.filter((l) => l.includes(reqId));
    assert(same.length === 2 && new RegExp(`^\\S+ ${reqId} unit test logrun0001 done ok \\d+ms$`).test(same[1]), "done line once, same reqId");
    assert(lines.some((l) => /^\S+ [0-9a-f]{16} unit test logrun0001 refused access_revoked$/.test(l)), "refused line with code");
    assert(lines.some((l) => /^\S+ [0-9a-f]{16} unit test logrun0001 cancelled extension disconnected$/.test(l)), "cancelled line");
    assert(lines.filter((l) => / unit test logrun0001 (done|refused|cancelled) /.test(l)).length === 3, "each terminal outcome logged exactly once");

    // trace
    const t = fs.readFileSync(path.join(relay.home, "traces", "logrun0001.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert(t.length === 3 && t.map((e) => e.outcome).join() === "done,refused,cancelled", "trace has one entry per outcome");
    assert(t.every((e) => /^[0-9a-f]{16}$/.test(e.reqId) && e.client === "unit test") && t[0].reqId === reqId, "trace entries carry reqId and client");
    assert(t[1].ok === false && /^access_revoked:/.test(t[1].error) && t[2].ok === false && t[2].error === "extension disconnected", "refused/cancelled trace entries carry the error");

    // client default and sanitising
    const ext2 = await fakeExtension(relay);
    void ext2;
    await cli(relay, ["ping", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "" } });
    assert(/ [0-9a-f]{16} (node|cli|sh|zsh|bash)\S* - cmd ping /.test(fs.readFileSync(relay.logFile, "utf8")), "client defaults to the parent process name");
    await cli(relay, ["ping", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "x\u0007y".padEnd(80, "q") } });
    const log = fs.readFileSync(relay.logFile, "utf8");
    assert(!/\u0007/.test(log) && new RegExp(` xy${"q".repeat(38)} - cmd ping `).test(log), "client sanitised and truncated to 40");
    // a failing forwarded command: done fail with the error
    await cli(relay, ["boom", "{}", "--timeout", "3000"], { env }); // ext2 echoes → ok; use a handler-less fail: not available → skip? no: fail.example newTab
    await cli(relay, ["newTab", '{"url":"https://fail.example/"}', "--timeout", "3000"], { env });
    assert(/ unit test logrun0001 done fail \d+ms could not create$/m.test(fs.readFileSync(relay.logFile, "utf8")), "forwarded failure logs done fail <ms> <error>");

    const dump = (await cli(relay, ["journal", "--trace", "logrun0001"])).stdout;
    const dl = dump.split("\n").filter(Boolean);
    assert(dl.length === 5 && dump.includes(reqId) && /REF  newTab/.test(dump) && /CAN  eval/.test(dump) && /FAIL newTab/.test(dump), "bridge journal --trace prints reqId and outcome");
  } catch (e) {
    assert(false, `threw: ${e.stack}`);
  } finally {
    relay.stop();
  }
  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll log tests passed.");
  process.exit(failures ? 1 : 0);
})();
