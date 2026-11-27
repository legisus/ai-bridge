#!/usr/bin/env node
// Source-level guards for deploy/docker-chrome (docs/DOCKER-CHROME.md): what the
// files must never say. The running container is covered by
// test/docker-chrome-smoke.sh (needs Docker; not part of `npm test`).
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
assert(/\.chrome-profile\.lock/.test(start) && /dirname "\$PROFILE"/.test(start), "the Chrome loop's lock lives on the profile volume (one Chrome per profile across containers)");
assert(/curl -fsS -m 2 /.test(start) && /kill -KILL "\$CHROME_PID"/.test(start) && /timeout -k 5 180 /.test(start), "every wait in the Chrome loop is bounded (CDP probe, provisioning run, stop escalation)");
assert(/canon\(\) \{ \(cd "\$1" 2>\/dev\/null && pwd -P\)/.test(helper) && /lock_up\n    prepare_dirs\n    guard_up/.test(helper), "bridge-docker compares canonical paths and serializes `up`");
assert(/must be mode 700/.test(helper) && /with mode 600/.test(helper), "bridge-docker refuses a state directory or token that others can read");
assert(/provision\.py/.test(start) && /while kill -0 "\$pid"/.test(start), "provisioning runs after every Chrome start and is retried while that Chrome lives");
assert(/flock -n 9/.test(start), "one Chrome loop per container");
assert(/provision\.py --quit/.test(start) && /provision\.py --quit/.test(helper) && /cdp\.call\("Browser\.close"\)/.test(provision) && !/pkill/.test(code(helper)), "Chrome is stopped through DevTools Browser.close (cookies are written out); SIGTERM to the browser process is only the fallback");

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
