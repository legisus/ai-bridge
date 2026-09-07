#!/usr/bin/env node
// Build the single-executable `ai-bridge` binary (Node SEA, Node ≥ 20.12):
//   1. esbuild bundles server/main.js + deps into one CommonJS file
//   2. node --experimental-sea-config writes the SEA blob
//   3. the running node binary is copied and the blob injected with postject
//   4. macOS: the copy is re-signed ad hoc (Gatekeeper rejects a modified signature)
// Output: dist/ai-bridge-<platform>-<arch> and dist/ai-bridge (same file).
// Users of the binary need no Node at all.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const EXT_ID = fs.readFileSync(path.join(ROOT, "extension", "EXTENSION_ID"), "utf8").trim();
const VERSION = require(path.join(ROOT, "package.json")).version;
const name = `ai-bridge-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const out = path.join(DIST, name);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
const bin = (n) => path.join(ROOT, "node_modules", ".bin", n + (process.platform === "win32" ? ".cmd" : ""));

fs.mkdirSync(DIST, { recursive: true });

// 1. bundle
run(bin("esbuild"), [
  "server/main.js", "--bundle", "--platform=node", "--format=cjs", "--target=node20",
  "--outfile=dist/bundle.js", "--log-level=warning",
  "--external:bufferutil", "--external:utf-8-validate",         // ws optional native addons
  `--define:__EXTENSION_ID__=${JSON.stringify(EXT_ID)}`,
]);

// 2. blob
const seaConfig = path.join(DIST, "sea-config.json");
fs.writeFileSync(seaConfig, JSON.stringify({
  main: "dist/bundle.js", output: "dist/sea-prep.blob", disableExperimentalSEAWarning: true,
}, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. copy node + inject
fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", out]);
run(process.execPath, [path.join(ROOT, "node_modules", "postject", "dist", "cli.js"), out, "NODE_SEA_BLOB", path.join(DIST, "sea-prep.blob"),
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);

// 4. sign (ad hoc; a Developer ID signature replaces this in the release pipeline)
if (process.platform === "darwin") run("codesign", ["--sign", "-", out]);

// convenience name + cleanup
const alias = path.join(DIST, process.platform === "win32" ? "ai-bridge.exe" : "ai-bridge");
try { fs.unlinkSync(alias); } catch {}
fs.copyFileSync(out, alias); fs.chmodSync(alias, 0o755);
for (const f of ["bundle.js", "sea-prep.blob", "sea-config.json"]) fs.unlinkSync(path.join(DIST, f));
const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`built ${path.relative(ROOT, out)} (${mb} MB, v${VERSION}, extension ${EXT_ID}, node ${process.version})`);
