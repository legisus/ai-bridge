// Telegram adapter: Bot API over fetch, long-polling getUpdates. Transport only —
// policy, pairing, approvals and queueing live in the manager.
//
// Config: { token, accountId?, apiBase? }   Deps: { fetch, log, sleep, now }
// Capabilities: inline buttons, documents, message edits, 4000-char plain text.
const fs = require("fs");

const API = "https://api.telegram.org";
const POLL_TIMEOUT_S = 30;
const ALLOWED_UPDATES = ["message", "callback_query"];
const BACKOFF_MIN = 1000, BACKOFF_MAX = 30000;
const HANDLER_ATTEMPTS = 3;           // a failing inbound handler is retried this many times before the update is skipped

function makeAdapter(config, deps = {}) {
  const { token, accountId = "default", apiBase = API, pollAbortMs = (POLL_TIMEOUT_S + 10) * 1000 } = config;
  const fetchFn = deps.fetch || globalThis.fetch;
  const log = deps.log || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = (method) => `${apiBase}/bot${token}/${method}`;

  let running = false;
  let loopDone = null;
  let actionHandler = null;

  // One API call. 429 → wait retry_after and retry once; 5xx/network → wait 2 s and
  // retry once; other 4xx → permanent error. Returns the `result` field.
  async function call(method, body, { form = false, retried = false, retry = true, signal } = {}) {
    let res;
    try {
      res = form
        ? await fetchFn(url(method), { method: "POST", body, signal })
        : await fetchFn(url(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal });
    } catch (e) {
      if (retry && !retried) { await sleep(2000); return call(method, body, { form, retried: true }); }
      throw Object.assign(new Error(`telegram ${method}: ${e.message}`), { permanent: false, status: 0 });
    }
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.ok && json && json.ok) return json.result;
    const desc = (json && json.description) || `HTTP ${res.status}`;
    if (res.status === 429 && retry && !retried) {
      const after = Number(json && json.parameters && json.parameters.retry_after) || 1;
      await sleep(after * 1000);
      return call(method, body, { form, retried: true });
    }
    if (res.status >= 500 && retry && !retried) { await sleep(2000); return call(method, body, { form, retried: true }); }
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw Object.assign(new Error(`telegram ${method}: ${desc}`), { permanent, status: res.status });
  }

  function keyboard(buttons) {
    return { inline_keyboard: buttons && buttons.length ? [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] : [] };
  }

  async function handleUpdate(u, onInbound) {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!actionHandler || !cq.from || cq.from.is_bot) return;
      const msg = cq.message || {};
      await actionHandler({
        actorId: String(cq.from.id),
        chatId: String((msg.chat && msg.chat.id) || cq.from.id),
        messageId: msg.message_id,
        data: String(cq.data || ""),
        ack: (text) => call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {}),
      });
      return;
    }
    const m = u.message;
    if (!m || !m.from || m.from.is_bot) return;
    if (!m.chat || m.chat.type !== "private") return;
    await onInbound({
      accountId, senderId: String(m.from.id), chatId: String(m.chat.id), chatType: "direct",
      messageId: m.message_id, eventId: String(u.update_id), text: m.text || m.caption || "",
      attachments: m.document || m.photo ? [m.document || m.photo] : [],
      meta: { username: m.from.username, firstName: m.from.first_name, lastName: m.from.last_name },
      raw: u,
    });
  }

  async function loop(onInbound, { getOffset, setOffset }) {
    let backoff = BACKOFF_MIN;
    while (running) {
      let updates;
      try {
        const offset = (getOffset && getOffset()) ?? 0;
        // No call-level retry while polling: the loop's own backoff governs.
        // Client-side deadline: a poll that hangs (sleep, network change) is
        // aborted instead of waiting for the socket's own timeout.
        updates = await call("getUpdates", { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
          { retry: false, signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(pollAbortMs) : undefined });
        backoff = BACKOFF_MIN;
      } catch (e) {
        if (!running) break;
        log(`getUpdates failed: ${e.message}; retry in ${backoff} ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        continue;
      }
      for (const u of updates || []) {
        if (!running) break;
        // A failing handler (e.g. state write) is retried before the update is
        // given up on; the offset only moves once the update is settled.
        for (let attempt = 1; attempt <= HANDLER_ATTEMPTS; attempt++) {
          try { await handleUpdate(u, onInbound); break; }
          catch (e) {
            log(`update ${u.update_id} handler error (attempt ${attempt}/${HANDLER_ATTEMPTS}): ${e.message}`);
            if (attempt === HANDLER_ATTEMPTS) log(`update ${u.update_id} skipped after ${HANDLER_ATTEMPTS} failures`);
            else await sleep(500 * attempt);
          }
        }
        if (setOffset) {
          let delay = BACKOFF_MIN;
          while (running) {
            try { await setOffset(u.update_id + 1); break; }
            catch (e) { log(`setOffset failed: ${e.message}; retry in ${delay} ms`); await sleep(delay); delay = Math.min(delay * 2, BACKOFF_MAX); }
          }
        }
      }
    }
  }

  return {
    id: "telegram",
    accountId,
    capabilities: { buttons: true, media: true, edit: true, textLimit: 4000, chunkMode: "text", maxFileBytes: 50e6 },

    async start(onInbound, { getOffset, setOffset } = {}) {
      if (running) return;
      running = true;
      loopDone = loop(onInbound, { getOffset, setOffset }).catch((e) => log(`poll loop died: ${e.message}`));
    },
    async stop() {
      running = false;
      // The in-flight long poll returns within POLL_TIMEOUT_S; callers that need
      // a faster exit can simply drop the adapter.
      await Promise.race([loopDone || Promise.resolve(), sleep(0)]);
    },
    onAction(handler) { actionHandler = handler; },

    async sendText(chatId, text, { silent = false } = {}) {
      const r = await call("sendMessage", { chat_id: String(chatId), text: String(text), ...(silent ? { disable_notification: true } : {}) });
      return { messageId: r && r.message_id };
    },
    async sendButtons(chatId, text, buttons) {
      const r = await call("sendMessage", { chat_id: String(chatId), text: String(text), reply_markup: keyboard(buttons) });
      return { messageId: r && r.message_id };
    },
    async editMessage(chatId, messageId, text, buttons) {
      await call("editMessageText", { chat_id: String(chatId), message_id: messageId, text: String(text), reply_markup: keyboard(buttons || []) });
    },
    async sendFile(chatId, file, caption) {
      const bytes = fs.readFileSync(file.fd);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) form.append("caption", String(caption));
      form.append("document", new Blob([bytes]), file.name);
      const r = await call("sendDocument", form, { form: true });
      return { messageId: r && r.message_id };
    },
  };
}

module.exports = makeAdapter;
