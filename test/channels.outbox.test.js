#!/usr/bin/env node
// Outbox: hardened collection (no symlinks, size caps, fd handles) and cleanup.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-outbox-"));
const { OUTBOX_DIR, createOutbox, collect, finish } = require("../server/channels/outbox.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

assert(OUTBOX_DIR === path.join(process.env.AI_BRIDGE_HOME, "outbox"), "OUTBOX_DIR under AI_BRIDGE_HOME");

// createOutbox
const dir = createOutbox("run1");
assert(dir === path.join(OUTBOX_DIR, "run1") && fs.existsSync(dir), "createOutbox: dir created");
assert((fs.statSync(dir).mode & 0o777) === 0o700, "createOutbox: mode 0700");

// symlink skipped, target never delivered
const secret = path.join(process.env.AI_BRIDGE_HOME, "token");
fs.writeFileSync(secret, "SECRET");
fs.symlinkSync(secret, path.join(dir, "link.txt"));
fs.writeFileSync(path.join(dir, "result.txt"), "hello");
{
  const r = collect(dir);
  assert(r.files.length === 1 && r.files[0].name === "result.txt" && r.files[0].size === 5, "collect: regular file collected with size");
  assert(fs.readFileSync(r.files[0].fd, "utf8") === "hello", "collect: fd reads the content");
  assert(r.skipped.some((s) => s.name === "link.txt" && s.reason === "symlink"), "collect: symlink skipped as 'symlink'");
  assert(!r.files.some((f) => f.name === "link.txt"), "collect: symlink target never delivered");
  finish(dir, [], r.files);
  let bad = false; try { fs.fstatSync(r.files[0].fd); } catch (e) { bad = e.code === "EBADF"; }
  assert(bad, "finish: closes fds");
  assert(fs.existsSync(path.join(dir, "result.txt")), "finish: undelivered file kept");
}
fs.unlinkSync(path.join(dir, "link.txt"));

// too large (sparse file)
{
  const big = fs.openSync(path.join(dir, "big.bin"), "w");
  fs.ftruncateSync(big, 46 * 1024 * 1024); fs.closeSync(big);
  const r = collect(dir);
  assert(r.skipped.some((s) => s.name === "big.bin" && s.reason === "too large"), "collect: 46 MB skipped as 'too large'");
  finish(dir, [], r.files);
  fs.unlinkSync(path.join(dir, "big.bin"));
}

// too many
{
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
  const r = collect(dir); // result.txt + 10 = 11
  assert(r.files.length === 10 && r.skipped.filter((s) => s.reason === "too many").length === 1, "collect: 11 files → 10 collected, 1 'too many'");
  finish(dir, [], r.files);
}

// total cap
{
  const r = collect(dir, { maxTotalBytes: 12, maxFiles: 20 });
  const total = r.files.reduce((n, f) => n + f.size, 0);
  assert(total <= 12 && r.skipped.some((s) => s.reason === "total too large"), "collect: aggregate cap enforced");
  finish(dir, [], r.files);
}

// finish subset / all
{
  const r = collect(dir);
  const names = r.files.map((f) => f.name);
  finish(dir, names.slice(0, 3), r.files);
  assert(names.slice(0, 3).every((n) => !fs.existsSync(path.join(dir, n))), "finish: delivered files removed");
  assert(names.slice(3).every((n) => fs.existsSync(path.join(dir, n))), "finish: others remain");
  const r2 = collect(dir);
  finish(dir, r2.files.map((f) => f.name), r2.files);
  assert(!fs.existsSync(dir), "finish: dir removed when empty");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
