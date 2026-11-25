// Popup: shows the access state and asks the service worker (the only writer
// of the access record) to grant or revoke. Everything goes through
// chrome.runtime.sendMessage; the worker validates the sender.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e && e.message || e) }));

function fmtRemaining(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

async function refresh() {
  const st = await send({ type: "access-get" });
  if (!st || !st.ok) { $("access").textContent = "unavailable"; $("result").textContent = (st && st.error) || ""; return; }
  $("session").textContent = st.session || "chrome";
  $("connected").textContent = st.connected ? "connected" : "not connected";
  $("connected").className = st.connected ? "on" : "off";
  const a = $("access");
  if (st.granted) {
    a.textContent = st.until === null ? "granted" : `granted, ${fmtRemaining(st.remainingMs)} left`;
    a.className = "on";
  } else {
    a.textContent = st.gen === 0 ? "not granted yet" : "revoked";
    a.className = "off";
  }
  $("tabs").textContent = String((st.agentTabs || []).length);
  $("grant").disabled = st.granted && st.until === null;
  $("revoke").disabled = !st.granted;
  const n = $("notices");
  n.innerHTML = "";
  for (const text of st.notices || []) {
    const div = document.createElement("div");
    div.className = "notice";
    const x = document.createElement("a"); x.textContent = "dismiss";
    x.addEventListener("click", async () => { await send({ type: "dismiss-notices" }); refresh(); });
    div.append(x, document.createTextNode(text));
    n.append(div);
  }
}

async function refreshEvents() {
  const r = await send({ type: "events-get" });
  const box = $("events");
  if (!r || !r.ok) { box.textContent = ""; return; }
  box.textContent = (r.events || []).slice(-20).reverse().map((e) => {
    const t = new Date(e.t).toLocaleTimeString();
    const d = e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}=${k === "until" ? new Date(v).toLocaleTimeString() : v}`).join(" ") : "";
    return `${t} ${e.kind}${e.reqId ? ` req ${e.reqId}` : ""}${e.tabId !== undefined ? ` tab ${e.tabId}` : ""}${e.origin ? ` ${e.origin}` : ""}${d ? ` ${d}` : ""}`;
  }).join("\n");
}

async function act(msg, done) {
  $("result").textContent = "…";
  const r = await send(msg);
  $("result").textContent = r && r.ok ? done(r) : `failed: ${(r && r.error) || "no reply"}`;
  refresh();
}

$("grant").addEventListener("click", () => act({ type: "access-set", granted: true, until: null }, () => "access granted"));
$("grant1h").addEventListener("click", () => act({ type: "access-set", granted: true, until: Date.now() + 3600e3, timed: true }, () => "access granted for 1 hour"));
$("revoke").addEventListener("click", () => act({ type: "access-set", granted: false }, () => "access revoked"));
$("revokeClose").addEventListener("click", () => act({ type: "access-set", granted: false, closeTabs: true }, () => "access revoked, agent tabs closed"));
$("closeTabs").addEventListener("click", () => act({ type: "close-agent-tabs" }, (r) => `closed ${(r.closed || []).length} tab(s)`));

refresh(); refreshEvents();
setInterval(() => { refresh(); refreshEvents(); }, 1000);
