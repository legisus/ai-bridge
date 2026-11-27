#!/lsiopy/bin/python3
"""Provision the AI Browser Bridge extension in the container's Chrome.

Runs after EVERY Chrome start (chrome-start.sh) and by hand
(`bridge-docker provision`). `provision.py --quit` instead closes Chrome
cleanly (see quit_browser). Provisioning is idempotent:

  0. chrome://extensions                -> Developer mode on (a profile setting;
                                           without it Chrome disables unpacked
                                           extensions)
  1. Extensions.loadUnpacked            -> extension id (stable: manifest key);
                                           skipped when it is already loaded and
                                           enabled (loading again = a reload)
  2. chrome://extensions/?id=<id>       -> "Allow in incognito" and "Allow User
                                           Scripts" on (inner cr-toggle, clicked
                                           only when off)
  3. chrome.storage.local               -> token (from /data/token), port, session
                                           name; written only when different
  4. relay `ping`                       -> wait for session docker-chrome, access
                                           granted (auto-grant does the grant)

Why every start: an extension loaded over the DevTools protocol is not recorded
in the profile. After a Chrome restart it is gone; loading it again gives the
same id and the same chrome.storage, but the two toggles are off again.

The token is never printed. Exit status: 0 provisioned, 1 otherwise.
"""
import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.request

DEBUG_URL = os.environ.get("CHROME_DEBUG_URL", "http://127.0.0.1:9222")
EXTENSION_DIR = os.environ.get("BRIDGE_EXTENSION_DIR", "/opt/ai-bridge/extension")
TOKEN_FILE = os.environ.get("BRIDGE_TOKEN_FILE", "/data/token")
CLI = os.environ.get("BRIDGE_CLI", "/opt/ai-bridge/server/cli.js")
SESSION = "docker-chrome"
RELAY_PORT = 8765  # the relay's port INSIDE the container (the published port is the Mac's business)
TOGGLES = ("allow-incognito", "allow-user-scripts")  # incognito first: flipping it reloads the extension


class ProvisionError(RuntimeError):
    pass


# ---------- pure decisions (unit-tested: test/docker-chrome.provision.test.py) ----------

def desired_storage(token):
    """What the extension's chrome.storage.local must hold. `allowlist` is left
    alone (empty = every host, as on the Mac)."""
    return {"token": token, "port": RELAY_PORT, "manualMode": True, "provisionedBy": "manual", "session": SESSION}


def storage_patch(current, desired):
    """Only the keys that differ: an unchanged token/port must not be written,
    or the worker would revoke and reconnect for nothing."""
    current = current or {}
    return {k: v for k, v in desired.items() if current.get(k) != v}


def toggles_to_click(state):
    """Toggle ids to click, in order. `state` is {id: {"present": bool, "checked": bool}}."""
    missing = [t for t in TOGGLES if not (state.get(t) or {}).get("present")]
    if missing:
        raise ProvisionError("toggle not found on the extension's details page: %s" % ", ".join(missing))
    return [t for t in TOGGLES if not state[t]["checked"]]


def ping_ready(pong):
    return bool(pong) and pong.get("pong") is True and pong.get("session") == SESSION and pong.get("access") == "granted"


def redact(text, token):
    return text.replace(token, "<token>") if token else text


# ---------- DevTools transport ----------

class Cdp:
    """One browser-level DevTools connection; page targets are driven through
    flattened sessions."""

    def __init__(self, debug_url=DEBUG_URL):
        import websocket  # websocket-client, installed into the image's Python
        ver = json.load(urllib.request.urlopen(debug_url + "/json/version", timeout=10))
        self.browser = ver.get("Browser", "")
        self.ws = websocket.create_connection(ver["webSocketDebuggerUrl"], suppress_origin=True, timeout=30)
        self.n = 0

    def call(self, method, session=None, **params):
        self.n += 1
        msg = {"id": self.n, "method": method, "params": params}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                if "error" in m:
                    raise ProvisionError("%s: %s" % (method, m["error"].get("message", m["error"])))
                return m.get("result", {})

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def evaluate(cdp, session, expression):
    r = cdp.call("Runtime.evaluate", session=session, expression=expression, awaitPromise=True, returnByValue=True)
    if r.get("exceptionDetails"):
        d = r["exceptionDetails"]
        raise ProvisionError("page script failed: %s" % ((d.get("exception") or {}).get("description") or d.get("text")))
    return (r.get("result") or {}).get("value")


