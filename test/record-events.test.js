// Recording journal: the relay logs input commands only while a recording is active,
// never stores typed text, and pairs start/end by request id.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aib-rec-"));
const { logRecordedStep, logRecordedEnd, REC_DIR } = require("../server/record-events");
fs.mkdirSync(REC_DIR, { recursive: true });

logRecordedStep({ id: "a", cmd: "click", params: { tabId: 1, selector: "#x" } });
assert.ok(!fs.existsSync(path.join(REC_DIR, "rec-1.events.jsonl")), "nothing logged without an active recording");

fs.writeFileSync(path.join(REC_DIR, "rec-1.active"), "{}");
logRecordedStep({ id: "b", cmd: "click", params: { tabId: 1, selector: "#go" } });
logRecordedStep({ id: "c", cmd: "type", params: { tabId: 1, text: "hunter2" } });
logRecordedStep({ id: "d", cmd: "eval", params: { code: "1" } });
logRecordedEnd("b");
const lines = fs.readFileSync(path.join(REC_DIR, "rec-1.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert.strictEqual(lines.length, 3);
assert.strictEqual(lines[0].selector, "#go");
assert.strictEqual(lines[1].textLength, 7);
assert.ok(!JSON.stringify(lines).includes("hunter2"));
assert.strictEqual(lines[2].end > 0 && lines[2].id, "b");
console.log("record-events ok");
