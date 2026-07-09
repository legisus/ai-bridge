const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ token: "", port: 8765, allowlist: [] }).then((cfg) => {
  $("token").value = cfg.token;
  $("port").value = cfg.port;
  $("allowlist").value = (cfg.allowlist || []).join("\n");
});

$("save").addEventListener("click", async () => {
  const allowlist = $("allowlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({
    token: $("token").value.trim(),
    port: Number($("port").value) || 8765,
    allowlist,
  });
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 2000);
});
