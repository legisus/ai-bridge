#!/usr/bin/env node
// ChannelState: atomic accept (dedup + queue + offset in one write), status lifecycle, persistence.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-state-"));
const { ChannelState, STATE_FILE } = require("../server/channels/state.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const file = path.join(process.env.AI_BRIDGE_HOME, "channels-state.json");
assert(STATE_FILE === file, "STATE_FILE lives under AI_BRIDGE_HOME");

const st = new ChannelState(file);
const acc = "telegram:default";
assert(st.isSeen(acc, "1") === false, "isSeen: unseen id");
assert(st.accept({ accountKey: acc, eventId: "1", item: { runId: "r1", senderId: "1", task: "a" }, offset: 2 }) === true, "accept: first time true");
assert(st.accept({ accountKey: acc, eventId: "1", item: { runId: "r1x", senderId: "1", task: "dup" } }) === false, "accept: same id again false");
assert(st.isSeen(acc, "1") === true, "isSeen: true after accept");
assert(st.getOffset(acc) === 2, "accept: offset stored in the same call");
assert(st.queue().length === 1 && st.queue()[0].status === "queued", "accept: item queued with status queued");

// ring of 1000
for (let i = 2; i <= 1002; i++) st.accept({ accountKey: acc, eventId: String(i) });
assert(st.isSeen(acc, "1") === false, "ring: after 1001 more ids the first is forgotten");
assert(st.isSeen(acc, "1002") === true, "ring: newest id remembered");

// offsets persist
st.setOffset(acc, 1003);
assert(new ChannelState(file).getOffset(acc) === 1003, "offsets persist across instances");

// queue order and statuses
st.accept({ accountKey: acc, eventId: "q2", item: { runId: "r2", senderId: "1", task: "b" } });
st.accept({ accountKey: acc, eventId: "q3", item: { runId: "r3", senderId: "2", task: "c" } });
{
  const fresh = new ChannelState(file);
  assert(fresh.queue().map((i) => i.runId).join(",") === "r1,r2,r3", "queue: order preserved across instances");
  assert(fresh.queue().every((i) => i.status === "queued"), "queue: all queued");
}
st.setStatus("r1", "running");
st.setStatus("r2", "awaiting-approval");
{
  const fresh = new ChannelState(file);
  assert(fresh.uncertain().map((i) => i.runId).join(",") === "r1,r2", "uncertain: running + awaiting-approval");
  assert(fresh.recoverable().map((i) => i.runId).join(",") === "r3", "recoverable: only queued");
}
assert(st.remove((i) => i.senderId === "1") === 2, "remove: deletes only matching items");
assert(st.queue().length === 1 && st.queue()[0].runId === "r3", "remove: others remain");

// crash during write leaves the previous file intact
{
  const before = fs.readFileSync(file, "utf8");
  const broken = new ChannelState(file);
  broken._write = () => { throw new Error("disk full"); };
  let threw = false;
  try { broken.accept({ accountKey: acc, eventId: "crash", item: { runId: "rX", senderId: "9", task: "z" } }); } catch { threw = true; }
  assert(threw, "crash: write error propagates");
  assert(fs.readFileSync(file, "utf8") === before, "crash: previous state file intact");
  assert(!fs.readdirSync(path.dirname(file)).some((n) => n.includes(".tmp-")), "crash: no tmp leftovers");
}

// update: patch any field but status
{
  st.accept({ accountKey: "a", eventId: "p1", item: { runId: "runP0000001", channel: "fake", accountId: "default", chatId: "1", senderId: "1", task: "t" } });
  st.update("runP0000001", { pid: 4242, sessionId: "abc" });
  assert(new ChannelState(st.file).queue().find((q) => q.runId === "runP0000001").pid === 4242 && st.queue().find((q) => q.runId === "runP0000001").sessionId === "abc", "update: patch persisted");
  let e = null; try { st.update("runP0000001", { status: "done" }); } catch (err) { e = err; }
  assert(e && /setStatus/.test(e.message) && st.queue().find((q) => q.runId === "runP0000001").status === "queued", "update: status goes through setStatus");
  st.update("nope", { pid: 1 });
  assert(st.queue().length === st.queue().length, "update: unknown run id is a no-op");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
