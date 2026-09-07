// How this program is being run: from source (`node server/cli.js …`) or as the
// single-executable build (`ai-bridge …`, see scripts/build-sea.js). Everything
// that spawns or names the CLI goes through here so both forms work.
const path = require("path");

let sea = false;
try { sea = require("node:sea").isSea(); } catch {}

const CLI_JS = path.join(__dirname, "cli.js");
const SERVER_JS = path.join(__dirname, "server.js");

// Shell text that invokes the CLI (used in prompts and Claude Code tool patterns).
const SELF_CMD = sea ? process.execPath : `node ${CLI_JS}`;

// argv to spawn the CLI with the given subcommand/args.
function selfArgs(args) { return sea ? args : [CLI_JS, ...args]; }

// argv to spawn the relay server.
function serverArgs() { return sea ? ["serve"] : [SERVER_JS]; }

module.exports = { isSea: sea, SELF_CMD, selfArgs, serverArgs };
