// Channel configuration: ~/.ai-browser-bridge/channels.json (must be 0600).
//
// One bot:
//   { "telegram": { "token": "123:ABC", "dmPolicy": "pairing", "allowFrom": ["123456789"], "codex": false } }
// Several bots under one channel (each merged with the channel's defaults; a bot
// with "session" is bound to that one conversation):
//   { "telegram": { "dmPolicy": "pairing", "bots": [
//       { "accountId": "default", "token": "123:ABC" },
//       { "accountId": "turo", "token": "456:DEF", "session": "turo", "model": "fable" } ] } }
//
// Every channel comes back as { ...defaults, bots: [bot…] }; the one-bot form also keeps
// its flat token/accountId/apiBase so existing readers (and makeAdapter(cfg.telegram))
// keep working. Tokens may come from the environment: AI_BRIDGE_<CHANNEL>_TOKEN (the
// default bot, or the lone bot of the one-bot form) and AI_BRIDGE_<CHANNEL>_<ACCOUNTID>_TOKEN.
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");
const { POLICIES } = require("./policy");
const { MODELS, normalizeName } = require("./sessions");

const CONFIG_FILE = path.join(DIR, "channels.json");
const DEFAULTS = { accountId: "default", dmPolicy: "pairing", allowFrom: [], codex: false, envPassthrough: [], boundSession: null };
const ACCOUNT_RE = /^[a-z0-9_-]{1,24}$/;
const DEFAULT_MODEL_KEY = "fable";

const envWord = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "_");
// Account-specific key (AI_BRIDGE_TELEGRAM_TURO_TOKEN, …_DEFAULT_TOKEN) and the generic one
// (AI_BRIDGE_TELEGRAM_TOKEN: the default bot, or the lone bot of the one-bot form).
function envKeyFor(channel, accountId) { return `AI_BRIDGE_${envWord(channel)}_${envWord(accountId)}_TOKEN`; }
function genericKeyFor(channel) { return `AI_BRIDGE_${envWord(channel)}_TOKEN`; }

// Parse errors never echo the file's content: only the parser's position survives.
function parseError(file, e) {
  const m = /position (\d+)/.exec(String(e && e.message));
  return new Error(`${file}: invalid JSON${m ? ` (at position ${m[1]})` : ""}`);
}

function normalizeShared(c) {
  const out = { ...c };
  out.allowFrom = Array.isArray(c.allowFrom) ? c.allowFrom.map(String) : [];
  out.codex = c.codex === true;
  out.envPassthrough = Array.isArray(c.envPassthrough) ? c.envPassthrough.map(String) : [];
  if (c.intentKeywords !== undefined) out.intentKeywords = Array.isArray(c.intentKeywords) ? c.intentKeywords.map(String) : undefined;
  return out;
}

