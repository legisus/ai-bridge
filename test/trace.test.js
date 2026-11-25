#!/usr/bin/env node
// Server trace test: a CLI call made with AI_BRIDGE_RUN_ID set is recorded by
// the relay in traces/<runId>.jsonl (temp AI_BRIDGE_HOME); the eval code is
// kept in full, screenshot pixels are not. A call without the env leaves no trace.
const fs = require("fs");
const path = require("path");
const { startRelay, fakeExtension, cli: cliRun } = require("./helpers/relay");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  const relay = await startRelay();
  const HOME = relay.home;
  const ext = await fakeExtension(relay, {
    handler: (cmd, params) => {
      if (cmd === "boom") return { __error: "no such tab" };
      return cmd === "screenshot" ? { base64: "QUJD" } : cmd === "eval" ? 42 : { echo: cmd, params };
    },
  });
  // run(): same shape the old execFile-based helper had — throws on non-zero exit.
  const run = async (_node, args, { env = {} } = {}) => {
    const r = await cliRun(relay, args.slice(1), { env });
    if (r.code !== 0) throw Object.assign(new Error(r.stderr), { stderr: r.stderr });
    return r;
  };
  const env = {};

  const cli = path.join(__dirname, "..", "server", "cli.js");
  const runEnv = { ...env, AI_BRIDGE_RUN_ID: "trace0001", AI_BRIDGE_JOB: "kbb" };
  try {
    await run("node", [cli, "newTab", '{"url":"https://www.kbb.com/"}', "--timeout", "5000"], { env: runEnv });
    await run("node", [cli, "eval", '{"tabId":1,"code":"document.title"}', "--timeout", "5000"], { env: runEnv });
    await run("node", [cli, "screenshot", '{"tabId":1}', "--timeout", "5000"], { env: runEnv });
    await run("node", [cli, "snapshot", '{"tabId":1,"maxText":50}', "--timeout", "5000"], { env: runEnv });
    let failed = false;
    try { await run("node", [cli, "boom", '{"tabId":9}', "--timeout", "5000"], { env: runEnv }); } catch { failed = true; }
    assert(failed, "failing command exits non-zero");
    await run("node", [cli, "ping", "--timeout", "5000"], { env }); // no run id → not traced

    const file = path.join(HOME, "traces", "trace0001.jsonl");
    assert(fs.existsSync(file), "trace file created under AI_BRIDGE_HOME/traces");
    const t = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert(t.length === 5, `trace has 5 entries (got ${t.length})`);
    assert(t[0].cmd === "newTab" && t[0].job === "kbb" && t[0].params.url === "https://www.kbb.com/" && t[0].ok === true,
      "trace: newTab entry with job + params");
    assert(t[1].cmd === "eval" && t[1].params.code === "document.title" && t[1].result === 42 && typeof t[1].ms === "number",
      "trace: eval keeps code + result + duration");
    assert(t[2].cmd === "screenshot" && /omitted/.test(t[2].result.base64), "trace: screenshot pixels omitted");
    assert(t[3].cmd === "snapshot" && t[3].params.maxText === 50 && t[3].params.code === undefined, "trace: snapshot logged as snapshot, not as eval code");
    assert(t[4].cmd === "boom" && t[4].ok === false && t[4].error === "no such tab", "trace: failure recorded with error");
    assert(fs.readdirSync(path.join(HOME, "traces")).length === 1, "no trace written without AI_BRIDGE_RUN_ID");

    // `bridge journal --trace` prints it
    const dump = (await run("node", [cli, "journal", "--trace", "trace0001"], { env })).stdout;
    assert(dump.split("\n").filter(Boolean).length === 5 && dump.includes("FAIL boom"), "bridge journal --trace dumps the run");
    const empty = (await run("node", [cli, "journal"], { env })).stdout;
    assert(empty.includes("no agent runs"), "bridge journal with empty journal");
  } catch (e) {
    assert(false, `threw: ${e.stderr || e.message}`);
  } finally {
    ext.close();
    relay.stop();
  }
  console.log(failures === 0 ? "\nAll trace tests passed." : `\n${failures} TEST(S) FAILED`);
  process.exit(failures ? 1 : 0);
})();
