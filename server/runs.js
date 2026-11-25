// Run leases (design: docs/superpowers/specs/2026-11-21-docker-isolated-access-
// design.md, "Tab hygiene — Run cleanup").
//
// A supervisor (`bridge agent`) registers its run on a socket it keeps open for
// the run's life. When it sends `runEnd`, or the socket closes for any reason
// (crash, SIGKILL, the machine dropping the connection), the run is *ending*:
// the server waits up to `drainMs` for `newTab`s still pending for that run,
// then closes the run's own tabs through the extension's `closeTabs` — best
// effort while access is granted, never while it is not (the tabs are then
// recorded as retained, for the popup's "Close agent tabs"). A creation whose
// response arrives after the drain is closed late and the run's journal record
// is patched. A process that dies cannot run its own `finally`; the OS closing
// its socket is the signal that does not depend on it.
"use strict";

function createRunManager({ registry, sendCommand, accessState, log, patchJournal, drainMs = 5000, patchRetryMs = 500, patchRetries = 120 }) {
  const runs = new Map(); // runId -> { runId, client, keepTabs, sock, state, counts, ending }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const countsOf = (run) => ({ ...run.counts });

  // Close `ids` for a run if allowed; returns { closed, retained } counts and
  // updates the registry accordingly.
  async function closeOrRetain(run, ids) {
    if (!ids.length) return { closed: 0, retained: 0 };
    if (run.keepTabs) return { closed: 0, retained: 0 };
    if (accessState() === "granted") {
      const r = await sendCommand("closeTabs", { tabIds: ids });
      if (r.ok && r.result && Array.isArray(r.result.closed)) {
        const closed = r.result.closed.filter((id) => ids.includes(id));
        registry.remove(closed);
        const left = ids.filter((id) => !closed.includes(id));
        for (const id of left) registry.markRetainedTab(id);
        return { closed: closed.length, retained: left.length };
      }
    }
    for (const id of ids) registry.markRetainedTab(id);
    return { closed: 0, retained: ids.length };
  }

  const rm = {
    register({ runId, client, keepTabs, sock }) {
      const live = runs.get(runId);
      if (live && live.state !== "ended") return { ok: false, error: `run already live: ${runId}` };
      runs.set(runId, { runId, client: String(client || "cli"), keepTabs: !!keepTabs, sock, state: "live",
        counts: { opened: 0, closed: 0, retained: 0, kept: 0 }, ending: null });
      log(`run ${runId} registered (${client}, keepTabs=${!!keepTabs})`);
      return { ok: true };
    },
    get(runId) {
      const run = runs.get(runId);
      return run ? { runId, client: run.client, keepTabs: run.keepTabs, state: run.state, counts: countsOf(run) } : undefined;
    },
    isLive(runId) { const run = runs.get(runId); return !!run && run.state === "live"; },
    noteOpened(runId) { const run = runs.get(runId); if (run) run.counts.opened++; },

    end(runId, { reason = "runEnd" } = {}) {
      const run = runs.get(runId);
      if (!run) return Promise.resolve(null);
      if (run.ending) return run.ending;
      run.state = "ending";
      run.ending = (async () => {
        const deadline = Date.now() + drainMs;
        while (registry.pendingForRun(runId) > 0 && Date.now() < deadline) await sleep(50);
        // A creation can complete while closeTabs is in flight: loop until no
        // live row of the run is left, so nothing slips between the snapshot
        // and the response.
        for (let round = 0; round < 10; round++) {
          const ids = registry.rowsForRun(runId).map((r) => r.tabId);
          if (!ids.length) break;
          if (run.keepTabs) { run.counts.kept = ids.length; break; }
          const r = await closeOrRetain(run, ids);
          run.counts.closed += r.closed; run.counts.retained += r.retained;
          if (!r.closed) break; // nothing closable (not granted, or all skipped): stop here
        }
        run.state = "ended";
        const c = run.counts;
        log(`run ${runId} ended (${reason}): opened ${c.opened} closed ${c.closed} retained ${c.retained} kept ${c.kept}`);
        return countsOf(run);
      })();
      return run.ending;
    },

    // A newTab of an ended run answered after the drain.
    async lateCreation(runId, tabId) {
      const run = runs.get(runId);
      if (!run || run.state !== "ended") return;
      registry.markLate(tabId);
      let what;
      if (run.keepTabs) { run.counts.kept++; what = "kept"; }
      else {
        const r = await closeOrRetain(run, [tabId]);
        run.counts.closed += r.closed; run.counts.retained += r.retained;
        what = r.closed ? "closed" : "retained";
      }
      log(`run ${runId} late tab ${tabId} ${what}`);
      // The supervisor writes its record right after runEnd is acknowledged; a
      // late creation can beat it, so keep trying for a while.
      const c = run.counts;
      for (let i = 0; i <= patchRetries; i++) {
        if (patchJournal(runId, { tabsOpened: c.opened, tabsClosed: c.closed, tabsRetained: c.retained, keptTabs: c.kept, late: true })) return;
        await sleep(patchRetryMs);
      }
      log(`run ${runId} late tab counters not journaled (no record for the run)`);
    },

    onSocketClose(sock) {
      for (const run of runs.values()) if (run.sock === sock && run.state === "live") rm.end(run.runId, { reason: "lease_closed" });
    },
  };
  return rm;
}

module.exports = { createRunManager };
