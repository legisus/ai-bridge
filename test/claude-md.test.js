// `bridge claude-md` — snippet carries the CLI path; install is idempotent.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { snippet, install, HEADING } = require("../server/claude-md");

const s = snippet("node /x/cli.js");
assert(s.startsWith(HEADING), "snippet starts with the heading");
assert(s.includes("node /x/cli.js agent \"task description\""), "snippet embeds the CLI path in the agent line");
assert(s.includes("node /x/cli.js <cmd>"), "snippet embeds the CLI path in the command line");
assert(/Opus 5\.5 → judge → Fable 5\.1 → judge →\s+Codex Astra 6/.test(s), "snippet names the current ladder");

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claude-md-")));
const file = path.join(home, "CLAUDE.md");
const cwd = process.cwd();
process.chdir(home);
try {
  let r = install({ project: true }, "node /x/cli.js");
  assert(r.action === "created" && r.file === file, "first install creates ./CLAUDE.md");
  assert(fs.readFileSync(file, "utf8").includes(HEADING), "file has the block");
  r = install({ project: true }, "node /x/cli.js");
  assert(r.action === "exists", "second install is a no-op");
  fs.writeFileSync(file, "# mine");
  r = install({ project: true }, "node /x/cli.js");
  const t = fs.readFileSync(file, "utf8");
  assert(r.action === "appended" && t.startsWith("# mine\n\n" + HEADING), "appends after existing content with a blank line");
} finally { process.chdir(cwd); }

// --print writes the snippet to stdout and nothing to disk
const out = execFileSync(process.execPath, [path.join(__dirname, "..", "server", "cli.js"), "claude-md", "--print"], { encoding: "utf8" });
assert(out.startsWith(HEADING) && out.includes("server/cli.js agent"), "--print prints the snippet with the real path");
console.log("claude-md tests passed");
