#!/usr/bin/env node
// Channel config: defaults, env overrides, mode check, redaction; rotating redacted logger.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-config-"));
const { CONFIG_FILE, loadConfig, redact } = require("../server/channels/config.js");
const { makeLogger } = require("../server/channels/log.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

assert(CONFIG_FILE === path.join(process.env.AI_BRIDGE_HOME, "channels.json"), "CONFIG_FILE under AI_BRIDGE_HOME");

// missing file → clear error
let err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /channels\.json/.test(err.message) && /not found|missing/i.test(err.message), "loadConfig: missing file names the path");

// defaults
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "123:ABC" } }), { mode: 0o600 });
let cfg = loadConfig({ env: {} });
assert(cfg.telegram.token === "123:ABC" && cfg.telegram.dmPolicy === "pairing" && JSON.stringify(cfg.telegram.allowFrom) === "[]" && cfg.telegram.codex === false && cfg.telegram.accountId === "default",
  "loadConfig: defaults applied (pairing, empty allowFrom, codex false, default account)");

// env override wins
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "999:ENV" } });
assert(cfg.telegram.token === "999:ENV", "loadConfig: AI_BRIDGE_<CHANNEL>_TOKEN overrides the file");

// explicit values kept, allowFrom normalised to strings
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", dmPolicy: "allowlist", allowFrom: [42, "7"], codex: true } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.dmPolicy === "allowlist" && JSON.stringify(cfg.telegram.allowFrom) === '["42","7"]' && cfg.telegram.codex === true, "loadConfig: explicit values kept, allowFrom stringified");
assert(JSON.stringify(cfg.telegram.envPassthrough) === "[]", "loadConfig: envPassthrough defaults to []");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", envPassthrough: ["HTTPS_PROXY", 7] } }), { mode: 0o600 });
assert(JSON.stringify(loadConfig({ env: {} }).telegram.envPassthrough) === '["HTTPS_PROXY","7"]', "loadConfig: envPassthrough kept as strings");

// bad policy rejected
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", dmPolicy: "yolo" } }), { mode: 0o600 });
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /dmPolicy/.test(err.message), "loadConfig: unknown dmPolicy rejected");

// no token anywhere → error naming the channel
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: {} }), { mode: 0o600 });
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /telegram/.test(err.message) && /token/.test(err.message), "loadConfig: missing token names the channel");

// mode check
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t" } }));
fs.chmodSync(CONFIG_FILE, 0o644);
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /chmod 600/.test(err.message), "loadConfig: group/world-readable file refused");
fs.chmodSync(CONFIG_FILE, 0o600);
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "sec-ret_TOKEN:1" } });

// redact
assert(redact("sent sec-ret_TOKEN:1 to x", cfg) === "sent <redacted> to x", "redact: token value replaced");
assert(redact("nothing here", cfg) === "nothing here", "redact: untouched when no token present");
assert(redact(null, cfg) === "", "redact: null → empty string");

// ---- several bots per channel
const TA = "sentinel-token-AAAA:1", TB = "sentinel-token-BBBB:2", TC = "sentinel-token-CCCC:3";
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { dmPolicy: "allowlist", allowFrom: [1], envPassthrough: ["X"], bots: [
  { accountId: "turo", token: TB, session: "Turo" },
  { accountId: "mail", token: TC, session: "mail", model: "haiku", dmPolicy: "pairing", apiBase: "http://x", envPassthrough: ["Y"] },
  { accountId: "default", token: TA } ] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.bots.length === 3 && cfg.telegram.bots[0].accountId === "turo" && cfg.telegram.bots[0].dmPolicy === "allowlist" && JSON.stringify(cfg.telegram.bots[0].allowFrom) === '["1"]' && JSON.stringify(cfg.telegram.bots[0].envPassthrough) === '["X"]' && cfg.telegram.bots[0].codex === false && JSON.stringify(cfg.telegram.bots[0].boundSession) === '{"name":"turo","model":"claude-fable-5-1"}', "bots: channel defaults merged into each bot, session name normalised, model default fable");
