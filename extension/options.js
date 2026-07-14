const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ token: "", port: 8765, allowlist: [], indicator: true, idleDetachMs: 120000 }).then((cfg) => {
  $("token").value = cfg.token;
  $("port").value = cfg.port;
  $("allowlist").value = (cfg.allowlist || []).join("\n");
  $("indicator").checked = cfg.indicator !== false;
  $("idleDetach").value = Math.round((cfg.idleDetachMs || 0) / 1000);
});

$("save").addEventListener("click", async () => {
  const allowlist = $("allowlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({
    token: $("token").value.trim(),
    port: Number($("port").value) || 8765,
    allowlist,
    indicator: $("indicator").checked,
    idleDetachMs: Math.max(0, Number($("idleDetach").value) || 0) * 1000,
  });
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 2000);
});
