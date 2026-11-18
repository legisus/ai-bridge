// Channel manager: everything between a messenger adapter and runAgent().
//
// Owns policy + pairing, rate limits, dedup, the serial task queue, the intent
// gate, approvals (buttons or /approve text), progress, delivery (verdict,
// evidence chunks, outbox files), commands, cancel, restart recovery, logging.
// Adapters do transport only.
const crypto = require("crypto");
const { decide, RateLimiter } = require("./policy");
const pairingStore = require("./pairing");
const { Approvals, encode, decode, digestOf } = require("./approvals");
const { ChannelState } = require("./state");
const { chunk } = require("./chunk");
const outbox = require("./outbox");
const { cleanEnv } = require("./restricted");
const { classifyIntent, DEFAULT_KEYWORDS } = require("./intent");
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
/help — this list
Anything else is a task for the browser agent.`;

const rid = () => crypto.randomBytes(6).toString("hex");

class Manager {
  constructor({ config, adapters, state, pairing = pairingStore, approvals, limiter, runAgent = agent.runAgent, runModel = agent.runModel,
    bridgePing, jobsTable, log = () => {}, now = Date.now, journalApi = journal, processLooksLikeOurs = defaultProcessLooksLikeOurs,
    killProcessGroup = defaultKillProcessGroup } = {}) {
    this.config = config || {};
    this.adapters = adapters || [];
    this.state = state || new ChannelState();
    this.pairing = pairing;
    this.approvals = approvals || new Approvals({ now });
    this.limiter = limiter || new RateLimiter({ now });
    this.runAgent = runAgent;
    this.runModel = runModel;
    this.bridgePing = bridgePing || defaultPing;
    this.jobsTable = jobsTable || (() => jobs.formatTable(jobs.loadJobs()));
    this.log = log;
    this.now = now;
    this.journal = journalApi;
    this.startedAt = now();
    this.current = null;            // { item, controller }
    this.lastTask = new Map();      // senderKey -> task text
    this.prompts = new Map();       // approvalId -> { adapter, chatId, messageId, text }
    this.lastProgressAt = 0;
    this.draining = false;
    this.stopped = false;
    this.processLooksLikeOurs = processLooksLikeOurs;
    this.killProcessGroup = killProcessGroup;
    this.heldOwners = new Set();   // owner keys whose previous turn could not be stopped after a restart
  }

  ownerKeyOf(item) { return `${item.channel}:${item.accountId || "default"}:${item.senderId}`; }

  adapterFor(channel) { return this.adapters.find((a) => a.id === channel); }
  cfgFor(adapter) { return this.config[adapter.id] || {}; }
  accountKey(adapter, evt) { return `${adapter.id}:${evt.accountId || adapter.accountId || "default"}`; }
  senderKey(adapter, evt) { return `${this.accountKey(adapter, evt)}:${evt.senderId}`; }
  red(text) { return redact(text, this.config); }

  async send(adapter, chatId, text) {
    for (const part of chunk(this.red(text), adapter.capabilities.textLimit || 4000, adapter.capabilities.chunkMode || "text")) {
      try { await adapter.sendText(chatId, part); } catch (e) { this.log(`send failed to ${adapter.id}:${chatId}: ${e.message}`); }
    }
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
      const adapter = this.adapterFor(item.channel);
      if (item.status === "done" || this.hasJournal(item.runId)) {
        // The run finished; delivery was interrupted. Its verdict is in the journal.
        if (adapter) await this.send(adapter, item.chatId, `restarted; the result of "${item.task}" was lost before delivery (not delivered); see /journal`);
      } else {
        if (Number.isInteger(item.pid) && item.pid > 0 && !(await this.stopOrphan(item.pid))) {
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
  // pid 0/1/negative are never signalled (kill(-1) would reach every process of the user).
  async stopOrphan(pid) {
    if (!(Number.isInteger(pid) && pid > 1)) return true;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
    if (!alive()) return true;
    let ours = false;
    try { ours = !!this.processLooksLikeOurs(pid); } catch { ours = false; }
    if (!ours) return true;
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
      const rec = agent.journalRecord({ runId: item.runId, task: item.task, startedAt: item.acceptedAt || new Date().toISOString(), stages: [],
        verdict: { verdict, feedback }, mode: item.sessionId ? "session" : "regular", evidence: "" });
      rec.source = `channel:${item.channel}`;
      rec.feedback = feedback;
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
        await this.send(adapter, evt.chatId, `Not paired. Code: ${code}. The operator runs: bridge pairing approve ${adapter.id} ${code}`);
        this.log(`pairing request from ${senderKey}`);
      }
      return;
    }

    // paired or allowlisted sender
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
    if (text.length > MAX_TEXT) { seen(); return this.send(adapter, evt.chatId, "message too long (max 8 KB)"); }
    if (!text) { seen(); return this.send(adapter, evt.chatId, "attachments are not supported yet; send the task as text"); }
    if (text.startsWith("/")) { seen(); return this.handleCommand(adapter, evt, who, text); }

    // a task
    const mine = this.state.queue().filter((q) => q.channel === adapter.id && q.senderId === who.senderId);
    const all = this.state.queue();
    if (mine.length >= QUEUE_PER_SENDER || all.length >= QUEUE_GLOBAL) {
      seen();
      return this.send(adapter, evt.chatId, `queue full (${all.length} waiting); try again later`);
    }
    const runId = rid();
    const item = { runId, channel: adapter.id, accountId: who.accountId, chatId: String(evt.chatId), senderId: who.senderId, task: text };
    this.state.accept({ accountKey, eventId, item });
    this.lastTask.set(senderKey, text);
    const position = this.state.queue().length;
    this.log(`accepted run ${runId} from ${senderKey} (position ${position})`);
    await this.send(adapter, evt.chatId, position === 1 && !this.current ? `⏳ working on it (run ${runId})` : `⏳ queued (run ${runId}, position ${position})`);
    this.kick();
  }

  // ---- commands ------------------------------------------------------------------

  async handleCommand(adapter, evt, who, text) {
    const [cmd, ...args] = text.split(/\s+/);
    const chatId = evt.chatId;
    const senderKey = this.senderKey(adapter, evt);
    switch (cmd.toLowerCase()) {
      case "/help": return this.send(adapter, chatId, HELP);
      case "/ping": {
        const r = await this.bridgePing();
        return this.send(adapter, chatId, r.ok ? `bridge ok: ${r.text}` : `bridge down: ${r.text}`);
      }
      case "/status": {
        const up = Math.round((this.now() - this.startedAt) / 1000);
        const cur = this.current ? `run ${this.current.item.runId} (${this.current.item.status || "running"}): ${this.current.item.task.slice(0, 80)}` : "idle";
        return this.send(adapter, chatId, `uptime: ${up}s\nqueue: ${this.state.queue().length}\ncurrent: ${cur}`);
      }
      case "/jobs": {
        let table; try { table = this.jobsTable(); } catch (e) { table = `jobs unavailable: ${e.message}`; }
        return this.send(adapter, chatId, table || "no jobs yet");
      }
      case "/journal": {
        const days = Math.max(1, Math.min(365, Number(args[0]) || 7));
        const recs = this.journal.readJournal({ days });
        const passes = recs.filter((r) => r.verdict === "pass").length;
        const cost = recs.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
        const names = [...new Set(recs.map((r) => r.job).filter(Boolean))];
        return this.send(adapter, chatId, `runs: ${recs.length}, pass rate: ${recs.length ? Math.round((passes / recs.length) * 100) : 0}%\ncost: $${cost.toFixed(2)} (last ${days} days)\njobs: ${names.length ? names.join(", ") : "none"}`);
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
        const task = this.lastTask.get(senderKey);
        if (!task) return this.send(adapter, chatId, "nothing to retry yet");
        return this.handleInbound(adapter, { ...evt, eventId: `${evt.eventId}:retry`, text: task });
      }
      case "/cancel": {
        let n = 0;
        if (this.current && this.current.item.channel === adapter.id && this.current.item.senderId === who.senderId) { this.current.controller.abort(); n++; }
        n += this.state.remove((q) => q.channel === adapter.id && q.senderId === who.senderId && q.status === "queued");
        return this.send(adapter, chatId, n ? "stopped; actions already performed were not undone" : "nothing to cancel");
      }
      default:
        return this.send(adapter, chatId, `unknown command ${cmd}; see /help`);
    }
  }

  // ---- approvals -----------------------------------------------------------------

  // Send an approval prompt bound to a run and wait for the decision.
  async ask(adapter, item, { kind, text, signal, digest }) {
    const { id, promise } = this.approvals.create({ runId: item.runId, kind, digest: digest || digestOf(text), channel: item.channel,
      accountId: item.accountId, chatId: item.chatId, senderId: item.senderId, signal });
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

  quote(task) { return task.length > QUOTE_MAX ? task.slice(0, QUOTE_MAX) + "…" : task; }

  async runOne(item) {
    const adapter = this.adapterFor(item.channel);
    if (!adapter) { this.state.remove((q) => q.runId === item.runId); return; }
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
        baseEnv: cleanEnv(process.env, cfg.envPassthrough),
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

// Is this pid one of our model children (claude/node)? A pid can be reused after a
// crash; a stranger is never signalled.
// Same signal an abort sends (agent.js killGroup): the whole process group, then the
// pid itself as a fallback. Guarded against pid ≤ 1 by the caller.
function defaultKillProcessGroup(pid) {
  if (!(Number.isInteger(pid) && pid > 1)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

function defaultProcessLooksLikeOurs(pid) {
  const { execFileSync } = require("child_process");
  try { return /claude|node/i.test(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString()); }
  catch { return false; }
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
