#!/usr/bin/env node
// extension/access.js under a stub `chrome`: browserSession creation, the
// access message, agentTabs bookkeeping and closeTabs (owned ids only).
// Also checks that background.js wires the module in.
const fs = require("fs");
const path = require("path");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

function stubChrome() {
  const mem = { session: {}, local: {} };
  const area = (name) => ({
    get: async (q) => {
      const out = {};
      const keys = typeof q === "string" ? [q] : Array.isArray(q) ? q : Object.keys(q);
      for (const k of keys) out[k] = k in mem[name] ? mem[name][k] : (q && typeof q === "object" && !Array.isArray(q) ? q[k] : undefined);
      return out;
    },
    set: async (o) => { Object.assign(mem[name], o); },
    remove: async (k) => { delete mem[name][k]; },
    clear: async () => { mem[name] = {}; },
  });
  const removed = [];
  const failIds = new Set();
  const chrome = {
    storage: { session: area("session"), local: area("local") },
    tabs: { remove: async (id) => { if (failIds.has(id)) throw new Error("No tab with id"); removed.push(id); } },
  };
  return { chrome, mem, removed, failIds };
}

(async () => {
  const S = stubChrome();
  global.chrome = S.chrome;
  const B = require("../extension/access.js");

  const bs = await B.ensureBrowserSession();
  assert(/^[0-9a-f]{32}$/.test(bs) && (await B.ensureBrowserSession()) === bs, "browserSession created once and stable");
  await S.chrome.storage.session.set({ browserSession: "garbage" });
  assert(/^[0-9a-f]{32}$/.test(await B.ensureBrowserSession()), "malformed stored browserSession replaced");
  await S.chrome.storage.session.clear(); // simulated reload / browser restart
  assert((await B.ensureBrowserSession()) !== bs, "cleared session storage → new browserSession");

  const msg = await B.accessMessage("work-chrome");
  assert(msg.type === "access" && msg.session === "work-chrome" && msg.granted === true && msg.until === null && msg.gen === 1 && /^[0-9a-f]{32}$/.test(msg.browserSession), "slice-1 default access message is granted/indefinite/gen 1");
  assert(msg.browserSession === (await B.ensureBrowserSession()), "access message carries the current browserSession");
  await S.chrome.storage.local.set({ access: { granted: false, until: null, gen: 4 } });
  const m2 = await B.accessMessage("c");
  assert(m2.granted === false && m2.gen === 4 && m2.until === null, "access message reflects stored state");

  await B.rememberAgentTab(10); await B.rememberAgentTab(11); await B.rememberAgentTab(11);
  assert(JSON.stringify(await B.agentTabIds()) === "[10,11]", "agentTabs de-duplicated");
  let r = await B.closeOwnedTabs([10, 99, "x"]);
  assert(JSON.stringify(r.closed) === "[10]" && JSON.stringify(r.skipped) === '[99,"x"]' && JSON.stringify(S.removed) === "[10]" && JSON.stringify(await B.agentTabIds()) === "[11]", "closeTabs closes only owned ids, reports the rest skipped");
  S.failIds.add(11);
  r = await B.closeOwnedTabs([11]);
  assert(r.closed.length === 0 && JSON.stringify(r.skipped) === "[11]" && (await B.agentTabIds()).length === 0, "remove rejection → skipped and forgotten");
  await B.rememberAgentTab(12); await B.forgetAgentTab(12);
  assert((await B.agentTabIds()).length === 0, "forgetAgentTab");
  // concurrent ownership updates must not lose tabs (read-modify-write race)
  await S.chrome.storage.session.set({ agentTabs: [] });
  await Promise.all([B.rememberAgentTab(20), B.rememberAgentTab(21), B.rememberAgentTab(22)]);
  assert(JSON.stringify(await B.agentTabIds()) === "[20,21,22]", "concurrent rememberAgentTab keeps every tab");
  await Promise.all([B.forgetAgentTab(21), B.rememberAgentTab(23)]);
  assert(JSON.stringify(await B.agentTabIds()) === "[20,22,23]", "concurrent forget + remember: removed tab stays removed, new tab kept");
  // malformed stored grants fail closed; only an absent record gets the slice-1 default
  for (const bad of [{ granted: true, until: "broken" }, { granted: true }, { granted: "true", until: null }, { granted: true, until: NaN }, "junk", 7]) {
    await S.chrome.storage.local.set({ access: bad });
    assert((await B.accessMessage("c")).granted === false, `malformed stored access ${JSON.stringify(bad)} → not granted`);
  }
  await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() + 60000, gen: 2 } });
  assert((await B.accessMessage("c")).granted === true, "well-formed timed grant stays granted");
  await S.chrome.storage.local.remove("access");
  assert((await B.accessMessage("c")).granted === true, "absent record → slice-1 default (granted)");
  r = await B.closeOwnedTabs("nope");
  assert(r.closed.length === 0 && r.skipped.length === 0, "closeTabs with a non-array closes nothing");

  const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
  assert(/^importScripts\("access\.js"\);/m.test(src), "background.js imports access.js");
  assert(/case "closeTabs"/.test(src) && /closeOwnedTabs\(/.test(src), "background.js handles closeTabs via BridgeAccess");
  assert(/agentTabs:/.test(src) && /agentTabIds\(\)/.test(src), "background.js status reports agentTabs");
  assert(/rememberAgentTab\(/.test(src) && /forgetAgentTab\(/.test(src), "background.js records opened/closed tabs");
  assert(/accessMessage\(/.test(src) && /msg\.type === "auth"/.test(src), "background.js sends the access message after auth");
  assert(/session: "chrome"/.test(src), "DEFAULTS has the session name");
  const closeTabCase = /case "closeTab":([\s\S]*?)return \{ ok: true \};/.exec(src);
  assert(closeTabCase && /await assertAllowed\(p\.tabId\)/.test(closeTabCase[1]) && closeTabCase[1].indexOf("assertAllowed") < closeTabCase[1].indexOf("chrome.tabs.remove"), "closeTab checks the allowlist before removing a tab");

  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll extension access tests passed.");
  process.exit(failures ? 1 : 0);
})();
