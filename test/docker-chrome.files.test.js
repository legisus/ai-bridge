#!/usr/bin/env node
// Source-level guards for deploy/docker-chrome (docs/DOCKER-CHROME.md): what the
// files must and must never SAY. These are structural checks — they match text
// in the sources. They prove that a flag, a bound or a guard is written down,
// not that it works: behaviour is tested by test/docker-chrome.helper.test.sh
// (the helper against a stand-in docker), test/docker-chrome-loop.sh (the Chrome
// loop and the stop script as processes, in containers) and
// test/docker-chrome-smoke.sh (the real thing; both need Docker and are not part
// of `npm test`).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const code = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // without comment lines

const dockerfile = read("deploy/docker-chrome/Dockerfile");
const start = read("deploy/docker-chrome/chrome-start.sh");
const compose = read("deploy/docker-chrome/compose.yml");
const helper = read("bin/bridge-docker");
const relay = read("deploy/docker-chrome/root/etc/s6-overlay/s6-rc.d/svc-relay/run");
const provision = read("deploy/docker-chrome/provision.py");
const stop = read("deploy/docker-chrome/chrome-stop.sh");

// image: Google Chrome on a browser-less base, never Chromium
assert(/^ARG BASE_IMAGE=ghcr\.io\/linuxserver\/baseimage-selkies@sha256:[0-9a-f]{64}$/m.test(dockerfile), "base image is the browser-less Selkies base, pinned by a full digest");
assert(!/linuxserver\/chromium/.test(code(dockerfile)), "the Chromium image is not the base");
assert(!/apt-get install[^\n;]*\bchromium/.test(code(dockerfile)) && !/\bsnap install/.test(code(dockerfile)), "no Chromium package is installed");
assert(/google-chrome-stable_current_\$\{arch\}\.deb/.test(dockerfile) && /dpkg-deb -f \/tmp\/chrome\.deb Package\)" = google-chrome-stable/.test(dockerfile), "Chrome comes from Google's .deb and the package name is checked");
assert(/chromium package present/.test(dockerfile) && /another browser executable present/.test(dockerfile), "the build fails when a Chromium package or a second browser executable is present");
assert(/sha256sum \/tmp\/chrome\.deb/.test(dockerfile) && /CHROME_DEB_SHA256/.test(dockerfile), "the Chrome package checksum is recorded (and verified when pinned)");
assert(/COPY extension \.\/extension/.test(dockerfile) && !/^extension$/m.test(read(".dockerignore")), "the extension is copied into the image (and not excluded from the build context)");

