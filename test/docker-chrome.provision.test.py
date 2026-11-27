#!/usr/bin/env python3
"""provision.py against a fake DevTools endpoint: the decisions (what to click,
what to write, when to load) without a browser. `npm run test:docker-chrome`."""
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True   # importing provision.py must not leave a __pycache__ in deploy/
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("provision", os.path.join(HERE, "..", "deploy", "docker-chrome", "provision.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

failures = 0


def check(cond, name):
    global failures
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        failures += 1


TOKEN = "t0ken-" + "a" * 42
EXT = "hgckekkegbobpiikhgdoeakochamknkg"


class FakeChrome:
    """Just enough of Chrome for provision(): developer mode, one unpacked
    extension with two toggles and a chrome.storage.local, page targets."""

    def __init__(self, dev=False, loaded=False, enabled=True, toggles=None, storage=None, sticky=True, options_ok=True, worker=True):
        self.dev, self.loaded, self.enabled = dev, loaded, enabled
        self.toggles = dict(toggles or {"allow-incognito": False, "allow-user-scripts": False})
        self.storage = dict(storage or {})
        self.sticky, self.options_ok, self.worker = sticky, options_ok, worker
        self.calls, self.open, self.clicks, self.sets, self.loads = [], {}, [], [], 0
        self.n = 0

    def call(self, method, session=None, **params):
        self.calls.append(method)
        if method == "Extensions.loadUnpacked":
            self.loads += 1; self.loaded = True; self.enabled = self.dev
            return {"id": EXT}
        if method == "Target.createTarget":
            self.n += 1; tid = "T%d" % self.n; self.open[tid] = params["url"]; return {"targetId": tid}
        if method == "Target.attachToTarget":
            return {"sessionId": "S-" + params["targetId"]}
        if method == "Target.closeTarget":
            self.open.pop(params["targetId"], None); return {}
        if method == "Target.detachFromTarget":
            return {}
        if method == "Target.getTargets":
            sw = [{"type": "service_worker", "url": "chrome-extension://%s/background.js" % EXT, "targetId": "SW"}] if (self.worker and self.loaded and self.enabled) else []
            return {"targetInfos": sw}
        if method == "Runtime.evaluate":
            url = "worker" if session == "S-SW" else self.open[session[2:]]
            return {"result": {"value": self.js(url, params["expression"])}}
        raise AssertionError("unexpected CDP call " + method)

    def js(self, url, expr):
        if "getProfileConfiguration" in expr:
            if "updateProfileConfiguration" in expr:
                self.dev = True
                if self.loaded: self.enabled = True
            return self.dev
        if "getExtensionsInfo" in expr:
            return [{"id": EXT, "enabled": self.enabled}] if self.loaded else []
        if "cr.click()" in expr:
            tid = next(t for t in self.toggles if json.dumps(t) in expr)
            self.clicks.append(tid)
            if self.sticky: self.toggles[tid] = True
            return True
        if "extensions-detail-view" in expr:
            return {t: {"present": True, "checked": v} for t, v in self.toggles.items()} if self.loaded else None
        if "location.protocol" in expr:
            return self.options_ok and url.startswith("chrome-extension://")
        if "chrome.storage.local.set" in expr:
            patch = json.loads(expr[expr.index("(") + 1:expr.index(").then")]); self.sets.append(patch); self.storage.update(patch); return True
        if "chrome.storage.local.get" in expr:
            return dict(self.storage)
        raise AssertionError("unexpected page script: " + expr[:60])


def run(chrome, pong=None):
    lines = []
    pong = pong if pong is not None else {"pong": True, "session": "docker-chrome", "access": "granted", "extGen": 1}
    P.provision(chrome, TOKEN, ping=lambda: pong, sleep=lambda s: None, out=lines.append)
    return lines


# ---- pure decisions ----
d = P.desired_storage(TOKEN)
check(d == {"token": TOKEN, "port": 8765, "manualMode": True, "provisionedBy": "manual", "session": "docker-chrome"}, "desired storage: token, port 8765, manual mode, session docker-chrome (no allowlist key)")
check(P.storage_patch(dict(d), d) == {}, "storage patch: identical values -> nothing to write")
check(P.storage_patch({**d, "token": "old", "allowlist": ["x"]}, d) == {"token": TOKEN}, "storage patch: only the differing key")
check(P.storage_patch(None, d) == d, "storage patch: empty storage -> everything")
check(P.toggles_to_click({"allow-incognito": {"present": True, "checked": False}, "allow-user-scripts": {"present": True, "checked": False}}) == ["allow-incognito", "allow-user-scripts"], "toggles: incognito first (it reloads the extension), then user scripts")
check(P.toggles_to_click({"allow-incognito": {"present": True, "checked": True}, "allow-user-scripts": {"present": True, "checked": True}}) == [], "toggles: nothing to click when both are on")
try:
    P.toggles_to_click({"allow-incognito": {"present": True, "checked": True}}); check(False, "toggles: a missing row is an error")
except P.ProvisionError as e:
    check("allow-user-scripts" in str(e), "toggles: a missing row is an error")
check(P.ping_ready({"pong": True, "session": "docker-chrome", "access": "granted"}) and not P.ping_ready({"pong": True, "session": "chrome", "access": "granted"}) and not P.ping_ready({"pong": True, "session": "docker-chrome", "access": "revoked"}) and not P.ping_ready(None), "ready = session docker-chrome AND access granted")
check(TOKEN not in P.redact("bad " + TOKEN, TOKEN), "error text never carries the token")

# ---- a fresh Chrome start ----
c = FakeChrome()
out = run(c)
check(c.dev is True and c.loads == 1 and c.enabled, "fresh start: Developer mode turned on, extension loaded once")
check(c.calls.index("Extensions.loadUnpacked") > c.calls.index("Runtime.evaluate"), "Developer mode is switched on BEFORE the extension is loaded")
check(c.clicks == ["allow-incognito", "allow-user-scripts"], "fresh start: both toggles clicked once, in order")
check(c.storage == d and len(c.sets) == 1, "fresh start: storage written in one set")
check(c.open == {}, "every throwaway tab is closed")
check(not any(TOKEN in line for line in out), "the token is not printed")

# ---- run again by hand on a healthy browser: nothing is touched ----
before = (c.loads, list(c.clicks), len(c.sets))
out = run(c)
check((c.loads, c.clicks, len(c.sets)) == before, "second run: no reload of the extension, no click, no storage write")
check(any("not reloaded" in line for line in out) and any("already on" in line for line in out) and any("unchanged" in line for line in out), "second run reports what it left alone")

# ---- after a Chrome restart: the extension is gone, id and storage are back, toggles are off ----
c2 = FakeChrome(dev=True, loaded=False, storage=dict(d))
run(c2)
check(c2.loads == 1 and c2.clicks == ["allow-incognito", "allow-user-scripts"] and c2.sets == [], "after a Chrome restart: load + both toggles, storage untouched (no reconnect storm)")

# ---- loaded but disabled (Developer mode was off): turning it on is enough, else load ----
c3 = FakeChrome(dev=False, loaded=True, enabled=False, storage=dict(d), toggles={"allow-incognito": True, "allow-user-scripts": True})
run(c3)
check(c3.dev and c3.loads == 0, "a disabled extension that Developer mode re-enables is not reloaded")

# ---- failures ----
c4 = FakeChrome(sticky=False)
try:
    run(c4); check(False, "a toggle that does not stay on fails the run")
except P.ProvisionError as e:
    check("did not stay on" in str(e) and c4.open == {}, "a toggle that does not stay on fails the run (tabs still closed)")
c5 = FakeChrome(options_ok=False, worker=True)
run(c5)
check(c5.storage == d, "options page unusable: storage is written through the service worker")
c6 = FakeChrome(options_ok=False, worker=False)
try:
    run(c6); check(False, "no extension context at all fails the run")
except P.ProvisionError as e:
    check("no extension context" in str(e) and c6.open == {}, "no extension context at all fails the run")
c7 = FakeChrome()
clock = [0.0]
real_time = P.time.time
P.time.time = lambda: clock[0]
try:
    P.provision(c7, TOKEN, ping=lambda: {"pong": True, "session": "docker-chrome", "access": "revoked"}, sleep=lambda s: clock.__setitem__(0, clock[0] + max(s, 1)), out=lambda *_: None)
    check(False, "access not granted within 60 s fails the run")
except P.ProvisionError as e:
    check("access granted after 60 s" in str(e) and "revoked" in str(e), "access not granted within 60 s fails the run, with the last answer")
finally:
    P.time.time = real_time

# ---- a throwaway tab never stays behind, whatever fails ----
class AttachFails(FakeChrome):
    def call(self, method, session=None, **params):
        if method == "Target.attachToTarget" and self.open.get(params["targetId"], "").startswith("chrome://extensions/?id="):
            self.calls.append(method); raise P.ProvisionError("Target.attachToTarget: No target with given id")
        return super().call(method, session=session, **params)

c8 = AttachFails()
try:
    run(c8); check(False, "attach failing right after createTarget fails the run")
except P.ProvisionError:
    check(c8.open == {}, "attach failing right after createTarget: the created tab is closed")


class SocketDies(FakeChrome):
    def js(self, url, expr):
        if "location.protocol" in expr:
            raise ConnectionError("websocket closed")     # not a ProvisionError: the transport itself
        return super().js(url, expr)

c9 = SocketDies()
try:
    run(c9); check(False, "a transport error while waiting for the options page fails the run")
except ConnectionError:
    check(c9.open == {}, "a transport error while waiting for the options page: the tab is closed before the error goes up")

print("\n%d TEST(S) FAILED" % failures if failures else "\nAll provision tests passed.")
sys.exit(1 if failures else 0)
