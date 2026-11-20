#!/usr/bin/env node
// Telegram adapter against a local fake of api.telegram.org: long-poll wire format,
// inbound normalisation, offset commit ordering, callbacks, sends, 429/5xx retry, stop.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const makeAdapter = require("../server/channels/telegram.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Telegram Bot API
const TOKEN = "123:TESTTOKEN";
const requests = [];          // { method, body, headers, raw }
let pendingUpdates = [];      // served once by getUpdates
const responders = {};        // method -> [fn(req) → {status, json}] consumed in order
let failGetUpdates = 0;
let hangGetUpdates = 0;       // leave N getUpdates requests unanswered (client must time out)
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const method = req.url.split("/").pop();
    let body = null;
    if ((req.headers["content-type"] || "").startsWith("application/json")) { try { body = JSON.parse(raw.toString()); } catch {} }
    const rec = { method, body, headers: req.headers, raw, url: req.url };
    requests.push(rec);
    const reply = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (!req.url.startsWith(`/bot${TOKEN}/`)) return reply(401, { ok: false, description: "Unauthorized" });
    const q = responders[method];
    if (q && q.length) { const r = q.shift()(rec); return reply(r.status, r.json); }
    if (method === "getUpdates") {
      if (hangGetUpdates > 0) { hangGetUpdates--; return; /* never answer */ }
      if (failGetUpdates > 0) { failGetUpdates--; return reply(500, { ok: false, description: "boom" }); }
      const upd = pendingUpdates.filter((u) => u.update_id >= (body.offset || 0));
      pendingUpdates = pendingUpdates.filter((u) => u.update_id < (body.offset || 0));
      if (upd.length) return reply(200, { ok: true, result: upd });
      return setTimeout(() => reply(200, { ok: true, result: [] }), 30);
    }
    if (method === "sendMessage" || method === "editMessageText") return reply(200, { ok: true, result: { message_id: 555, chat: { id: body.chat_id } } });
    if (method === "sendDocument") return reply(200, { ok: true, result: { message_id: 556 } });
    if (method === "answerCallbackQuery") return reply(200, { ok: true, result: true });
    reply(404, { ok: false, description: `unknown method ${method}` });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const sleeps = [];
  const deps = { fetch: globalThis.fetch, log: () => {}, sleep: async (ms) => { sleeps.push(ms); }, now: Date.now };
  const adapter = makeAdapter({ token: TOKEN, apiBase, accountId: "default", pollAbortMs: 200 }, deps);

  assert(adapter.id === "telegram" && adapter.accountId === "default", "adapter: id and accountId");
  assert(JSON.stringify(adapter.capabilities) === JSON.stringify({ buttons: true, media: true, edit: true, textLimit: 4000, chunkMode: "text", maxFileBytes: 50e6 }), "adapter: capabilities");

  // ---- inbound
  const user = { id: 42, is_bot: false, first_name: "Ann", username: "ann" };
  pendingUpdates = [
    { update_id: 100, message: { message_id: 1, from: user, chat: { id: 42, type: "private" }, date: 1, text: "hello" } },
    { update_id: 101, message: { message_id: 2, from: user, chat: { id: -500, type: "group" }, date: 1, text: "group talk" } },
    { update_id: 102, message: { message_id: 3, from: { id: 7, is_bot: true, first_name: "Bot" }, chat: { id: 42, type: "private" }, date: 1, text: "bot talk" } },
    { update_id: 103, callback_query: { id: "cb1", from: user, message: { message_id: 9, chat: { id: 42, type: "private" } }, data: "ab1:intent:a:0123456789abcdef" } },
  ];
  const events = [];
  const inbound = [];
  let offset = 5;
  const actions = [];
  adapter.onAction(async (a) => { actions.push(a); events.push("action"); await a.ack(); });
  adapter.start(async (evt) => { inbound.push(evt); await wait(50); events.push(`inbound:${evt.eventId}`); },
    { getOffset: () => offset, setOffset: async (v) => { offset = v; events.push(`offset:${v}`); } });
  await wait(400);

  const polls = requests.filter((r) => r.method === "getUpdates");
  assert(polls.length >= 2, "poll: getUpdates called repeatedly");
  assert(JSON.stringify(polls[0].body.allowed_updates) === '["message","callback_query"]' && polls[0].body.timeout === 30 && polls[0].body.offset === 5, "poll: first request has allowed_updates, timeout 30, offset from getOffset");
  assert(inbound.length === 1 && inbound[0].senderId === "42" && inbound[0].chatId === "42" && inbound[0].chatType === "direct" && inbound[0].messageId === 1 &&
    inbound[0].eventId === "100" && inbound[0].text === "hello" && inbound[0].accountId === "default" && inbound[0].raw.update_id === 100, "inbound: private text normalised");
  assert(!inbound.some((e) => e.text === "group talk"), "inbound: group message dropped");
  assert(!inbound.some((e) => e.text === "bot talk"), "inbound: bot-authored message dropped");
  assert(events.indexOf("inbound:100") >= 0 && events.indexOf("inbound:100") < events.indexOf("offset:101"), "offset: committed only after the handler resolved");
  assert(events.includes("offset:102") && events.includes("offset:103"), "offset: dropped updates still advance the offset");
  assert(events.includes("offset:104"), "offset: callback update advances the offset");
  assert(polls[1].body.offset === 104, "poll: second request carries the committed offset");
  assert(actions.length === 1 && actions[0].actorId === "42" && actions[0].chatId === "42" && actions[0].messageId === 9 && actions[0].data === "ab1:intent:a:0123456789abcdef", "action: callback_query normalised");
  assert(requests.some((r) => r.method === "answerCallbackQuery" && r.body.callback_query_id === "cb1"), "action: ack posts answerCallbackQuery");

  // ---- outbound
  const sent = await adapter.sendText("42", "plain *text*");
  const sm = requests.filter((r) => r.method === "sendMessage").pop();
  assert(sm.body.chat_id === "42" && sm.body.text === "plain *text*" && !("parse_mode" in sm.body) && sent.messageId === 555, "sendText: chat_id + text, no parse_mode, returns messageId");
  assert(!("disable_notification" in sm.body), "sendText: a normal message notifies");
  await adapter.sendText("42", "quiet", { silent: true });
  assert(requests.filter((r) => r.method === "sendMessage").pop().body.disable_notification === true, "sendText: { silent } sets disable_notification");

  const btn = await adapter.sendButtons("42", "Approve?", [{ label: "Approve", data: "ab1:intent:a:0123456789abcdef" }, { label: "Cancel", data: "ab1:intent:d:0123456789abcdef" }]);
  const sb = requests.filter((r) => r.method === "sendMessage").pop();
  assert(sb.body.reply_markup && sb.body.reply_markup.inline_keyboard.length === 1 && sb.body.reply_markup.inline_keyboard[0][1].callback_data === "ab1:intent:d:0123456789abcdef" && btn.messageId === 555, "sendButtons: one inline keyboard row with callback_data");

  await adapter.editMessage("42", 555, "(no longer pending)", []);
  const ed = requests.filter((r) => r.method === "editMessageText").pop();
  assert(ed.body.chat_id === "42" && ed.body.message_id === 555 && ed.body.text === "(no longer pending)" && JSON.stringify(ed.body.reply_markup) === '{"inline_keyboard":[]}', "editMessage: edits text and clears buttons");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-tg-"));
  const fpath = path.join(tmp, "result.txt");
  fs.writeFileSync(fpath, "FILE-BYTES-HERE");
  const fd = fs.openSync(fpath, "r");
  const doc = await adapter.sendFile("42", { fd, name: "result.txt", size: 15 }, "your file");
  fs.closeSync(fd);
  const sd = requests.filter((r) => r.method === "sendDocument").pop();
  assert((sd.headers["content-type"] || "").startsWith("multipart/form-data") && sd.raw.includes("FILE-BYTES-HERE") && sd.raw.includes('filename="result.txt"') && sd.raw.includes("your file") && doc.messageId === 556,
    "sendFile: multipart upload read from the fd, with filename and caption");

  // ---- retries
  responders.sendMessage = [() => ({ status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 1 } } })];
  sleeps.length = 0;
  await adapter.sendText("42", "retry me");
  assert(sleeps.length === 1 && sleeps[0] === 1000 && requests.filter((r) => r.method === "sendMessage" && r.body.text === "retry me").length === 2, "429: slept retry_after*1000 and retried once");

  responders.sendMessage = [() => ({ status: 500, json: { ok: false, description: "internal" } })];
  sleeps.length = 0;
  await adapter.sendText("42", "retry 500");
  assert(sleeps.length === 1 && sleeps[0] === 2000, "5xx: slept 2000 and retried once");

  responders.sendMessage = [() => ({ status: 400, json: { ok: false, description: "Bad Request: chat not found" } })];
  let e400 = null; try { await adapter.sendText("42", "bad"); } catch (e) { e400 = e; }
  assert(e400 && e400.permanent === true && e400.status === 400 && /chat not found/.test(e400.message), "4xx: rejects with permanent:true and the description");

  responders.sendMessage = [() => ({ status: 500, json: { ok: false, description: "a" } }), () => ({ status: 500, json: { ok: false, description: "b" } })];
  let e500 = null; try { await adapter.sendText("42", "still bad"); } catch (e) { e500 = e; }
  assert(e500 && e500.permanent === false && e500.status === 500, "5xx twice: rejects with permanent:false");

  // ---- poll backoff
  sleeps.length = 0;
  failGetUpdates = 2;
  await wait(300);
  assert(sleeps[0] === 1000 && sleeps[1] === 2000, `poll: backoff 1000 then 2000 on consecutive failures (got ${JSON.stringify(sleeps.slice(0, 3))})`);

  // ---- stop (before the scenarios that use their own adapters against the shared fake)
  await adapter.stop();
  const before = requests.filter((r) => r.method === "getUpdates").length;
  await wait(150);
  assert(requests.filter((r) => r.method === "getUpdates").length === before, "stop: no further polls");

  // ---- handler failure: the update is retried, offset not advanced until it succeeds; after 3 failures it is skipped
  {
    sleeps.length = 0;
    let attempts = 0;
    const seen = [];
    const a2 = makeAdapter({ token: TOKEN, apiBase, accountId: "acc2", pollAbortMs: 200 }, deps);
    let off = 5000;
    pendingUpdates = [
      { update_id: 5000, message: { message_id: 50, from: user, chat: { id: 42, type: "private" }, date: 1, text: "flaky" } },
      { update_id: 5001, message: { message_id: 51, from: user, chat: { id: 42, type: "private" }, date: 1, text: "doomed" } },
      { update_id: 5002, message: { message_id: 52, from: user, chat: { id: 42, type: "private" }, date: 1, text: "fine" } },
    ];
    a2.start(async (evt) => {
      seen.push(evt.text);
      if (evt.text === "flaky" && attempts++ < 2) throw new Error("disk full");
      if (evt.text === "doomed") throw new Error("always");
    }, { getOffset: () => off, setOffset: async (v) => { off = v; } });
    await wait(900);
    assert(seen.filter((t) => t === "flaky").length === 3, "handler failure: failing update retried until it succeeds (3 attempts)");
    assert(seen.indexOf("fine") > seen.lastIndexOf("doomed") && seen.filter((t) => t === "doomed").length === 3, "handler failure: an update that fails 3 times is skipped and the batch continues");
    assert(off === 5003, "handler failure: offset ends past the whole batch");
    assert(!seen.includes("fine") || seen.indexOf("fine") > seen.indexOf("flaky"), "handler failure: later updates wait for the failing one");
    await a2.stop();
  }

  // ---- setOffset failure: logged, loop survives
  {
    let off = 6000, calls = 0, logged = [];
    const d3 = { ...deps, log: (l) => logged.push(l) };
    const a3b = makeAdapter({ token: TOKEN, apiBase, accountId: "acc3", pollAbortMs: 200 }, d3);
    pendingUpdates = [{ update_id: 6000, message: { message_id: 60, from: user, chat: { id: 42, type: "private" }, date: 1, text: "x" } }];
    a3b.start(async () => {}, { getOffset: () => off, setOffset: async (v) => { if (calls++ === 0) throw new Error("state write failed"); off = v; } });
    await wait(600);
    assert(off === 6001 && logged.some((l) => /state write failed/.test(l)), "setOffset failure: logged and retried, loop alive");
    await a3b.stop();
  }

  // ---- hung long poll: client-side timeout, loop recovers
  {
    const a4 = makeAdapter({ token: TOKEN, apiBase, accountId: "acc4", pollAbortMs: 150 }, deps);
    let off = 7000;
    hangGetUpdates = 1;
    pendingUpdates = [{ update_id: 7000, message: { message_id: 70, from: user, chat: { id: 42, type: "private" }, date: 1, text: "after hang" } }];
    const got = [];
    a4.start(async (evt) => { got.push(evt.text); }, { getOffset: () => off, setOffset: async (v) => { off = v; } });
    await wait(1500);
    assert(got.includes("after hang"), "hung poll: aborted client-side and the next poll delivers");
    await a4.stop();
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
