#!/usr/bin/env python3
"""Verify #130 link hints end-to-end against a live gjoa: navigate a link-rich
fixture, trigger the GjoaInput actor's LinkHints:Show from chrome, screenshot the
CONTENT (labels visible), assert label count, then drive activation by feeding the
first label's chars back through LinkHints:Key and checking the overlay clears.

Connects to an already-launched gjoa marionette (the bash wrapper boots it). Same
dependency-free wire client as chrome-shoot.py.

Usage: linkhints-shoot.py --port 2828 --url http://127.0.0.1:8976/hacker-news --out /tmp/lh.png
"""
import argparse, base64, json, socket, sys, time


class Marionette:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf = b""; self.id = 1
        deadline = time.time() + timeout; last = None
        while time.time() < deadline:
            try:
                self.s = socket.create_connection((host, port), timeout=10)
                self.s.settimeout(120); break
            except OSError as e:
                last = e; time.sleep(0.2)
        else:
            raise SystemExit(f"connect {host}:{port} failed: {last}")
        self._frame()

    def _frame(self):
        while b":" not in self.buf:
            c = self.s.recv(65536)
            if not c: raise SystemExit("socket closed (header)")
            self.buf += c
        i = self.buf.index(b":"); n = int(self.buf[:i]); need = i + 1 + n
        while len(self.buf) < need:
            c = self.s.recv(65536)
            if not c: raise SystemExit("socket closed (body)")
            self.buf += c
        p = self.buf[i + 1:need]; self.buf = self.buf[need:]
        return json.loads(p.decode())

    def send(self, name, params):
        mid = self.id; self.id += 1
        msg = json.dumps([0, mid, name, params]).encode()
        self.s.sendall(f"{len(msg)}:".encode() + msg)
        while True:
            r = self._frame()
            if isinstance(r, list) and r[0] == 1 and r[1] == mid:
                if r[2]: raise SystemExit(f"{name} error: {r[2]}")
                return r[3]

    def newsession(self):
        return self.send("WebDriver:NewSession",
                         {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}})

    def ctx(self, c): self.send("Marionette:SetContext", {"value": c})

    def navigate(self, url): return self.send("WebDriver:Navigate", {"url": url})

    def exe(self, script, args=None):
        r = self.send("WebDriver:ExecuteScript",
                      {"script": script, "args": args or [],
                       "scriptTimeout": 30000, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r

    def shot(self, full=True):
        r = self.send("WebDriver:TakeScreenshot", {"full": full, "hash": False})
        return r if isinstance(r, str) else r.get("value")

    def quit(self):
        try: self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except SystemExit: pass


SHOW_JS = (
    'gBrowser.selectedBrowser.browsingContext.currentWindowGlobal'
    '.getActor("GjoaInput").sendQuery("LinkHints:Show",{newTab:false});'
    'return "sent";'
)
def KEY_JS(k):
    return (
        'gBrowser.selectedBrowser.browsingContext.currentWindowGlobal'
        '.getActor("GjoaInput").sendQuery("LinkHints:Key",{key:' + json.dumps(k) + '});'
        'return "sent";'
    )
LABELS_JS = (
    "return JSON.stringify(Array.from("
    "document.querySelectorAll('[data-gjoa-hints] span')).map(s=>s.textContent));"
)
CONTAINER_JS = "return document.querySelectorAll('[data-gjoa-hints]').length;"
HREF_JS = "return document.location.href;"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2828)
    ap.add_argument("--url", default="http://127.0.0.1:8976/hacker-news")
    ap.add_argument("--out", default="/tmp/lh.png")
    a = ap.parse_args()

    m = Marionette(a.port)
    m.newsession()
    m.ctx("content")
    m.navigate(a.url)
    time.sleep(1.2)

    # trigger link hints from chrome (drives the content actor)
    m.ctx("chrome")
    m.exe(SHOW_JS)
    time.sleep(0.9)

    # screenshot + assert in content
    m.ctx("content")
    png = base64.b64decode(m.shot(True))
    with open(a.out, "wb") as f:
        f.write(png)
    labels = json.loads(m.exe(LABELS_JS))
    print(f"PNG: {a.out} ({len(png)} bytes)", file=sys.stderr)
    print(f"LABELS: {len(labels)} rendered -> {labels[:12]}", file=sys.stderr)
    if not labels:
        print("FAIL: no hint labels rendered", file=sys.stderr)
        m.quit(); sys.exit(1)

    # drive activation: feed the first label's chars, expect the overlay to clear
    first = labels[0].lower()
    before = m.exe(HREF_JS)
    m.ctx("chrome")
    for ch in first:
        m.exe(KEY_JS(ch))
        time.sleep(0.15)
    time.sleep(0.6)
    m.ctx("content")
    remaining = m.exe(CONTAINER_JS)
    after = m.exe(HREF_JS)
    print(f"ACTIVATE: typed '{first}' -> overlay_containers_left={remaining} "
          f"href {before} -> {after} (changed={before != after})", file=sys.stderr)
    ok = (remaining == 0)
    print("RESULT:", "PASS" if ok else "PARTIAL", file=sys.stderr)
    m.quit()
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