class Page:
    """A throwaway tab on `url`, closed on exit."""

    def __init__(self, cdp, url):
        self.cdp, self.url = cdp, url

    def __enter__(self):
        self.target = self.cdp.call("Target.createTarget", url=self.url, background=True)["targetId"]
        try:
            self.session = self.cdp.call("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        except BaseException:
            self.__exit__(None, None, None)   # created but not attached: `with` would never call __exit__
            raise
        return self

    def eval(self, expression):
        return evaluate(self.cdp, self.session, expression)

    def __exit__(self, *exc):
        try:
            self.cdp.call("Target.closeTarget", targetId=self.target)
        except Exception:
            pass
        return False


# ---------- steps ----------

def load_extension(cdp, path=EXTENSION_DIR):
    ext_id = cdp.call("Extensions.loadUnpacked", path=path).get("id")
    if not ext_id:
        raise ProvisionError("Extensions.loadUnpacked returned no id (is --enable-unsafe-extension-debugging set?)")
    return ext_id


TOGGLE_STATE_JS = """(() => {
  const mgr = document.querySelector('extensions-manager');
  const view = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-detail-view');
  if (!view || !view.shadowRoot) return null;
  const out = {};
  for (const id of %s) {
    const row = view.shadowRoot.querySelector('#' + id);
    const cr = row && row.shadowRoot && row.shadowRoot.querySelector('cr-toggle');
    out[id] = { present: !!cr, checked: !!(cr && cr.checked) };
  }
  return out;
})()""" % json.dumps(list(TOGGLES))

TOGGLE_CLICK_JS = """(() => {
  const view = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-detail-view');
  const cr = view.shadowRoot.querySelector('#' + %s).shadowRoot.querySelector('cr-toggle');
  if (!cr.checked) cr.click();   // the row itself does not flip; the inner cr-toggle does
  return true;
})()"""


DEV_MODE_JS = "chrome.developerPrivate.getProfileConfiguration().then((c) => !!c.inDeveloperMode)"
DEV_MODE_ON_JS = ("chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })"
                  ".then(() => chrome.developerPrivate.getProfileConfiguration()).then((c) => !!c.inDeveloperMode)")


def ensure_developer_mode(page, wait=15, sleep=time.sleep):
    """Developer mode is a profile setting (it persists). With it off Chrome
    disables every unpacked extension ("unsupported developer extension"), a
    CDP-loaded one included, the first time the extension is reloaded. Runs on
    chrome://extensions, the page whose own toggle makes the same call.
    Returns True when it had to be turned on."""
    deadline = time.time() + wait
    while True:
        try:
            if page.eval(DEV_MODE_JS):
                return False
            if page.eval(DEV_MODE_ON_JS):
                return True
            raise ProvisionError("Developer mode did not turn on (blocked by policy?)")
        except ProvisionError:
            if time.time() >= deadline:
                raise
        sleep(0.5)  # chrome://extensions is still loading


LOADED_JS = """chrome.developerPrivate.getExtensionsInfo().then((all) => {
  const dir = %s;
  const norm = (p) => String(p || '').replace(/\\/+$/, '');
  const mine = all.filter((e) => e.location === 'UNPACKED' && (norm(e.path) === dir || norm(e.prettifiedPath) === dir));
  return mine.map((e) => ({ id: e.id, enabled: e.state === 'ENABLED' }));
})"""


def loaded_extension(page, path=None):
    """The id of the bridge extension when this Chrome already has it loaded and
    enabled, else None. Loading it again would RELOAD it: the worker restarts
    and its session state (which tabs it owns) is lost, so a re-run by hand
    must not do that to a healthy extension."""
    path = (path or EXTENSION_DIR).rstrip("/")
    for e in page.eval(LOADED_JS % json.dumps(path)) or []:
        if e.get("enabled"):
            return e.get("id")
    return None


def read_toggles(page, wait=20, sleep=time.sleep):
    """The details page renders asynchronously; poll until both rows exist."""
    deadline = time.time() + wait
    state = None
    while True:
        try:
            state = page.eval(TOGGLE_STATE_JS)
        except ProvisionError:
            state = None  # the page is reloading (the extension was just reloaded)
        if state and all((state.get(t) or {}).get("present") for t in TOGGLES):
            return state
        if time.time() >= deadline:
            return state or {}
        sleep(0.5)


def ensure_toggles(page, sleep=time.sleep):
    """Returns the list of toggles that were clicked."""
    clicked = []
    for _ in range(len(TOGGLES) + 1):
        todo = toggles_to_click(read_toggles(page, sleep=sleep))
        if not todo:
            return clicked
        page.eval(TOGGLE_CLICK_JS % json.dumps(todo[0]))
        clicked.append(todo[0])
        sleep(1.5)  # the click is applied asynchronously; "Allow in incognito" reloads the extension
    raise ProvisionError("toggles did not stay on: %s" % ", ".join(toggles_to_click(read_toggles(page, sleep=sleep))))


def ensure_storage(page, desired):
    """Runs in an extension page (options.html). Returns the names of the keys written."""
    keys = sorted(desired)
    current = page.eval("chrome.storage.local.get(%s)" % json.dumps(keys))
    patch = storage_patch(current, desired)
    if patch:
        page.eval("chrome.storage.local.set(%s).then(() => true)" % json.dumps(patch))
        after = page.eval("chrome.storage.local.get(%s)" % json.dumps(keys))
        if storage_patch(after, desired):
            raise ProvisionError("chrome.storage.local did not take the values")
    return sorted(patch)


def read_token(path=TOKEN_FILE, wait=60, sleep=time.sleep):
    """The relay creates the token on its first start; wait for it."""
    deadline = time.time() + wait
    while True:
        try:
            with open(path) as f:
                token = f.read().strip()
            if token:
                return token
        except OSError:
            pass
        if time.time() >= deadline:
            raise ProvisionError("no relay token at %s (is the relay service running?)" % path)
        sleep(1)


def relay_ping():
    try:
        r = subprocess.run(["node", CLI, "ping", "--timeout", "5000"], capture_output=True, text=True, timeout=20,
                           env=dict(os.environ, AI_BRIDGE_HOME=os.path.dirname(TOKEN_FILE), BRIDGE_PORT=str(RELAY_PORT)))
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
    except Exception:
        return None


def wait_granted(ping=relay_ping, wait=60, sleep=time.sleep):
    deadline = time.time() + wait
    while True:
        pong = ping()
        if ping_ready(pong):
            return pong
        if time.time() >= deadline:
            raise ProvisionError("the relay does not report session %s / access granted after %d s (last answer: %s)"
                                 % (SESSION, wait, {k: pong.get(k) for k in ("session", "access")} if pong else "none"))
        sleep(2)


HAS_STORAGE_JS = "location.protocol === 'chrome-extension:' && typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local)"


class Worker:
    """The extension's service worker as a DevTools session (what the spike used)."""

    def __init__(self, cdp, ext_id):
        infos = cdp.call("Target.getTargets").get("targetInfos", [])
        sw = [t for t in infos if t.get("type") == "service_worker" and ext_id in t.get("url", "")]
        if not sw:
            raise ProvisionError("the extension's service worker is not running")
        self.cdp = cdp
        self.session = cdp.call("Target.attachToTarget", targetId=sw[0]["targetId"], flatten=True)["sessionId"]

    def eval(self, expression):
        return evaluate(self.cdp, self.session, expression)

    def __exit__(self, *exc):
        try:
            self.cdp.call("Target.detachFromTarget", sessionId=self.session)
        except Exception:
            pass
        return False


def open_extension_context(cdp, ext_id, wait=15, sleep=time.sleep):
    """Something that can run chrome.storage calls as the extension: its
    options page in a throwaway tab (exists as soon as it has loaded, also when
    the worker sleeps), else the service worker target."""
    page = Page(cdp, "chrome-extension://%s/options.html" % ext_id)
    page.__enter__()
    deadline = time.time() + wait
    last = "chrome.storage missing"
    try:
        while True:
            try:
                if page.eval(HAS_STORAGE_JS):   # false while the tab is still on its initial empty document
                    return page
            except ProvisionError as e:
                last = str(e)
            if time.time() >= deadline:
                break
            sleep(0.5)
    except BaseException:                   # a transport error, an interrupt: the tab must not stay behind
        page.__exit__(None, None, None)
        raise
    page.__exit__(None, None, None)
    try:
        return Worker(cdp, ext_id)
    except ProvisionError as e:
        raise ProvisionError("no extension context for chrome.storage (options page: %s; %s)" % (last, e))


def provision(cdp, token, ping=relay_ping, sleep=time.sleep, out=print):
    with Page(cdp, "chrome://extensions/") as manager:
        turned_on = ensure_developer_mode(manager, sleep=sleep)
        ext_id = loaded_extension(manager)
    out("developer mode: %s" % ("turned on" if turned_on else "already on"))
    if ext_id:
        out("extension already loaded: %s (not reloaded)" % ext_id)
    else:
        ext_id = load_extension(cdp)
        out("extension loaded: %s" % ext_id)
    with Page(cdp, "chrome://extensions/?id=%s" % ext_id) as details:
        clicked = ensure_toggles(details, sleep=sleep)
    out("toggles: %s" % ("turned on " + ", ".join(clicked) if clicked else "already on"))
    page = open_extension_context(cdp, ext_id, sleep=sleep)
    try:
        written = ensure_storage(page, desired_storage(token))
    finally:
        page.__exit__(None, None, None)
    out("storage: %s" % ("wrote " + ", ".join(written) if written else "unchanged"))
    pong = wait_granted(ping=ping, sleep=sleep)
    out("relay: session %s, access %s, extGen %s" % (pong.get("session"), pong.get("access"), pong.get("extGen")))
    return ext_id


def quit_browser():
    """Ask Chrome to close the way its own Quit does (DevTools Browser.close).
    This is the only stop that writes the cookie store out: Chrome commits
    cookies on a ~30 s timer, and a SIGTERM — even to the browser process alone
    — exits without the final commit (measured: a cookie set seconds before a
    SIGTERM was gone after the restart; after Browser.close it was there)."""
    cdp = None
    try:
        cdp = Cdp()
        cdp.call("Browser.close")
        return 0
    except Exception as e:
        print("quit failed: %s" % e, file=sys.stderr)
        return 1
    finally:
        if cdp:
            cdp.close()


def main():
    if sys.argv[1:] == ["--quit"]:
        return quit_browser()
    token = ""
    cdp = None
    # One provisioning at a time: the start loop and a run by hand must not
    # click the same toggles concurrently.
    lock = open(os.environ.get("BRIDGE_PROVISION_LOCK", "/tmp/ai-bridge-provision.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        token = read_token()
        cdp = Cdp()
        print("browser: %s" % cdp.browser)
        provision(cdp, token)
        return 0
    except Exception as e:  # one line, no token, non-zero: chrome-start.sh retries
        print("provision failed: %s" % redact(str(e), token), file=sys.stderr)
        return 1
    finally:
        if cdp:
            cdp.close()
        lock.close()


if __name__ == "__main__":
    sys.exit(main())