assert(cfg.telegram.bots[2].boundSession === null && cfg.telegram.bots[1].dmPolicy === "pairing" && cfg.telegram.bots[1].apiBase === "http://x" && JSON.stringify(cfg.telegram.bots[1].envPassthrough) === '["Y"]' && cfg.telegram.bots[1].boundSession.model === "claude-haiku-5-5", "bots: unbound bot, per-bot overrides kept");
assert(cfg.telegram.token === TA && cfg.telegram.accountId === "default" && cfg.telegram.dmPolicy === "allowlist", "bots: flat token/accountId alias the default bot even when listed last; channel defaults stay flat");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { apiBase: "http://shared", bots: [{ accountId: "default", token: TA }, { accountId: "turo", token: TB, apiBase: "http://own" }] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.bots[0].apiBase === "http://shared" && cfg.telegram.bots[1].apiBase === "http://own" && cfg.telegram.apiBase === "http://shared", "bots: channel-level apiBase is a default every bot inherits");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", accountId: "solo", apiBase: "http://y", allowFrom: [5] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.bots.length === 1 && cfg.telegram.bots[0].accountId === "solo" && cfg.telegram.bots[0].token === "t" && cfg.telegram.bots[0].apiBase === "http://y" && JSON.stringify(cfg.telegram.bots[0].allowFrom) === '["5"]' && cfg.telegram.bots[0].boundSession === null && cfg.telegram.accountId === "solo", "one-bot form: bots[0] mirrors the flat fields incl. a custom accountId");
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "E:9" } });
assert(cfg.telegram.bots[0].token === "E:9" && cfg.telegram.token === "E:9", "one-bot form: the generic env token applies to the lone bot whatever its accountId");
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "E:9", AI_BRIDGE_TELEGRAM_SOLO_TOKEN: "S:1" } });
assert(cfg.telegram.bots[0].token === "S:1", "one-bot form: the account-specific env token wins over the generic one");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { bots: [{ accountId: "default" }, { accountId: "turo", session: "turo" }] } }), { mode: 0o600 });
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "D:0", AI_BRIDGE_TELEGRAM_TURO_TOKEN: "T:1" } });
assert(cfg.telegram.bots[0].token === "D:0" && cfg.telegram.bots[1].token === "T:1", "bots: env overrides apply before the token check (env-only credentials); generic → default only");
err = null; try { loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "SAME", AI_BRIDGE_TELEGRAM_TURO_TOKEN: "SAME" } }); } catch (e) { err = e; }
assert(err && /same token/.test(err.message) && !/SAME/.test(err.message), "bots: duplicate tokens produced by overrides are rejected without echoing the token");
for (const [name, body, re] of [
  ["token+bots", { telegram: { token: "t", bots: [{ accountId: "a", token: "x" }] } }, /either token or bots/],
  ["bad accountId", { telegram: { bots: [{ accountId: "Bad Id", token: "x" }] } }, /accountId "Bad Id" is invalid/],
  ["duplicate accountId", { telegram: { bots: [{ accountId: "a", token: "x" }, { accountId: "a", token: "y" }] } }, /duplicate accountId "a"/],
  ["two defaults", { telegram: { bots: [{ token: "x" }, { token: "y" }] } }, /duplicate accountId "default"/],
  ["missing token", { telegram: { bots: [{ accountId: "a" }] } }, /telegram\/a[^]*no token|no token[^]*telegram\/a/],
  ["env collision", { telegram: { bots: [{ accountId: "foo-bar", token: "x" }, { accountId: "foo_bar", token: "y" }] } }, /env keys collide[^]*foo-bar[^]*foo_bar/],
  ["same token", { telegram: { bots: [{ accountId: "a", token: "x" }, { accountId: "b", token: "x" }] } }, /same token[^]*"a"[^]*"b"/],
  ["bad session", { telegram: { bots: [{ accountId: "a", token: "x", session: "agent" }] } }, /session "agent" is not a valid session name/],
  ["bad model", { telegram: { bots: [{ accountId: "a", token: "x", session: "s", model: "gpt" }] } }, /model "gpt"/],
  ["bad bot policy", { telegram: { bots: [{ accountId: "a", token: "x", dmPolicy: "yolo" }] } }, /dmPolicy/],
  ["bots not a list", { telegram: { bots: { accountId: "a", token: "x" } } }, /bots must be a list/],
]) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(body), { mode: 0o600 }); err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; } assert(err && re.test(err.message), `loadConfig: ${name} rejected`); }
fs.writeFileSync(CONFIG_FILE, `{"telegram":{"token":"${TA}"} x`, { mode: 0o600 });
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /invalid JSON/.test(err.message) && /position \d+/.test(err.message) && !err.message.includes(TA), "loadConfig: malformed JSON reports a position, never the content");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { bots: [{ accountId: "default", token: TA }, { accountId: "turo", token: TB, session: "turo" }] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(redact(`a ${TA} b ${TB} c`, cfg) === "a <redacted> b <redacted> c", "redact: every bot's token replaced");

// back to the one-bot config the logger block expects
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t" } }), { mode: 0o600 });
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "sec-ret_TOKEN:1" } });

// logger: redaction + rotation
{
  const file = path.join(process.env.AI_BRIDGE_HOME, "channels.log");
  const log = makeLogger({ file, maxBytes: 200, keep: 3, redact: (t) => redact(t, cfg) });
  log("hello sec-ret_TOKEN:1 world");
  const first = fs.readFileSync(file, "utf8");
  assert(/^\d{4}-\d{2}-\d{2}T.*hello <redacted> world\n$/.test(first), "logger: timestamped line with the token redacted");
  for (let i = 0; i < 50; i++) log(`line ${i} ${"x".repeat(20)}`);
  const names = fs.readdirSync(process.env.AI_BRIDGE_HOME).filter((n) => n.startsWith("channels.log"));
  assert(names.includes("channels.log") && names.includes("channels.log.1"), "logger: rotated to .1");
  assert(!names.includes("channels.log.4"), "logger: keeps at most 3 rotated files");
  assert(fs.statSync(file).size <= 200 + 100, "logger: current file stays near maxBytes");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
