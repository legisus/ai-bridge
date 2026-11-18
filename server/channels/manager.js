// Channel manager: everything between a messenger adapter and runAgent().
//
// Owns policy + pairing, rate limits, dedup, the serial task queue, the intent
// gate, approvals (buttons or /approve text), progress, delivery (verdict,
// evidence chunks, outbox files), commands, cancel, restart recovery, logging.
// Adapters do transport only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { decide, RateLimiter } = require("./policy");
const pairingStore = require("./pairing");
const { Approvals, encode, decode, digestOf } = require("./approvals");
const { ChannelState } = require("./state");
const { chunk } = require("./chunk");
const outbox = require("./outbox");
const { cleanEnv, isInstructionPath } = require("./restricted");
const { classifyIntent, DEFAULT_KEYWORDS } = require("./intent");
const { SessionStore, parseRoute, MODELS, DEFAULT_MODEL_KEY } = require("./sessions");
const { redact } = require("./config");
const agent = require("../agent");
const journal = require("../journal");
const jobs = require("../jobs");

const MAX_TEXT = 8 * 1024;
const QUEUE_PER_SENDER = 3;
const QUEUE_GLOBAL = 10;
const PROGRESS_EVERY_MS = 15000;
const NOTICE_EVERY_MS = 60 * 60 * 1000;
const RATE_NOTICE_EVERY_MS = 60 * 1000;
const QUOTE_MAX = 1000;

const HELP = `Commands:
/ping — relay + extension health
/status — daemon uptime, queue, current run
/jobs — known jobs and their modes
/journal [days] — runs, pass rate, cost
/approve <id> yes|no — answer an approval by text
/retry — run your last task again
/cancel — stop the running task and drop your queued tasks
/new <name> [opus|fable|haiku] — start a named conversation
/sessions — list your sessions
/use <name>|agent — where plain text goes
/pause [name] — pause a session (stops its turn)
/resume <name> — unpause
/stop [name]|all — forget a session / stop everything
@<name> <text> — one message to a session
/help — this list
Anything else is a task for the browser agent, or for your current session.`;

// A bound bot (channels.json `session`) is one conversation: the session commands that
// pick or create sessions are refused, the rest control that one row.
const HELP_BOUND = `Commands:
/ping — relay + extension health
/status — daemon uptime, queue, current run, this bot's conversation
/journal [days] — runs, pass rate, cost (all channels)
/approve <id> yes|no — answer an approval by text
/retry — send your last message again
/cancel — stop the running turn and drop your queued messages
/pause — pause this conversation (stops its turn)
/resume — unpause
/stop — start the conversation over (forgets the old one)
/sessions — show this conversation
/help — this list
Plain text continues the conversation.`;

const rid = () => crypto.randomBytes(6).toString("hex");
const modelKey = (model) => Object.keys(MODELS).find((k) => MODELS[k] === model) || model;
// "claude-haiku-5-5" → "haiku-5.5" (the ladder's label where one exists).
const stageLabel = (model) => {
  const rung = agent.OPS_LADDER.find((r) => r.model === model);
  return rung ? rung.label : String(model).replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
};

class Manager {
  constructor({ config, adapters, state, pairing = pairingStore, approvals, limiter, runAgent = agent.runAgent, runModel = agent.runModel,
    bridgePing, jobsTable, log = () => {}, now = Date.now, journalApi = journal, processLooksLikeOurs = defaultProcessLooksLikeOurs,
    killProcessGroup = defaultKillProcessGroup, sessions, runTurn = agent.runTurn, timers } = {}) {
    this.config = config || {};
    this.adapters = adapters || [];
    this.state = state || new ChannelState();
    this.sessions = sessions || new SessionStore(undefined, { now });
    this.pairing = pairing;
    this.approvals = approvals || new Approvals({ now });
    this.limiter = limiter || new RateLimiter({ now });
    this.runAgent = runAgent;
    this.runTurn = runTurn;
    this.runModel = runModel;
    this.timers = timers || { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };
    this.bridgePing = bridgePing || defaultPing;
    this.jobsTable = jobsTable || (() => jobs.formatTable(jobs.loadJobs()));
    this.log = log;
    this.now = now;
    this.journal = journalApi;
    this.startedAt = now();
    this.current = null;            // { item, controller }
    this.prompts = new Map();       // approvalId -> { adapter, chatId, messageId, text }
    this.lastProgressAt = 0;
    this.draining = false;
    this.stopped = false;
    this.processLooksLikeOurs = processLooksLikeOurs;
    this.killProcessGroup = killProcessGroup;
    this.heldOwners = new Set();   // owner keys whose previous turn could not be stopped after a restart
  }

  // Identity is the full owner key (channel, account, sender); a sender id alone is not.
  ownerKeyOf(item) { return `${item.channel}:${item.accountId || "default"}:${item.senderId}`; }
  ownerOf(adapter, evt) { return { channel: adapter.id, accountId: evt.accountId || adapter.accountId || "default", senderId: String(evt.senderId), chatId: String(evt.chatId) }; }
  sameOwner(item, owner) { return item.channel === owner.channel && (item.accountId || "default") === (owner.accountId || "default") && String(item.senderId) === String(owner.senderId); }
  label(item) { return item && item.sessionName ? `[${item.sessionName}] ` : ""; }

  // Adapters and configs are per bot: (channel, accountId), never channel alone.
  adapterFor(channel, accountId = "default") {
    return this.adapters.find((a) => a.id === channel && (a.accountId || "default") === (accountId || "default"));
  }
  cfgFor(adapter) {
    const ch = this.config[adapter.id] || {};
    const bot = Array.isArray(ch.bots) ? ch.bots.find((b) => (b.accountId || "default") === (adapter.accountId || "default")) : null;
    return bot || ch;
  }
  accountKey(adapter, evt) { return `${adapter.id}:${evt.accountId || adapter.accountId || "default"}`; }
  senderKey(adapter, evt) { return `${this.accountKey(adapter, evt)}:${evt.senderId}`; }
  red(text) { return redact(text, this.config); }

  // `label` ("[turo] ") goes on every chunk; the chunker gets the remaining room.
  async send(adapter, chatId, text, { label = "" } = {}) {
    const limit = Math.max(1, (adapter.capabilities.textLimit || 4000) - label.length);
    for (const part of chunk(this.red(text), limit, adapter.capabilities.chunkMode || "text")) {
      try { await adapter.sendText(chatId, label + part); } catch (e) { this.log(`send failed to ${adapter.id}:${chatId}: ${e.message}`); }
    }
  }

  pausedLine(row) { return `session ${row.name} is paused; /resume ${row.name} or /use <other>`; }