// Chrome flags
const flags = code(start);
for (const bad of ["--no-sandbox", "--test-type", "--simulate-outdated-no-au", "--headless", "--disable-setuid-sandbox", "--enable-automation", "--remote-debugging-address", "--remote-allow-origins", "--load-extension"]) {
  assert(!flags.includes(bad), `chrome-start.sh never passes ${bad}`);
}
for (const good of ['--user-data-dir="$PROFILE"', '--remote-debugging-port="$DEBUG_PORT"', "--enable-unsafe-extension-debugging", "--password-store=basic", "--ozone-platform=wayland", "--no-first-run", "--start-maximized", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]) {
  assert(flags.includes(good), `chrome-start.sh passes ${good}`);
}
assert(/PROFILE="\$\{CHROME_PROFILE_DIR:-\/config\/profile\}"/.test(start), "the profile directory is explicit and not Chrome's default (the debug port needs that)");
assert(/pgrep -x chrome/.test(start) && !/pkill -f|pkill[^\n]*chrome/.test(code(start)) && !/pkill/.test(code(helper)), "Chrome is matched by process name; nothing pkills Chrome by pattern");
assert(/\.chrome-profile\.lock/.test(start) && /dirname "\$PROFILE"/.test(start), "structure: the Chrome loop's lock file is on the profile volume");
assert(!/9>&-\s*&\s*\n\s*CHROME_PID=/.test(start) && !/"\$START_URL"[^\n]*9>&-/.test(start), "structure: the Chrome start line does not close the lock descriptor (the browser keeps the profile lock for its own lifetime)");
assert(/curl -fsS -m 2 /.test(start) && /kill -KILL "\$CHROME_PID"/.test(start) && /timeout -k 5 180 /.test(start), "structure: the Chrome loop's waits carry a bound in the source (CDP probe timeout, provisioning timeout, KILL after TERM) — the behaviour is in test/docker-chrome-loop.sh");
assert(/canon\(\) \{ \(cd "\$1" 2>\/dev\/null && pwd -P\)/.test(helper) && /create_locked\(\) \{\n[^\n]*\n  prepare_dirs\n  guard_up/.test(helper), "structure: bridge-docker compares canonical paths; checks and creation are one function");
assert(/with_up_lock "\$BASH" "\$SELF"[^\n]*__create/.test(helper) && /lockf -k -t/.test(helper) && /flock -w/.test(helper) && !/rm -rf "\$UP_LOCK"/.test(helper) && !/mkdir "\$UP_LOCK"/.test(helper), "structure: `up` runs checks + creation under an OS-held lock (lockf/flock); no lock directory, no stale-lock removal");
assert(/ps -a -q chrome/.test(helper) && /docker port "\$mine"/.test(helper), "structure: the project's own container is looked up in any state, and its ports are asked from Docker");
assert(/ps eww -o command=/.test(helper) && /AI_BRIDGE_HOME=/.test(helper) && !/&& pgrep -f "server\/server\\\.js" > \/dev\/null/.test(helper), "structure: a host relay's state directory is read from that process's environment (a server.js process alone is not a refusal)");
assert(/must be mode 700/.test(helper) && /with mode 600/.test(helper), "bridge-docker refuses a state directory or token that others can read");
assert(/provision\.py/.test(start) && /while kill -0 "\$pid"/.test(start), "structure: provisioning follows every Chrome start, in a retry loop tied to that Chrome's pid");
assert(/flock -n 9/.test(start) && /until flock -n 9/.test(start), "structure: the loop takes the profile lock without blocking, and waits (never starts Chrome) while it is held");
assert(/provision\.py --quit/.test(start) && /provision\.py --quit/.test(stop) && /chrome-stop\.sh/.test(helper) && /cdp\.call\("Browser\.close"\)/.test(provision) && !/pkill/.test(code(helper)) && !/pkill/.test(code(stop)), "structure: Chrome is stopped through DevTools Browser.close first; SIGTERM to the browser pid is the fallback (statuses: test/docker-chrome-loop.sh)");
assert(!/stop_chrome[^\n]*\|\| true/.test(helper) && !/stop_chrome[^\n]*\|\| echo/.test(helper) && /NOT removed/.test(helper) && /NOT replaced/.test(helper), "structure: no stop_chrome result is discarded; a failed stop keeps the container");
assert(/TEMP_TARGETS/.test(provision) && /cleanup NOT verified/.test(provision), "structure: provision.py keeps the ids of its temporary tabs and reports a cleanup it could not verify");

// compose: loopback only, the debug port unpublished, no user override
const ports = [...compose.matchAll(/^\s*-\s*"([^"]+)"\s*(?:#.*)?$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p));
assert(ports.length === 2 && ports.every((p) => p.startsWith("127.0.0.1:")), "compose publishes exactly two ports, both on 127.0.0.1");
assert(!code(compose).includes("9222") && !/EXPOSE[^\n]*9222/.test(dockerfile), "the debug port 9222 is neither published nor exposed");
assert(!/^\s*user:/m.test(compose) && !/network_mode:\s*host/.test(compose) && !/privileged:\s*true/.test(compose), "no user override, no host network, not privileged");
assert(/seccomp=unconfined/.test(compose) && /shm_size: 1g/.test(compose) && /restart: unless-stopped/.test(compose) && /mem_limit:/.test(compose), "seccomp for Chrome's sandbox, 1g shm, restart policy, memory limit");
assert(/PUID=\$\{PUID:-501\}/.test(compose) && /PGID=\$\{PGID:-20\}/.test(compose), "the container user is the Mac user (PUID/PGID)");
assert(/:\/config\s/.test(compose) && /:\/config\/Downloads\s/.test(compose) && /:\/data\s/.test(compose), "three mounts: /config, /config/Downloads, /data");

// relay service and provisioning
assert(/AI_BRIDGE_HOME=\/data/.test(relay) && /BRIDGE_BIND=0\.0\.0\.0/.test(relay) && /BRIDGE_PORT=8765/.test(relay) && /s6-setuidgid abc node \/opt\/ai-bridge\/server\/server\.js/.test(relay), "the relay runs as the image user on /data, bound inside the container on 8765");
assert(provision.split("\n").filter((l) => /\b(print|out)\(/.test(l) && /\btoken\b/.test(l)).every((l) => /redact\(str\(e\), token\)/.test(l)), "provision.py never prints the token (only a redacted error text)");
assert(/suppress_origin=True/.test(provision) && /127\.0\.0\.1:9222/.test(provision), "provision.py talks to the debug port on the container's loopback");

// helper: staging next to a live host relay
assert(/BRIDGE_PUBLISH_PORT:=8766/.test(helper) && /BRIDGE_PUBLISH_PORT:=8765/.test(helper), "bridge-docker: production 8765, staging 8766");
assert(/docker ps -a/.test(helper) && /belongs to another container/.test(helper), "bridge-docker refuses a profile directory another container (running or not) mounts");
assert(/is not under \\\$HOME/.test(helper), "bridge-docker refuses mounts outside $HOME (Colima shares only the home directory)");
assert(/a host relay is running/.test(helper) && /already held by/.test(helper), "bridge-docker refuses the production port/state while a host relay owns them");
assert(!/docker (rm|rmi|system prune|volume rm)\b/.test(code(helper)), "bridge-docker never removes images, volumes or foreign containers");

console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll docker-chrome file tests passed.");
process.exit(failures ? 1 : 0);
