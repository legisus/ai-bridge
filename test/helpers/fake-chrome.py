#!/usr/bin/env python3
"""A stand-in for the browser binary in test/docker-chrome-loop.sh (CHROME_BIN).
It is started by chrome-start.sh with Chrome's own flags and behaves as the
file /tmp/fake-chrome.mode says (read once, at start):

  nocdp          never opens the debug port (just lives)
  cdp            serves /json/version on 127.0.0.1:9222 and a DevTools websocket
                 that honours Browser.close (answers, then exits 0)
  +ignore-term   (suffix) SIGTERM is ignored

It writes what happens to /tmp/fake-chrome.log. No browser, no network beyond
the container's loopback."""
import base64
import hashlib
import json
import os
import signal
import socket
import struct
import sys
import threading
import time

try:
    MODE = open("/tmp/fake-chrome.mode").read().strip()
except OSError:
    MODE = "nocdp"


def log(line):
    with open("/tmp/fake-chrome.log", "a") as f:
        f.write("%d %s\n" % (os.getpid(), line))


if "ignore-term" in MODE:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    signal.signal(signal.SIGTERM, lambda *_: (log("SIGTERM"), os._exit(143)))
log("start %s" % MODE)


def read_exact(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def serve(conn):
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = conn.recv(4096)
        if not chunk:
            return
        request += chunk
    head = request.decode("latin-1")
    headers = dict((k.strip().lower(), v.strip()) for k, v in (l.split(":", 1) for l in head.split("\r\n")[1:] if ":" in l))
    if headers.get("upgrade", "").lower() != "websocket":
        body = json.dumps({"Browser": "FakeChrome/1.0", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/fake"}).encode()
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
        conn.close()
        return
    accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
    while True:
        b1, b2 = read_exact(conn, 2)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", read_exact(conn, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", read_exact(conn, 8))[0]
        mask = read_exact(conn, 4) if b2 & 0x80 else b"\0\0\0\0"
        payload = bytes(c ^ mask[i % 4] for i, c in enumerate(read_exact(conn, length)))
        if b1 & 0x0F == 8:
            return
        if b1 & 0x0F != 1:
            continue
        msg = json.loads(payload)
        closing = msg.get("method") == "Browser.close"
        reply = {"id": msg.get("id"), "result": {}} if closing else {"id": msg.get("id"), "error": {"message": "fake browser: %s is not implemented" % msg.get("method")}}
        out = json.dumps(reply).encode()
        conn.sendall(bytes([0x81, len(out)]) + out if len(out) < 126 else bytes([0x81, 126]) + struct.pack(">H", len(out)) + out)
        if closing:
            log("Browser.close")
            time.sleep(0.3)
            os._exit(0)


if MODE.startswith("cdp"):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 9222))
    srv.listen(8)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=lambda c=c: serve(c), daemon=True).start()
else:
    while True:
        time.sleep(3600)