  ageLabel(row) {
    if (!row.turns) return "never";
    const ms = Math.max(0, this.now() - Date.parse(row.lastUsedAt || 0));
    if (ms < 60e3) return "just now";
    if (ms < 3600e3) return `${Math.round(ms / 60e3)}m ago`;
    if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h ago`;
    return `${Math.round(ms / 86400e3)}d ago`;
  }

  // ---- lifecycle ---------------------------------------------------------------

  async start() {
    this.stopped = false;
    await this.recover();
    for (const adapter of this.adapters) {
      const key = `${adapter.id}:${adapter.accountId || "default"}`;
      if (adapter.onAction) adapter.onAction((action) => this.handleAction(adapter, action));
      await adapter.start((evt) => this.handleInbound(adapter, evt), {
        getOffset: () => this.state.getOffset(key),
        setOffset: async (v) => this.state.setOffset(key, v),
      });
      this.log(`adapter ${adapter.id} started`);
    }
    this.kick();
  }

  async stop() {
    this.stopped = true;
    if (this.current) this.current.controller.abort();
    for (const adapter of this.adapters) { try { await adapter.stop(); } catch {} }
    if (this.approvals.close) this.approvals.close();
  }

  // Items left running or awaiting approval by a previous daemon are never replayed.
  // A session turn's child (own process group, so it outlived the daemon) is stopped
  // first; if it cannot be confirmed gone the item stays for the next restart and the
  // owner's queued session turns are dropped rather than run behind it.
  async recover() {
    for (const item of this.state.queue().filter((q) => q.status !== "queued")) {
      const adapter = this.adapterFor(item.channel, item.accountId);   // may be gone from the config: no notice, never another bot
      if (item.status === "done" || this.hasJournal(item.runId)) {
        // The run finished; delivery was interrupted. Its verdict is in the journal.
        if (adapter) await this.send(adapter, item.chatId, `restarted; the result of "${item.task}" was lost before delivery (not delivered); see /journal`);
      } else {
        if (Number.isInteger(item.pid) && item.pid > 0 && !(await this.stopOrphan(item.pid, item.pidStartedAt))) {
          const key = this.ownerKeyOf(item);
          this.heldOwners.add(key);
          this.log(`recovery: run ${item.runId} pid ${item.pid} still alive; holding ${key}'s queued session turns`);
          if (adapter) await this.send(adapter, item.chatId, `restarted; a previous turn (run ${item.runId}) is still running and could not be stopped; your queued session messages were dropped — send them again later`);
          continue;   // kept, with its pid, for the next restart
        }
        this.journalDeclined(item, "daemon restarted while the task was running or awaiting approval; not replayed");
        if (adapter) await this.send(adapter, item.chatId, `restarted; "${item.task}" was not replayed, send it again if still wanted`);
      }
      this.state.remove((q) => q.runId === item.runId);
      this.log(`recovery: run ${item.runId} dropped (was ${item.status})`);
    }
    for (const item of this.state.queue().filter((q) => q.status === "queued" && q.sessionId && this.heldOwners.has(this.ownerKeyOf(q)))) {
      this.journalDeclined(item, "held: an earlier turn of yours could not be stopped after a restart");
      this.state.remove((q) => q.runId === item.runId);
      this.log(`recovery: run ${item.runId} dropped (owner held)`);
    }
  }

  // Stop a leftover turn's process group the way an abort does (killGroup semantics);
  // true when it is confirmed gone — or was never ours: a reused pid is left alone.
  // pid 0/1/negative and the daemon itself are never signalled (kill(-1) would reach every
  // process of the user); a pid whose identity cannot be inspected is held, not guessed.
  async stopOrphan(pid, pidStartedAt) {
    if (!(Number.isInteger(pid) && pid > 1) || pid === process.pid) return true;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
    if (!alive()) return true;
    let ours = null;
    try { ours = this.processLooksLikeOurs(pid, pidStartedAt); } catch { ours = null; }
    if (ours === null) return false;      // could not inspect: hold rather than signal or drain
    if (!ours) return true;               // a recycled pid belongs to someone else
    try { this.killProcessGroup(pid); } catch {}
    for (let i = 0; i < 10; i++) {
      if (!alive()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !alive();
  }

  journalDeclined(item, feedback) { this.journalRun(item, "declined", feedback); }

  hasJournal(runId) {
    try { return this.journal.readJournal({ days: 3650 }).some((r) => r.runId === runId); } catch { return false; }
  }

  // One journal record per run: skipped when runAgent (or a previous daemon) already wrote one.
  journalRun(item, verdict, feedback) {
    if (this.hasJournal(item.runId)) return;
    try {
      const rec = agent.journalRecord({ runId: item.runId, task: this.red(item.task), startedAt: item.acceptedAt || new Date().toISOString(), stages: [],
        verdict: { verdict, feedback: this.red(feedback) }, mode: item.sessionId ? "session" : "regular", evidence: "" });
      rec.source = `channel:${item.channel}`;
      rec.feedback = this.red(feedback);
      if (item.sessionId) { rec.session = item.sessionName; rec.sessionId = item.sessionId; }
      this.journal.appendJournal(rec);
    } catch (e) { this.log(`journal write failed: ${e.message}`); }
  }

  // ---- inbound -------------------------------------------------------------------

  async handleInbound(adapter, evt) {
    const accountKey = this.accountKey(adapter, evt);
    const eventId = evt.eventId != null ? String(evt.eventId) : null;
    if (eventId && this.state.isSeen(accountKey, eventId)) return;
    const seen = () => { if (eventId) this.state.accept({ accountKey, eventId }); };
    if (evt.chatType !== "direct") return seen();

    const cfg = this.cfgFor(adapter);
    const who = { channel: adapter.id, accountId: evt.accountId || adapter.accountId || "default", senderId: String(evt.senderId) };
    const paired = this.pairing.isApproved(who);
    const decision = decide({ policy: cfg.dmPolicy, allowFrom: cfg.allowFrom, senderId: who.senderId, paired });
    const senderKey = this.senderKey(adapter, evt);

    if (decision === "drop") { this.log(`drop ${senderKey} (policy ${cfg.dmPolicy || "pairing"})`); return seen(); }
    if (decision === "pair") {
      seen();
      if (!this.limiter.allow(senderKey, { unknown: true })) return;
      const { code } = this.pairing.request({ ...who, meta: evt.meta || {} });
      const noticeKey = `${senderKey}:pairnotice`;
      const last = this.state.getNotice(noticeKey) || 0;
      if (this.now() - last >= NOTICE_EVERY_MS) {
        this.state.setNotice(noticeKey, this.now());
        const bound = cfg.boundSession ? ` (this bot is the "${cfg.boundSession.name}" conversation; your message was not kept — send it again once paired)` : "";
        await this.send(adapter, evt.chatId, `Not paired. Code: ${code}. The operator runs: bridge pairing approve ${adapter.id} ${code}${bound}`);
        this.log(`pairing request from ${senderKey}`);
      }
      return;
    }

    // paired or allowlisted sender. Emergency controls are dispatched before the rate
    // limiter: a sender who is being throttled must still be able to stop things.
    const text0 = String(evt.text || "").trim();
    if (/^\/(cancel|stop|pause)(\s|$)/i.test(text0) && Buffer.byteLength(text0, "utf8") <= MAX_TEXT) { seen(); return this.handleCommand(adapter, evt, who, text0); }
    if (!this.limiter.allow(senderKey)) {
      seen();
      const noticeKey = `${senderKey}:ratenotice`;
      const last = this.state.getNotice(noticeKey) || 0;
      if (this.now() - last >= RATE_NOTICE_EVERY_MS) {
        this.state.setNotice(noticeKey, this.now());
        await this.send(adapter, evt.chatId, "rate limited; slow down and try again in a minute");
      }
      return;
    }
    const text = String(evt.text || "").trim();
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT) { seen(); return this.send(adapter, evt.chatId, "message too long (max 8 KB)"); }
    if (!text) { seen(); return this.send(adapter, evt.chatId, "attachments are not supported yet; send the task as text"); }
    if (text.startsWith("/")) { seen(); return this.handleCommand(adapter, evt, who, text); }

    const owner = this.ownerOf(adapter, evt);
    // A bound bot: every plain message (an @-prefixed one too) goes to its one row.
    const bound = cfg.boundSession || null;
    if (bound) {
      let row = this.sessions.get(owner, { name: bound.name });
      if (row && row.model !== bound.model) { seen(); return this.send(adapter, evt.chatId, this.modelConflictLine(row.model, bound.model)); }
      if (!row) {
        try { row = this.sessions.create(owner, bound.name, modelKey(bound.model)); this.log(`session ${row.id} (${row.name}) created for bound bot ${this.ownerKeyOf(row)}`); }
        catch (e) {
          seen();
          return this.send(adapter, evt.chatId, /max 10/.test(e.message) ? "cannot start the conversation: too many sessions on this bot (max 10); the operator can clear them" : `cannot start the conversation: ${e.message}`);
        }
      }
      if (row.state !== "active") { seen(); return this.send(adapter, evt.chatId, `session ${row.name} is paused; /resume`); }
      return this.enqueue(adapter, owner, { text, target: { kind: "session", row }, accountKey, eventId });
    }

    // a task: resolve its target (a named session, the current session, or the agent)
    const route = parseRoute(text);
    if (route.kind === "usage") { seen(); return this.send(adapter, evt.chatId, `usage: @${route.name} <message>`); }
    let target = { kind: "agent" };
    if (route.kind === "session") {
      const row = this.sessions.get(owner, { name: route.name });
      if (!row) { seen(); return this.send(adapter, evt.chatId, `no session named ${route.name}; /sessions`); }
      target = { kind: "session", row };
    } else {
      const row = this.sessions.current(owner);
      if (row) target = { kind: "session", row };
    }
    if (target.kind === "session" && target.row.state !== "active") { seen(); return this.send(adapter, evt.chatId, this.pausedLine(target.row)); }
    return this.enqueue(adapter, owner, { text: route.text, target, accountKey, eventId });
  }

  // Queue an already-routed message. `/retry` comes here too, so routing syntax is never
  // re-parsed. `record`: remember it as the owner's last message / session context.
  async enqueue(adapter, owner, { text, target, accountKey, eventId, record = true }) {
    const all = this.state.queue();
    const mine = all.filter((q) => this.sameOwner(q, owner));
    if (mine.length >= QUEUE_PER_SENDER || all.length >= QUEUE_GLOBAL) {
      if (eventId) this.state.accept({ accountKey, eventId });
      return this.send(adapter, owner.chatId, `queue full (${all.length} waiting); try again later`);
    }
    const runId = rid();
    const item = { runId, channel: adapter.id, accountId: owner.accountId, chatId: owner.chatId, senderId: owner.senderId, task: text };
    if (target.kind === "session") {
      const row = target.row;
      item.sessionId = row.id; item.sessionName = row.name; item.sessionGen = row.gen;
      if (record) item.context = this.sessions.recordInbound(owner, { text, sessionId: row.id });
      else { const r = row.recent || []; item.context = r.length && r[r.length - 1] === text ? r.slice(0, -1) : r.slice(); }
    } else if (record) {
      this.sessions.recordInbound(owner, { text, sessionId: "agent" });
    }
    this.state.accept({ accountKey, eventId, item });
    const position = this.state.queue().length;
    const label = this.label(item);
    this.log(`accepted run ${runId} from ${this.ownerKeyOf(item)}${item.sessionName ? ` [${item.sessionName}]` : ""} (position ${position})`);
    await this.send(adapter, owner.chatId, position === 1 && !this.current ? `⏳ ${label}working on it (run ${runId})` : `⏳ ${label}queued (run ${runId}, position ${position})`);
    this.kick();
  }

  // Journal and drop every queued item matching `pred`. Returns how many.
  dropQueued(pred, reason) {
    const victims = this.state.queue().filter((q) => q.status === "queued" && pred(q));
    for (const item of victims) this.journalDeclined(item, reason);
    if (victims.length) this.state.remove((q) => q.status === "queued" && pred(q));
    return victims.length;
  }

  // After the store flipped a session's state/gen: stop its running turn (only the
  // caller's own) and drop its queued turns.
  abortAndDrop(owner, sessionId, reason) {
    let aborted = false;
    if (this.current && this.sameOwner(this.current.item, owner) && this.current.item.sessionId === sessionId) { this.current.controller.abort(); aborted = true; }
    const dropped = this.dropQueued((q) => this.sameOwner(q, owner) && q.sessionId === sessionId, reason);
    return { aborted, dropped };
  }

  // ---- commands ------------------------------------------------------------------

  boundRefusal(bound) { return `this bot is bound to session ${bound.name}: plain text goes to it, /pause and /resume control it, /stop starts it over`; }
  modelConflictLine(rowModel, botModel) { return `this conversation runs on ${modelKey(rowModel)}, the bot is configured for ${modelKey(botModel)}; /stop to start over on ${modelKey(botModel)}`; }
  // The current run's text is shown only to its own owner.
  currentLine(owner) {
    if (!this.current) return "idle";
    const it = this.current.item;
    return this.sameOwner(it, owner) ? `run ${it.runId} (${it.status || "running"}): ${this.red(it.task).slice(0, 80)}` : "busy (another chat)";
  }

  // Commands on a bound bot. Returns undefined for the commands the shared handler owns.
  async handleBoundCommand(adapter, evt, owner, bound, cmd, args) {
    const chatId = evt.chatId;
    const say = async (t) => { await this.send(adapter, chatId, t); return true; };   // true = handled
    // The store is read only by the commands that need the row, so /cancel (and the
    // shared commands) keep working when channels-sessions.json cannot be read.
    const rowOf = () => this.sessions.get(owner, { name: bound.name });
    const onlyOne = `this bot only has the conversation "${bound.name}"`;
    const noRow = "no conversation yet; just send a message";
    const nameOk = args.length === 0 || (args.length === 1 && String(args[0]).toLowerCase() === bound.name);
    let row;
    switch (cmd) {
      case "/new": case "/use": return say(this.boundRefusal(bound));
      case "/start": return say(this.boundRefusal(bound) + "\n" + HELP_BOUND);
      case "/help": return say(HELP_BOUND);
      case "/status": {
        row = rowOf();
        const up = Math.round((this.now() - this.startedAt) / 1000);
        return say(`uptime: ${up}s\nqueue: ${this.state.queue().length}\ncurrent: ${this.currentLine(owner)}\nbound: ${bound.name} (${modelKey(bound.model)})\nconversation: ${row ? `${row.state}, ${row.turns} turns` : "none yet"}`);
      }
      case "/sessions": { row = rowOf(); return say(row ? `* ${row.name} (${modelKey(row.model)}, ${row.turns} turns, ${row.state}, ${this.ageLabel(row)})\ncurrent: ${row.name}` : noRow); }
      case "/pause": {
        if (!nameOk) return say(onlyOne);
        row = rowOf();
        if (!row) return say(noRow);
        this.sessions.pause(owner, row.id);
        const r = this.abortAndDrop(owner, row.id, `session ${row.name} paused`);
        return say(`paused ${row.name}${r.aborted ? "; stopped its running turn" : ""}${r.dropped ? `; dropped ${r.dropped} queued` : ""}`);
      }
      case "/resume": {
        if (!nameOk) return say(onlyOne);
        row = rowOf();
        if (!row) return say(noRow);
        this.sessions.resume(owner, row.id);
        return say(`resumed ${row.name}`);
      }
      case "/stop": {
        if (args[0] && String(args[0]).toLowerCase() === "all") return say(this.boundRefusal(bound));
        if (!nameOk) return say(onlyOne);
        row = rowOf();
        if (!row) return say(noRow);
        this.sessions.stop(owner, row.id);
        this.abortAndDrop(owner, row.id, `session ${row.name} stopped`);
        this.log(`session ${row.id} (${row.name}) stopped (bound bot)`);
        return say(`stopped ${row.name}; your next message starts a fresh conversation`);
      }
      case "/retry": {
        const lastMsg = this.sessions.last(owner);
        row = rowOf();
        if (!lastMsg || !row || lastMsg.sessionId !== row.id) return say("cannot retry: that message was not for this conversation; send a new message");
        if (row.model !== bound.model) return say(this.modelConflictLine(row.model, bound.model));
        if (row.state !== "active") return say(`session ${row.name} is paused; /resume`);
        await this.enqueue(adapter, owner, { text: lastMsg.text, target: { kind: "session", row }, accountKey: this.accountKey(adapter, evt), eventId: evt.eventId != null ? `${evt.eventId}:retry` : null, record: false });
        return true;
      }
      default: return undefined;
    }
  }

  async handleCommand(adapter, evt, who, text) {
    const [cmd, ...args] = text.split(/\s+/);
    const chatId = evt.chatId;
    const owner = this.ownerOf(adapter, evt);
    const cfg = this.cfgFor(adapter);
    if (cfg.boundSession) {
      const r = await this.handleBoundCommand(adapter, evt, owner, cfg.boundSession, cmd.toLowerCase(), args);
      if (r !== undefined) return r;
    }
    const byName = (raw) => this.sessions.get(owner, { name: raw });
    const noSuch = (raw) => this.send(adapter, chatId, `no session named ${String(raw).toLowerCase()}; /sessions`);
    switch (cmd.toLowerCase()) {
      case "/help": return this.send(adapter, chatId, HELP);
      case "/ping": {
        const r = await this.bridgePing();
        return this.send(adapter, chatId, r.ok ? `bridge ok: ${r.text}` : `bridge down: ${r.text}`);
      }
      case "/status": {
        const up = Math.round((this.now() - this.startedAt) / 1000);
        const curSession = this.sessions.current(owner);
        return this.send(adapter, chatId, `uptime: ${up}s\nqueue: ${this.state.queue().length}\ncurrent: ${this.currentLine(owner)}\nsessions: ${this.sessions.list(owner).length} (current: ${curSession ? curSession.name : "agent"})`);
      }
      case "/new": {
        if (args.length < 1 || args.length > 2) return this.send(adapter, chatId, "usage: /new <name> [opus|fable|haiku]");
        try {
          const row = this.sessions.create(owner, args[0], args[1] || DEFAULT_MODEL_KEY);
          this.log(`session ${row.id} (${row.name}) created by ${this.ownerKeyOf(row)}`);
          return this.send(adapter, chatId, `created session ${row.name} (${modelKey(row.model)}); it is now current. Plain text goes to it; /use agent to go back.`);
        } catch (e) {
          const msg = e.message === "invalid session name" ? "invalid session name: 1–24 chars of a-z 0-9 _ -"
            : e.message === "unknown model" ? "unknown model; use opus, fable or haiku" : e.message;
          return this.send(adapter, chatId, msg);
        }
      }
      case "/sessions": {
        const rows = this.sessions.list(owner);
        if (!rows.length) return this.send(adapter, chatId, "no sessions; /new <name> to create one");
        const cur = this.sessions.current(owner);
        const lines = rows.map((r) => `${cur && cur.id === r.id ? "*" : " "} ${r.name} (${modelKey(r.model)}, ${r.turns} turns, ${r.state}, ${this.ageLabel(r)})`);
        lines.push(`current: ${cur ? cur.name : "agent"}`);
        return this.send(adapter, chatId, lines.join("\n"));
      }
      case "/use": {
        if (args.length !== 1) return this.send(adapter, chatId, "usage: /use <name>|agent");
        if (args[0].toLowerCase() === "agent") { this.sessions.setCurrent(owner, null); return this.send(adapter, chatId, "current target: agent (one-shot tasks)"); }
        const row = byName(args[0]);
        if (!row) return noSuch(args[0]);
        this.sessions.setCurrent(owner, row.id);
        return this.send(adapter, chatId, `current target: ${row.name}`);
      }
      case "/pause": {
        let row;
        if (args[0]) { row = byName(args[0]); if (!row) return noSuch(args[0]); }
        else { row = this.sessions.current(owner); if (!row) return this.send(adapter, chatId, "nothing to pause; name a session"); }
        this.sessions.pause(owner, row.id);                       // durable gen bump + state first
        const r = this.abortAndDrop(owner, row.id, `session ${row.name} paused`);
        this.log(`session ${row.id} (${row.name}) paused`);
        return this.send(adapter, chatId, `paused ${row.name}${r.aborted ? "; stopped its running turn" : ""}${r.dropped ? `; dropped ${r.dropped} queued` : ""}`);
      }
      case "/resume": {
        if (args.length !== 1) return this.send(adapter, chatId, "usage: /resume <name>");
        const row = byName(args[0]);
        if (!row) return noSuch(args[0]);
        this.sessions.resume(owner, row.id);
        return this.send(adapter, chatId, `resumed ${row.name}`);
      }
      case "/stop": {
        if (args[0] && args[0].toLowerCase() === "all") {
          const n = this.sessions.pauseAll(owner);                // every gen bumped, all paused, target → agent
          let cancelled = false;
          if (this.current && this.sameOwner(this.current.item, owner)) { this.current.controller.abort(); cancelled = true; }
          const dropped = this.dropQueued((q) => this.sameOwner(q, owner), "stopped by /stop all");
          this.log(`stop all by ${this.ownerKeyOf(owner)}: ${n} sessions paused, ${dropped} queued dropped${cancelled ? ", running task cancelled" : ""}`);
          return this.send(adapter, chatId, `stopped: ${n} sessions paused, ${cancelled ? "running task cancelled" : "nothing running"}, ${dropped} queued dropped; current target is agent (plain text starts a one-shot task)`);
        }
        let row;
        if (args[0]) { row = byName(args[0]); if (!row) return noSuch(args[0]); }
        else { row = this.sessions.current(owner); if (!row) return this.send(adapter, chatId, "nothing to stop; name a session or /stop all"); }
        const cur = this.sessions.current(owner);
        const wasCurrent = !!(cur && cur.id === row.id);
        this.sessions.stop(owner, row.id);                        // row gone (and current cleared) first
        this.abortAndDrop(owner, row.id, `session ${row.name} stopped`);
        this.log(`session ${row.id} (${row.name}) stopped`);
        return this.send(adapter, chatId, wasCurrent ? `stopped ${row.name}; current target is agent (plain text starts a one-shot task)` : `stopped ${row.name}`);
      }
      case "/jobs": {
        let table; try { table = this.jobsTable(); } catch (e) { table = `jobs unavailable: ${e.message}`; }
        return this.send(adapter, chatId, table || "no jobs yet");
      }
      case "/journal": {
        const days = Math.max(1, Math.min(365, Number(args[0]) || 7));
        const recs = this.journal.readJournal({ days });
        const judged = recs.filter((r) => r.mode !== "session");   // session turns have no judge
        const turns = recs.filter((r) => r.mode === "session");
        const passes = judged.filter((r) => r.verdict === "pass").length;
        const sum = (rs) => rs.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
        const names = [...new Set(judged.map((r) => r.job).filter(Boolean))];
        return this.send(adapter, chatId, `runs: ${judged.length}, pass rate: ${judged.length ? Math.round((passes / judged.length) * 100) : 0}%\ncost: $${sum(recs).toFixed(2)} (last ${days} days)\njobs: ${names.length ? names.join(", ") : "none"}\nsession turns: ${turns.length}, $${sum(turns).toFixed(2)}`);
      }
      case "/approve": {
        const [id, ans] = args;
        if (!id || !/^(yes|no|y|n)$/i.test(ans || "")) return this.send(adapter, chatId, "usage: /approve <id> yes|no");
        const result = this.approvals.resolve({ id, actorId: who.senderId, channel: adapter.id, accountId: who.accountId, chatId: String(chatId), decision: /^y/i.test(ans) ? "a" : "d" });
        if (result === "forbidden") return this.send(adapter, chatId, "that approval is not yours; only the person who started the task can approve it");
        if (result === "stale") return this.send(adapter, chatId, "that approval is no longer pending");
        return this.send(adapter, chatId, result === "approved" ? "approved" : "declined");
      }
      case "/retry": {
        // Replays the stored last message to the target it went to, by session id — never
        // through routing again, never to a session that was paused or replaced since.
        const lastMsg = this.sessions.last(owner);
        if (!lastMsg) return this.send(adapter, chatId, "nothing to retry yet");
        let target = { kind: "agent" };
        if (lastMsg.sessionId && lastMsg.sessionId !== "agent") {
          const row = this.sessions.get(owner, { id: lastMsg.sessionId });
          if (!row) return this.send(adapter, chatId, "cannot retry: that session no longer exists");
          if (row.state !== "active") return this.send(adapter, chatId, `cannot retry: session ${row.name} is paused`);
          target = { kind: "session", row };
        }
        return this.enqueue(adapter, owner, { text: lastMsg.text, target, accountKey: this.accountKey(adapter, evt), eventId: evt.eventId != null ? `${evt.eventId}:retry` : null, record: false });
      }
      case "/cancel": {
        let n = 0;
        if (this.current && this.sameOwner(this.current.item, owner)) { this.current.controller.abort(); n++; }
        n += this.dropQueued((q) => this.sameOwner(q, owner), "cancelled by the sender");
        return this.send(adapter, chatId, n ? "stopped; actions already performed were not undone" : "nothing to cancel");
      }
      default:
        return this.send(adapter, chatId, `unknown command ${cmd}; see /help`);
    }
  }

  // ---- approvals -----------------------------------------------------------------

  // Send an approval prompt bound to a run and wait for the decision.
  async ask(adapter, item, { kind, text, signal, digest, label = "" }) {
    const { id, promise } = this.approvals.create({ runId: item.runId, kind, digest: digest || digestOf(text), channel: item.channel,
      accountId: item.accountId, chatId: item.chatId, senderId: item.senderId, signal });
    text = this.red(label + text);   // redacted before truncation; the stored body is what was sent
    const limit = adapter.capabilities.textLimit || 4000;
    let messageId = null;
    if (adapter.capabilities.buttons && adapter.sendButtons) {
      const body = text.length > limit - 20 ? text.slice(0, limit - 20) + "…" : text;
      const r = await adapter.sendButtons(item.chatId, body, [{ label: "Approve", data: encode(kind, "a", id) }, { label: "Cancel", data: encode(kind, "d", id) }]);
      messageId = r && r.messageId;
      this.prompts.set(id, { adapter, chatId: item.chatId, messageId, text: body });
    } else {
      const tail = `\nreply /approve ${id} yes or /approve ${id} no`;
      const body = (text.length + tail.length > limit ? text.slice(0, limit - tail.length - 1) + "…" : text) + tail;
      await adapter.sendText(item.chatId, body);
    }
    let decision = await promise;
    if (signal && signal.aborted) decision = "cancelled";   // /cancel while waiting is a cancel, not a decline
    this.log(`approval ${id} (${kind}) for run ${item.runId}: ${decision}`);
    return decision;
  }

  async handleAction(adapter, action) {
    const ack = typeof action.ack === "function" ? action.ack : async () => {};
    const parsed = decode(action.data);
    if (!parsed) { await ack(); return; }                 // not ours
    if (parsed.invalid) { await ack(); return; }          // ours, malformed: claimed and ignored
    const prompt = this.prompts.get(parsed.id);
    if (!this.authorized(adapter, { accountId: adapter.accountId, senderId: action.actorId })) { await ack("not paired"); return; }
    const result = this.approvals.resolve({ id: parsed.id, actorId: action.actorId, channel: adapter.id, accountId: adapter.accountId || "default",
      chatId: action.chatId, kind: parsed.kind, decision: parsed.decision });
    await ack(result === "forbidden" ? "not yours" : undefined);
    if (result === "forbidden") return;
    if (prompt && prompt.adapter !== adapter) return;   // a prompt is edited only through the bot that sent it
    const target = prompt || { adapter, chatId: action.chatId, messageId: action.messageId, text: "" };
    if (!adapter.editMessage || target.messageId == null) return;
    const suffix = result === "approved" ? "→ approved" : result === "denied" ? "→ declined" : "(no longer pending)";
    try { await adapter.editMessage(target.chatId, target.messageId, `${target.text ? target.text + "\n" : ""}${suffix}`, []); } catch (e) { this.log(`edit failed: ${e.message}`); }
    if (result !== "stale") this.prompts.delete(parsed.id);
  }

  // ---- queue worker --------------------------------------------------------------

  kick() { if (!this.draining && !this.stopped) setImmediate(() => this.drain().catch((e) => this.log(`drain failed: ${e.message}`))); }

  // Is this sender still allowed to act (policy + pairing, re-read now)?
  authorized(adapter, { accountId, senderId }) {
    const cfg = this.cfgFor(adapter);
    const who = { channel: adapter.id, accountId: accountId || adapter.accountId || "default", senderId: String(senderId) };
    return decide({ policy: cfg.dmPolicy, allowFrom: cfg.allowFrom, senderId: who.senderId, paired: this.pairing.isApproved(who) }) === "run";
  }

  async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const item = this.state.queue().find((q) => q.status === "queued");
        if (!item) break;
        await this.runOne(item);
      }
    } finally { this.draining = false; }
  }

  // Redacted first, then truncated: a token straddling the cut never survives in part.
  quote(task) { const t = this.red(task); return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX) + "…" : t; }

  // One-shot runs are journaled here (runAgent is told not to), so the record is
  // redacted and written before anything is delivered.
  journalOneShot(item, report) {
    if (this.hasJournal(item.runId)) return;
    const base = (report && report.record) || {};
    const v = (report && report.verdict) || { verdict: "fail", feedback: "no verdict" };
    const now = new Date().toISOString();
    const task = this.red(item.task);
    const rec = { ...base, runId: item.runId, task, mode: base.mode || (report && report.mode) || "regular",
      signature: journal.signatureOf({ job: base.job || null, task, domains: base.domains || [] }),   // never the raw-task signature
      startedAt: base.startedAt || item.acceptedAt || now, endedAt: base.endedAt || now, verdict: v.verdict, feedback: this.red(v.feedback || ""),
      evidence: this.red(String((report && report.evidence) || base.evidence || "")).slice(0, 4000), source: `channel:${item.channel}` };   // redact, then cut
    if (!Array.isArray(rec.stages)) rec.stages = (report && report.stages) || [];
    try { this.journal.appendJournal(rec); } catch (e) { this.log(`journal write failed: ${e.message}`); }
  }

  async runOne(item) {
    const adapter = this.adapterFor(item.channel, item.accountId);
    if (!adapter) {
      // The bot was removed from channels.json: the item is never run through another bot.
      this.journalDeclined(item, "no adapter for this bot (removed from channels.json)");
      this.state.remove((q) => q.runId === item.runId);
      this.log(`run ${item.runId} dropped: no adapter for ${item.channel}/${item.accountId || "default"}`);
      return;
    }
    const cfg = this.cfgFor(adapter);
    const controller = new AbortController();
    this.current = { item, controller };
    const setStatus = (s) => { item.status = s; this.state.setStatus(item.runId, s); };
    let dir = null;
    try {
      if (!this.authorized(adapter, item)) {
        this.journalDeclined(item, "sender no longer paired when the task came up");
        await this.send(adapter, item.chatId, `🚫 you are no longer paired; "${this.quote(item.task)}" was dropped`);
        return;
      }
      setStatus("running");
      // A bound bot runs nothing but its own conversation: items from before the binding,
      // other rows, or a row of another model are dropped here, whatever queued them.
      const bound = cfg.boundSession || null;
      if (bound) {
        if (!item.sessionId || item.sessionName !== bound.name) {
          this.journalDeclined(item, `bot is bound to session ${bound.name}`);
          await this.send(adapter, item.chatId, `🚫 dropped — this bot is bound to session ${bound.name}`);
          return;
        }
        const row = this.sessions.get({ channel: item.channel, accountId: item.accountId, senderId: item.senderId }, { id: item.sessionId });
        if (row && row.model !== bound.model) {
          this.journalDeclined(item, "model conflict with the bot's configured session model");
          await this.send(adapter, item.chatId, `🚫 [${bound.name}] ${this.modelConflictLine(row.model, bound.model)}`);
          return;
        }
      }
      if (item.sessionId) { await this.runSessionTurn(adapter, cfg, item, controller, setStatus); return; }
      // Gate 1: intent.
      const intent = await classifyIntent(item.task, {
        keywords: cfg.intentKeywords || DEFAULT_KEYWORDS,
        classify: async (prompt) => String((await this.runModel({ model: agent.MATCH_MODEL, prompt, allowedTools: [], timeoutMs: 60000, baseEnv: cleanEnv(process.env, cfg.envPassthrough) })).result || ""),
      });
      if (intent === "write") {
        setStatus("awaiting-approval");
        const decision = await this.ask(adapter, item, { kind: "intent", signal: controller.signal,
          text: `This task looks like it will send, submit or change something:\n"${this.quote(item.task)}"\nApprove?` });
        if (decision === "cancelled") {
          this.journalRun(item, "cancelled", "cancelled while awaiting approval");
          await this.send(adapter, item.chatId, `⏹ cancelled — "${this.quote(item.task)}" was not run`);
          return;
        }
        if (decision !== "approved") {
          this.journalDeclined(item, "task not approved");
          await this.send(adapter, item.chatId, `🚫 declined — "${this.quote(item.task)}" was not run`);
          return;
        }
        setStatus("running");
      }
      if (controller.signal.aborted) {
        this.journalRun(item, "cancelled", "cancelled before it started");
        await this.send(adapter, item.chatId, "⏹ cancelled before it started");
        return;
      }

      dir = outbox.createOutbox(item.runId);
      const report = await this.runAgent(item.task, {
        runId: item.runId, restricted: true, codex: cfg.codex === true, cwd: dir, signal: controller.signal, source: `channel:${item.channel}`,
        baseEnv: cleanEnv(process.env, cfg.envPassthrough), noJournal: true,
        approve: async (req) => {
          setStatus("awaiting-approval");
          const d = await this.ask(adapter, item, { kind: req.kind || "step", signal: controller.signal, digest: req.digest,
            text: `Approval needed: ${req.title}${req.detail ? "\n" + req.detail : ""}` });
          setStatus("running");
          return d;   // "approved" | "denied" | "cancelled"
        },
        onProgress: (st) => {
          const t = this.now();
          if (t - this.lastProgressAt >= PROGRESS_EVERY_MS) { this.lastProgressAt = t; this.send(adapter, item.chatId, `… ${st.stage}`); }
        },
      });
      this.journalOneShot(item, report);
      setStatus("done");
      await this.deliver(adapter, item, report, dir);
    } catch (e) {
      this.log(`run ${item.runId} error: ${e.message}`);
      try { await this.send(adapter, item.chatId, `❌ error — ${e.message}`); } catch {}
    } finally {
      try { this.state.remove((q) => q.runId === item.runId); }
      catch (e) { this.log(`run ${item.runId}: could not remove from the queue: ${e.message}`); }
      this.current = null;
    }
  }

  // ---- session turns -------------------------------------------------------------

  // Entries of a session directory that Claude would read back as instructions.
  instructionFilesIn(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => n !== outbox.RESERVED_NAME && isInstructionPath(n)).sort();
  }

  // One inbound message to a session: context intent gate → re-check (authorization,
  // row, generation, signal) → Claude turn → stop-before-send rounds → journal → done →
  // labelled delivery of the reply and this turn's files. Called inside runOne's
  // lifecycle block, so the queue item and `current` are cleaned up by runOne.
  async runSessionTurn(adapter, cfg, item, controller, setStatus) {
    const owner = { channel: item.channel, accountId: item.accountId, senderId: item.senderId, chatId: item.chatId };
    const label = this.label(item);
    const signal = controller.signal;
    const say = (text) => this.send(adapter, item.chatId, text, { label });
    // Status lines read "⏹ [turo] cancelled": emoji first, then the label.
    const status = (emoji, text) => this.send(adapter, item.chatId, `${emoji} ${label.trim()} ${text}`);
    const name = item.sessionName;
    const dir = this.sessions.dirOf(item.sessionId);
    const startedAt = item.acceptedAt || new Date().toISOString();
    const stages = [];
    const calls = [];
    const declinedNow = [];

    const writeJournal = (verdict, feedback, text) => {
      if (this.hasJournal(item.runId)) return;
      try {
        const rec = agent.journalRecord({ runId: item.runId, task: this.red(item.task), startedAt, stages, verdict: { verdict, feedback: this.red(feedback) }, mode: "session", evidence: this.red(text || "") });
        rec.source = `channel:${item.channel}`;
        rec.session = name; rec.sessionId = item.sessionId; rec.calls = calls.slice();
        if (feedback) rec.feedback = this.red(feedback);
        this.journal.appendJournal(rec);
      } catch (e) { this.log(`journal write failed: ${e.message}`); }
    };
    // Why this turn may not (or no longer) run; null when it may.
    const recheck = () => {
      if (!this.authorized(adapter, item)) return "unpaired";
      const row = this.sessions.get(owner, { id: item.sessionId });
      if (!row || row.state !== "active" || row.gen !== item.sessionGen) return "paused";
      if (signal.aborted) return "aborted";
      return null;
    };
    const whyFeedback = (why, when) => why === "unpaired" ? `sender no longer paired ${when}` : why === "aborted" ? "stopped by user" : `session paused or stopped ${when}`;

    let verdict = null, feedback = "", text = "", errorText = null, lastWhat = null, why = null;
    let since = null, timer = null, spawning = false;
    const INSTRUCTION = "INSTRUCTION_FILE";
    // A file the model saved earlier must never become Claude's instructions. Checked
    // before the gate and again immediately before every physical spawn.
    const quarantine = () => {
      const bad = this.instructionFilesIn(dir);
      if (!bad.length) return null;
      outbox.stash(dir, bad, path.join(dir, outbox.RESERVED_NAME, `quarantine-${item.runId}`));
      this.log(`run ${item.runId}: instruction file(s) in session ${item.sessionId}: ${bad.join(", ")} — quarantined, turn refused`);
      return Object.assign(new Error(`the session directory contained an instruction file (${bad.join(", ")}); moved to leftover/quarantine-${item.runId}`), { code: INSTRUCTION });
    };
    // One physical Claude call. The progress line goes out only while one is in flight.
    const spawn = async (row, { turnText, authorized, resumeNow, retryFresh, stageName }) => {
      const planted = quarantine();
      if (planted) throw planted;
      spawning = true;
      try {
        const res = await this.runTurn({
          model: row.model, text: turnText, claudeSessionId: row.claudeSessionId, resume: resumeNow, retryFresh, cwd: dir,
          systemPrompt: agent.turnNote({ turn: row.turns + 1, authorized, declined: row.declined || [] }),
          envPassthrough: cfg.envPassthrough, signal,
          onSpawn: (pid) => this.state.update(item.runId, { pid, pidStartedAt: new Date().toISOString() }),
        });
        stages.push({ stage: stageName, ...res.usage });
        calls.push(...(res.calls || []));
        return res.text;
      } finally {
        spawning = false;
        try { this.state.update(item.runId, { pid: null }); } catch {}
      }
    };

    // Everything that can fail runs inside one lifecycle block, so every accepted turn
    // ends with exactly one journal record and one labelled message.
    try {
      if (this.heldOwners.has(this.ownerKeyOf(item))) {
        why = "held"; verdict = "declined"; feedback = "held: an earlier turn of yours could not be stopped after a restart";
      } else if ((why = recheck())) {
        verdict = why === "aborted" ? "cancelled" : "declined"; feedback = whyFeedback(why, "when the turn came up");
      } else {
        const planted = quarantine();
        if (planted) throw planted;
        since = outbox.snapshot(dir);   // once; continuations add to the same turn

        // Gate: intent, with the conversation's earlier messages as context.
        const intent = await classifyIntent(item.task, {
          keywords: cfg.intentKeywords || DEFAULT_KEYWORDS, context: item.context || [],
          classify: async (prompt) => String((await this.runModel({ model: agent.MATCH_MODEL, prompt, allowedTools: [], timeoutMs: 60000, baseEnv: cleanEnv(process.env, cfg.envPassthrough) })).result || ""),
        });
        let gate = "approved";
        if (intent === "write") {
          setStatus("awaiting-approval");
          gate = await this.ask(adapter, item, { kind: "intent", signal, label,
            text: `This message looks like it will send, submit or change something:\n"${this.quote(item.task)}"\nApprove?` });
          setStatus("running");
        }
        if (gate === "cancelled") { why = "intent"; verdict = "cancelled"; feedback = "cancelled while awaiting approval"; }
        else if (gate !== "approved") { why = "intent"; verdict = "declined"; feedback = "message not approved"; }
        else if ((why = recheck())) {
          verdict = why === "aborted" ? "cancelled" : "declined"; feedback = whyFeedback(why, "before the turn ran");
        } else {
          const row = this.sessions.get(owner, { id: item.sessionId });
          const resume = row.started;                // decided before the durable flag flips
          if (!resume) this.sessions.markStarted(row.id);
          const stage = stageLabel(row.model);
          timer = this.timers.setInterval(() => { if (spawning) status("…", "thinking").catch(() => {}); }, PROGRESS_EVERY_MS);
          text = await spawn(row, { turnText: item.task, authorized: null, resumeNow: resume, retryFresh: row.turns === 0, stageName: `turn:${stage}` });
          let rounds = 0;
          for (;;) {
            const what = agent.lastNeedsApprovalLine(text);
            if (!what) { verdict = "reply"; break; }
            lastWhat = what;
            if (rounds >= 3) { declinedNow.push(what); verdict = "declined"; feedback = `not approved within the limit: ${what}`; break; }
            rounds++;
            setStatus("awaiting-approval");
            const decision = await this.ask(adapter, item, { kind: "step", signal, label, text: `Approval needed: ${what}`, digest: crypto.createHash("sha256").update(what).digest("hex") });
            if (decision === "cancelled") { verdict = "cancelled"; feedback = "stopped by user; actions already performed were not undone"; break; }
            if (decision !== "approved") { declinedNow.push(what); verdict = "declined"; feedback = `not approved: ${what}`; break; }
            setStatus("running");
            if ((why = recheck())) { verdict = why === "aborted" ? "cancelled" : "declined"; feedback = whyFeedback(why, "before the continuation"); break; }
            text = await spawn(row, { turnText: `approved: ${what}; proceed and report`, authorized: what, resumeNow: true, retryFresh: false, stageName: `turn:${stage}(approved)` });
          }
        }
      }
    } catch (e) {
      if (signal.aborted || (e && e.name === "AbortError")) { verdict = "cancelled"; feedback = "stopped by user; actions already performed were not undone"; }
      else if (e && e.code === INSTRUCTION) { verdict = "fail"; feedback = e.message; errorText = `refused: ${e.message}`; }
      else if (/No conversation found with session ID/.test(String(e && e.message))) {
        verdict = "fail"; feedback = "transcript missing";
        errorText = `this session's conversation is no longer available (Claude keeps transcripts ~30 days); ${cfg.boundSession ? "/stop, then send a new message" : `/stop ${name} and /new ${name} to start over`}`;
      } else { verdict = "fail"; feedback = String(e && e.message); errorText = `error — ${feedback}`; this.log(`run ${item.runId} error: ${feedback}`); }
    } finally {
      if (timer != null) this.timers.clearInterval(timer);
      try { this.state.update(item.runId, { pid: null }); } catch {}
    }

    // Terminal: journal first, then the row (only if Claude ran), then `done`, then the user.
    writeJournal(verdict, feedback, text);
    if (stages.length && (verdict === "reply" || verdict === "declined")) {
      this.sessions.complete(item.sessionId, item.sessionGen, { declined: declinedNow, countTurn: true });
    }
    setStatus("done");
    this.log(`run ${item.runId} [${name}] ${verdict}${feedback ? `: ${feedback}` : ""}`);
    if (verdict === "reply") return this.deliverTurn(adapter, item, text, dir, since);
    if (verdict === "cancelled") await status("⏹", why === "intent" ? `cancelled — "${this.quote(item.task)}" was not run` : "cancelled");
    else if (verdict === "declined") {
      if (why === "held") await status("🚫", "dropped — an earlier turn of yours could not be stopped after a restart");
      else if (why === "unpaired") await status("🚫", "you are no longer paired");
      else if (why === "paused") await status("🚫", "dropped — session paused or stopped");
      else if (why === "intent") await status("🚫", `declined — "${this.quote(item.task)}" was not run`);
      else if (/within the limit/.test(feedback)) await status("⏹", `stopped: "${lastWhat}" was not approved within the limit`);
      else await status("🚫", `not approved: ${lastWhat}`);
    } else {
      await status("❌", errorText || `error — ${feedback}`);
      if (!/^refused: |no longer available/.test(errorText || "")) await say("reply /retry to send it again");
    }
    // Whatever the outcome, files this turn produced are never stranded in the cwd.
    if (since) await this.stashTurnFiles(adapter, item, dir, since, verdict);
  }

  // A turn that ended without a reply: close and move its files to leftover/<runId>/
  // and say so once, so the next turn's snapshot does not bury them.
  async stashTurnFiles(adapter, item, dir, since, verdict) {
    const { files, skipped } = outbox.collect(dir, { since });
    outbox.finish(dir, [], files, { keepDir: true });
    const names = files.map((f) => f.name).concat(skipped.map((s) => s.name));
    if (!names.length) return;
    const moved = outbox.stash(dir, names, path.join(dir, outbox.RESERVED_NAME, item.runId));
    if (moved.length) await this.send(adapter, item.chatId, `kept ${moved.length} file(s) in leftover/${item.runId}: ${moved.map((n) => `${n} (turn ${verdict})`).join(", ")}`, { label: this.label(item) });
  }

  // The reply, then the files this turn produced (by the pre-turn snapshot). Undelivered
  // ones move to leftover/<runId>/ and are reported once; the session dir is kept.
  async deliverTurn(adapter, item, text, dir, since) {
    const label = this.label(item);
    await this.send(adapter, item.chatId, text, { label });
    const { files, skipped } = outbox.collect(dir, { since, maxFileBytes: Math.min(45e6, adapter.capabilities.maxFileBytes || 45e6) });
    const delivered = [];
    const kept = [];
    try {
      for (const f of files) {
        if (!adapter.capabilities.media || !adapter.sendFile) { kept.push({ name: f.name, reason: "this channel cannot receive files" }); continue; }
        try { await adapter.sendFile(item.chatId, f, label + f.name); delivered.push(f.name); }
        catch (e) { this.log(`file ${f.name} not delivered: ${e.message}`); kept.push({ name: f.name, reason: "send failed" }); }
      }
      for (const s of skipped) kept.push(s);
    } finally { outbox.finish(dir, delivered, files, { keepDir: true }); }
    if (kept.length) {
      outbox.stash(dir, kept.map((k) => k.name), path.join(dir, outbox.RESERVED_NAME, item.runId));
      await this.send(adapter, item.chatId, `kept ${kept.length} file(s) in leftover/${item.runId}: ${kept.map((k) => `${k.name} (${k.reason})`).join(", ")}`, { label });
    }
  }

  async deliver(adapter, item, report, dir) {
    const v = (report && report.verdict) || { verdict: "fail", feedback: "no verdict" };
    const icon = { pass: "✅", fail: "❌", declined: "🚫", cancelled: "⏹" }[v.verdict] || "❔";
    await this.send(adapter, item.chatId, `${icon} ${v.verdict}${v.feedback ? " — " + v.feedback : ""}`);
    if (report && report.evidence) await this.send(adapter, item.chatId, report.evidence);
    if (v.verdict === "fail") await this.send(adapter, item.chatId, "reply /retry to run again");
    if (!dir) return;
    const { files, skipped } = outbox.collect(dir, { maxFileBytes: Math.min(45e6, adapter.capabilities.maxFileBytes || 45e6) });
    const delivered = [];
    for (const f of files) {
      if (!adapter.capabilities.media || !adapter.sendFile) { await this.send(adapter, item.chatId, `file ready but this channel cannot receive files: ${f.name}`); continue; }
      try { await adapter.sendFile(item.chatId, f, f.name); delivered.push(f.name); }
      catch (e) { this.log(`file ${f.name} not delivered: ${e.message}`); await this.send(adapter, item.chatId, `could not send ${f.name}: ${e.message}`); }
    }
    for (const s of skipped) await this.send(adapter, item.chatId, `skipped: ${s.name} (${s.reason})`);
    outbox.finish(dir, delivered, files);
  }
}

