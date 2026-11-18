// Shared fakes for the channel manager suites: adapter, runAgent, runTurn, a Manager
// builder with a temp SessionStore, a fake clock. Requires process.env.AI_BRIDGE_HOME
// to be set by the caller before any server module is loaded.
const fs = require("fs");
const path = require("path");
const { Manager } = require("../../server/channels/manager.js");
const { ChannelState } = require("../../server/channels/state.js");
const { SessionStore } = require("../../server/channels/sessions.js");
const pairing = require("../../server/channels/pairing.js");
const { Approvals } = require("../../server/channels/approvals.js");
const { RateLimiter } = require("../../server/channels/policy.js");

const TOKEN = "tok-secret-1234";
let clock = 1_700_000_000_000;
const now = () => clock;
const advanceClock = (ms) => { clock += ms; };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeAdapter({ buttons = true } = {}) {
  const a = {
    id: "fake", accountId: "default",
    capabilities: { buttons, media: true, edit: true, textLimit: 4000, chunkMode: "text", maxFileBytes: 1e6 },
    sent: [], started: false, offsets: null, inbound: null, action: null,
    async start(onInbound, offsets) { a.started = true; a.inbound = onInbound; a.offsets = offsets; },
    async stop() { a.started = false; },
    onAction(h) { a.action = h; },
    async sendText(chatId, text) { a.sent.push({ type: "text", chatId, text }); return { messageId: a.sent.length }; },
    async sendButtons(chatId, text, buttons) { a.sent.push({ type: "buttons", chatId, text, buttons }); return { messageId: a.sent.length }; },
    async editMessage(chatId, messageId, text, buttons) { a.sent.push({ type: "edit", chatId, messageId, text, buttons }); },
    async sendFile(chatId, file, caption) { a.sent.push({ type: "file", chatId, name: file.name, bytes: fs.readFileSync(file.fd, "utf8"), caption }); return { messageId: a.sent.length }; },
    emit(evt) { return a.inbound({ accountId: "default", chatType: "direct", ...evt }); },
    emitAction(act) { return a.action({ ack: async () => { a.acks = (a.acks || 0) + 1; }, ...act }); },
    texts() { return a.sent.filter((s) => s.type === "text").map((s) => s.text); },
  };
  return a;
}

// runAgent stand-in: every call stays pending until finish() resolves the latest one.
function fakeRunAgent() {
  const calls = [];
  let pendingResolve = null;
  const fn = (task, opts) => {
    calls.push({ task, opts });
    return new Promise((resolve) => { pendingResolve = resolve; });
  };
  const finish = (report) => {
    const r = pendingResolve; pendingResolve = null;
    const last = calls[calls.length - 1];
    r({ verdict: { verdict: "pass", feedback: "done" }, evidence: "EVIDENCE REPORT\nTask: t\nFinal state: ok", stages: [], runId: last.opts.runId, record: {}, ...report });
  };
  return { fn, calls, finish, busy: () => pendingResolve !== null };
}

// runTurn stand-in: finish(result) resolves, finish(null, error) rejects the latest call.
function fakeRunTurn() {
  const calls = [];
  let pending = null;
  const fn = (opts) => {
    calls.push({ opts });
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  };
  const finish = (result, error) => {
    const p = pending; pending = null;
    const last = calls[calls.length - 1];
    if (error) return p.reject(error);
    p.resolve({ text: "ok", sessionId: last.opts.claudeSessionId, usage: { input: 1, output: 1, costUsd: 0.01 }, freshStart: false, calls: [`c${calls.length}`], ...result });
  };
  return { fn, calls, finish, busy: () => pending !== null };
}

function build({ adapter, runAgent, runTurn, config, stateFile, classify, processLooksLikeOurs, killProcessGroup, timers } = {}) {
  const rand = Math.random().toString(36).slice(2);
  const state = new ChannelState(stateFile || path.join(process.env.AI_BRIDGE_HOME, `state-${rand}.json`));
  const sessions = new SessionStore(path.join(process.env.AI_BRIDGE_HOME, `sessions-${rand}.json`), { dir: path.join(process.env.AI_BRIDGE_HOME, "sessions"), now });
  process.env.MGR_PASS = "yes"; process.env.AI_BRIDGE_TELEGRAM_TOKEN = TOKEN;
  const m = new Manager({
    config: config || { fake: { token: TOKEN, dmPolicy: "pairing", allowFrom: [], codex: false, accountId: "default", envPassthrough: ["MGR_PASS"] } },
    adapters: [adapter], state, sessions, pairing,
    approvals: new Approvals({ now }),
    limiter: new RateLimiter({ now }),
    runAgent: runAgent ? runAgent.fn : undefined,
    runTurn: runTurn ? runTurn.fn : undefined,
    runModel: async ({ prompt }) => ({ result: classify ? await classify(prompt) : "read" }),
    bridgePing: async () => ({ ok: true, text: '{"pong":true,"version":"test"}' }),
    jobsTable: () => "job   mode\n toll  economy",
    log: process.env.FAKES_LOG ? (l) => console.log("LOG", l) : () => {}, now, processLooksLikeOurs, killProcessGroup, timers,
  });
  return { m, state, sessions };
}

module.exports = { TOKEN, now, advanceClock, tick, fakeAdapter, fakeRunAgent, fakeRunTurn, build };
