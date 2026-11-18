#!/usr/bin/env node
// Outbox: hardened collection (no symlinks, size caps, fd handles) and cleanup.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-outbox-"));
const { OUTBOX_DIR, createOutbox, collect, finish, snapshot, stash, RESERVED_NAME } = require("../server/channels/outbox.js");

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

// per-turn collection on a persistent (session) directory
{
  const sdir = path.join(process.env.AI_BRIDGE_HOME, "sessions", "abc"); fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sdir, "old.txt"), "old");
  fs.mkdirSync(path.join(sdir, "leftover", "run1"), { recursive: true }); fs.writeFileSync(path.join(sdir, "leftover", "run1", "x"), "x");
  const before = snapshot(sdir);
  assert(before.size === 1 && before.get("old.txt").size === 3 && typeof before.get("old.txt").ino === "number" && typeof before.get("old.txt").mtimeMs === "number" && RESERVED_NAME === "leftover", "snapshot: names with ino/mtime/size, leftover excluded");
  assert(snapshot(path.join(sdir, "nope")).size === 0, "snapshot: missing dir is an empty map");
  fs.writeFileSync(path.join(sdir, "new.txt"), "new");
  fs.writeFileSync(path.join(sdir, "leftover", "run1", "y"), "y");   // the reserved dir changed
  {
    const r = collect(sdir, { since: before });
    assert(r.files.length === 1 && r.files[0].name === "new.txt" && r.skipped.length === 0, "collect since: only entries new since the snapshot; the leftover dir is neither collected nor reported");
    finish(sdir, ["new.txt"], r.files, { keepDir: true });
  }
  {
    const r = collect(sdir);
    assert(r.files.length === 1 && r.files[0].name === "old.txt" && r.skipped.length === 0, "collect without since: leftover still excluded, old file collected");
    finish(sdir, [], r.files, { keepDir: true });
  }
  fs.unlinkSync(path.join(sdir, "old.txt"));
  finish(sdir, [], [], { keepDir: true });
  assert(fs.existsSync(sdir), "finish keepDir: directory survives");
  fs.writeFileSync(path.join(sdir, "left.txt"), "x");
  const moved = stash(sdir, ["left.txt", "missing.txt", "leftover"], path.join(sdir, "leftover", "run9"));
  assert(JSON.stringify(moved) === '["left.txt"]' && fs.readFileSync(path.join(sdir, "leftover", "run9", "left.txt"), "utf8") === "x" && !fs.existsSync(path.join(sdir, "left.txt")) && fs.existsSync(path.join(sdir, "leftover", "run1", "x")), "stash: moves undelivered files into leftover/<runId>; never moves the reserved dir itself");
  assert((fs.statSync(path.join(sdir, "leftover", "run9")).mode & 0o777) === 0o700, "stash: destination created 0700");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
