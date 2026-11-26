const $ = (id) => document.getElementById(id);

const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
async function refreshAccess() {
  const st = await send({ type: "access-get" });
  if (!st || !st.ok) { $("accessState").textContent = "unavailable"; return; }
  $("manualAccess").style.display = st.autoGrant !== false ? "none" : "";
  $("accessState").textContent = st.granted ? (st.until === null ? "granted" : `granted, ${Math.max(0, Math.round(st.remainingMs / 60000))} min left`) : (st.gen === 0 ? "not granted yet" : "revoked");
  $("accessState").style.color = st.granted ? "#1e8e3e" : "#9e9e9e";
}
$("grant").addEventListener("click", async () => { await send({ type: "access-set", granted: true, until: null, source: "options" }); refreshAccess(); });
$("revoke").addEventListener("click", async () => { await send({ type: "access-set", granted: false, source: "options" }); refreshAccess(); });
refreshAccess();
setInterval(refreshAccess, 2000);

let storedToken = "";
chrome.storage.local.get({ token: "", port: 8765, allowlist: [], indicator: true, idleDetachMs: 120000, provisionedBy: "", provisionedAt: 0, session: "chrome", manualMode: false, autoGrant: true }).then((cfg) => {
  storedToken = cfg.token;
  $("autoGrant").checked = cfg.autoGrant !== false;
  $("session").value = cfg.session || "chrome";
  $("manualMode").checked = !!cfg.manualMode;
  const src = cfg.provisionedBy === "native-host" ? `token received from the native host ${cfg.provisionedAt ? "at " + new Date(cfg.provisionedAt).toLocaleString() : ""}` : (cfg.token ? "token entered manually" : "not provisioned yet");
  $("ident").textContent = `Extension ID: ${chrome.runtime.id} — ${src}`;
  $("token").value = cfg.token;
  $("port").value = cfg.port;
  $("allowlist").value = (cfg.allowlist || []).join("\n");
  $("indicator").checked = cfg.indicator !== false;
  $("idleDetach").value = Math.round((cfg.idleDetachMs || 0) / 1000);
});

$("save").addEventListener("click", async () => {
  const allowlist = $("allowlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const token = $("token").value.trim();
  const session = $("session").value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || "chrome";
  // A pasted token means the user runs the relay themselves (e.g. in Docker):
  // manual mode, so a native host on this machine never overwrites it.
  const manualMode = $("manualMode").checked || (token && token !== storedToken);
  $("manualMode").checked = manualMode;
  await chrome.storage.local.set({
    token,
    port: Number($("port").value) || 8765,
    allowlist,
    indicator: $("indicator").checked,
    idleDetachMs: Math.max(0, Number($("idleDetach").value) || 0) * 1000,
    session,
    manualMode,
    autoGrant: $("autoGrant").checked, // the worker reconciles access on this change
    provisionedBy: "manual",
  });
  storedToken = token;
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 2000);
});