// Same signal an abort sends (agent.js killGroup): the whole process group, then the
// pid itself as a fallback. Guarded against pid ≤ 1 by the caller.
function defaultKillProcessGroup(pid) {
  if (!(Number.isInteger(pid) && pid > 1)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

// Is this pid the model child we recorded? A pid can be recycled after a crash or a
// reboot, so the command must look like ours (claude/node) AND the process must have
// started when we recorded it (ps lstart within START_TOLERANCE_MS of pidStartedAt).
// Returns true/false, or null when ps could not tell us (the caller then holds).
const START_TOLERANCE_MS = 15000;
function defaultProcessLooksLikeOurs(pid, pidStartedAt) {
  if (pid === process.pid) return false;
  const { execFileSync } = require("child_process");
  // Two queries: combined columns truncate the command name on macOS.
  const ps = (col) => execFileSync("ps", ["-o", `${col}=`, "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  let command, lstart;
  try { command = ps("command"); lstart = ps("lstart"); }
  catch { return null; }
  if (!command || !lstart) return false;                    // no such process any more
  if (!/(^|\/)(claude|node)(\s|$)/i.test(command)) return false;
  const started = Date.parse(lstart);
  const recorded = Date.parse(pidStartedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(recorded)) return null;
  return Math.abs(started - recorded) <= START_TOLERANCE_MS;
}

async function defaultPing() {
  const { spawn } = require("child_process");
  const { selfArgs } = require("../runtime");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, selfArgs(["ping"]), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ ok: code === 0, text: (code === 0 ? out : err || out).trim() }));
    child.on("error", (e) => resolve({ ok: false, text: e.message }));
  });
}

module.exports = { Manager, HELP, QUEUE_PER_SENDER, QUEUE_GLOBAL, PROGRESS_EVERY_MS };
