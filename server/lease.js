// Supervisor side of a run lease (server/runs.js has the relay side).
//
// `bridge agent` opens one socket per run, registers the run on it and keeps
// it open until the run is over. If the supervisor dies, the OS closes the
// socket and the relay cleans the run's tabs up anyway; if it ends normally,
// `end()` sends runEnd and returns the tab counters for the journal.
"use strict";

const fs = require("fs");
const WebSocket = require("ws");
const { TOKEN_FILE } = require("./token");

function openLease({ port = Number(process.env.BRIDGE_PORT || 8765), token, runId, client = "bridge agent", keepTabs = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!token) {
      try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
      catch { return reject(new Error(`no token at ${TOKEN_FILE}`)); }
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(e); } };
    const timer = setTimeout(() => fail(new Error("run registration timed out (old relay?)")), Math.min(timeoutMs, 3000));
    let ended = null;
    const lease = {
      end() {
        if (ended) return ended;
        ended = new Promise((res) => {
          if (ws.readyState !== WebSocket.OPEN) return res(null);
          const t = setTimeout(() => { try { ws.close(); } catch {} res(null); }, timeoutMs);
          ws.on("message", (d) => {
            let m; try { m = JSON.parse(d); } catch { return; }
            if (m.type !== "runEnd") return;
            clearTimeout(t);
            try { ws.close(); } catch {}
            res(m.ok && m.tabs ? m.tabs : null);
          });
          ws.send(JSON.stringify({ type: "runEnd", runId }));
        });
        return ended;
      },
      close() { try { ws.close(); } catch {} },
    };
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "cli", token })));
    ws.on("error", (e) => fail(new Error(`lease connect failed: ${e.message}`)));
    ws.on("close", () => fail(new Error("lease socket closed before registration")));
    ws.on("message", (d) => {
      if (settled) return;
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === "auth") {
        if (!m.ok) return fail(new Error("lease auth failed"));
        return ws.send(JSON.stringify({ type: "run", runId, client, keepTabs: !!keepTabs }));
      }
      if (m.type === "run") {
        clearTimeout(timer);
        if (!m.ok) return fail(new Error(m.error || "run refused"));
        settled = true;
        resolve(lease);
      }
    });
  });
}

module.exports = { openLease };