function loadConfig({ env = process.env, file = CONFIG_FILE } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`${file} not found — create it with your bot token (see docs/CHANNELS.md)`);
    throw e;
  }
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is group/world readable (mode 0o${mode.toString(8)}); run chmod 600 ${file}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw parseError(file, e); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: expected an object keyed by channel name`);

  const out = {};
  for (const [channel, c0] of Object.entries(parsed)) {
    const c = c0 && typeof c0 === "object" && !Array.isArray(c0) ? c0 : {};
    const listForm = c.bots !== undefined;
    if (listForm && c.token !== undefined) throw new Error(`channel ${channel}: use either token or bots, not both`);
    if (listForm && !Array.isArray(c.bots)) throw new Error(`channel ${channel}: bots must be a list`);
    if (listForm && c.bots.length === 0) throw new Error(`channel ${channel}: bots must not be empty`);
    const { bots: rawBots, token: flatToken, accountId: flatAccount, apiBase: flatApi, session: flatSession, model: flatModel, ...channelKeys } = c;
    if (listForm && (flatSession !== undefined || flatModel !== undefined || flatAccount !== undefined)) {
      throw new Error(`channel ${channel}: session, model and accountId belong on each bot entry when bots is used`);
    }
    const defaults = normalizeShared({ ...DEFAULTS, ...channelKeys, ...(flatApi !== undefined ? { apiBase: flatApi } : {}) });   // apiBase is a per-channel default too
    // Bad values are never echoed: a misplaced token would otherwise reach the console.
    if (!POLICIES.includes(defaults.dmPolicy)) throw new Error(`channel ${channel}: dmPolicy must be one of ${POLICIES.join(", ")}`);

    const entries = listForm ? rawBots : [{ accountId: flatAccount, token: flatToken, apiBase: flatApi, session: flatSession, model: flatModel }];
    const bots = [];
    const seenIds = new Set();
    const envKeys = new Map();
    for (const b0 of entries) {
      const b = b0 && typeof b0 === "object" && !Array.isArray(b0) ? b0 : {};
      const accountId = b.accountId === undefined || b.accountId === null ? "default" : String(b.accountId);
      if (!ACCOUNT_RE.test(accountId)) throw new Error(`channel ${channel}: accountId "${accountId}" is invalid (use 1–24 chars of a-z 0-9 _ -)`);
      if (seenIds.has(accountId)) throw new Error(`channel ${channel}: duplicate accountId "${accountId}"`);
      seenIds.add(accountId);
      const { session, model, ...botKeys } = b;
      const bot = normalizeShared({ ...defaults, ...botKeys, accountId });
      if (!POLICIES.includes(bot.dmPolicy)) throw new Error(`channel ${channel}/${accountId}: dmPolicy must be one of ${POLICIES.join(", ")}`);
      // env overrides, before the token check (env-only credentials are fine); the
      // account-specific key wins over the generic one
      const specific = envKeyFor(channel, accountId);
      const generic = genericKeyFor(channel);
      const genericApplies = !listForm || accountId === "default";
      const envTok = env[specific] || (genericApplies ? env[generic] : undefined);
      if (envTok) bot.token = envTok;
      if (envKeys.has(specific) && envKeys.get(specific) !== accountId) throw new Error(`channel ${channel}: env keys collide for accounts "${envKeys.get(specific)}" and "${accountId}" (${specific})`);
      envKeys.set(specific, accountId);
      if (!bot.token) throw new Error(`channel ${channel}/${accountId}: no token in ${file} and ${genericApplies ? `${generic} / ` : ""}${specific} is not set`);
      bot.token = String(bot.token);
      bot.boundSession = null;
      if (session !== undefined && session !== null) {
        const name = normalizeName(session);   // "" is invalid too: a binding, once written, is never silently dropped
        if (!name) throw new Error(`channel ${channel}/${accountId}: session "${session}" is not a valid session name`);
        const key = String(model === undefined || model === null || model === "" ? DEFAULT_MODEL_KEY : model).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(MODELS, key)) throw new Error(`channel ${channel}/${accountId}: model "${model}" is unknown; use ${Object.keys(MODELS).join(", ")}`);
        bot.boundSession = { name, model: MODELS[key] };
      } else if (model !== undefined) {
        throw new Error(`channel ${channel}/${accountId}: model needs a session`);
      }
      bots.push(bot);
    }
    for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) {
      if (bots[i].token === bots[j].token) throw new Error(`channel ${channel}: same token for accounts "${bots[i].accountId}" and "${bots[j].accountId}"`);
    }
    const primary = listForm ? bots.find((b) => b.accountId === "default") : bots[0];
    out[channel] = { ...defaults, bots };
    if (primary) {
      out[channel].token = primary.token;
      out[channel].accountId = primary.accountId;
      if (primary.apiBase !== undefined) out[channel].apiBase = primary.apiBase;
    }
  }
  return out;
}

// Replace every configured secret with <redacted> (flat fields and every bot's).
function redact(text, config) {
  let s = text == null ? "" : String(text);
  const holders = [];
  for (const c of Object.values(config || {})) {
    if (!c) continue;
    holders.push(c);
    if (Array.isArray(c.bots)) holders.push(...c.bots);
  }
  for (const c of holders) {
    for (const key of ["token", "appToken", "secret", "clientSecret", "accessToken"]) {
      const v = c && c[key];
      if (typeof v === "string" && v.length >= 6) s = s.split(v).join("<redacted>");
    }
  }
  return s;
}

module.exports = { CONFIG_FILE, DEFAULTS, DEFAULT_MODEL_KEY, envKeyFor, genericKeyFor, loadConfig, redact };
