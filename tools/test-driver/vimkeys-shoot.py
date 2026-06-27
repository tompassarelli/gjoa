#!/usr/bin/env python3
"""End-to-end verify of the #130 vim bindings against a live gjoa-dev (new chrome
bundle): navigate a link-rich fixture, inject a REAL 'f' keydown via PerformActions
(exercising the chrome vim dispatch, not the actor directly), assert the hint
overlay appears + screenshot; then inject '/' and assert the native findbar opens.

Connects to an already-launched gjoa marionette (bash wrapper boots it with
GJOA_DEV_LOADER=1 so the freshly-built vim bundle loads).
"""
import argparse, base64, json, socket, sys, time

# WebDriver key code points for special keys.
SPECIAL = {"Escape": chr(0xE00C), "Enter": chr(0xE007), "Backspace": chr(0xE003)}


class M:
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

    def exe(self, script):
        r = self.send("WebDriver:ExecuteScript",
                      {"script": script, "args": [], "scriptTimeout": 30000, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r

    def key(self, ch):
        v = SPECIAL.get(ch, ch)
        self.send("WebDriver:PerformActions", {"actions": [
            {"type": "key", "id": "kb", "actions": [
                {"type": "keyDown", "value": v}, {"type": "keyUp", "value": v}]}]})

    def shot(self):
        r = self.send("WebDriver:TakeScreenshot", {"full": True, "hash": False})
        return r if isinstance(r, str) else r.get("value")

    def quit(self):
        try: self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except SystemExit: pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2828)
    ap.add_argument("--url", default="http://127.0.0.1:8976/hacker-news")
    ap.add_argument("--out", default="/tmp/vimkeys.png")
    a = ap.parse_args()
    m = M(a.port)
    m.newsession()

    m.ctx("chrome")
    for _ in range(40):
        if m.exe("return !!window.gBrowser;"):
            break
        time.sleep(0.25)

    m.ctx("content")
    m.navigate(a.url)
    time.sleep(1.2)
    m.ctx("chrome")
    m.exe("try{gBrowser.selectedBrowser.focus();}catch(e){}; return 'focused';")
    time.sleep(0.3)

    # --- P4: real 'f' keydown -> link hints -------------------------------------
    m.key("f")
    time.sleep(1.0)
    m.ctx("content")
    hints = m.exe("return document.querySelectorAll('[data-gjoa-hints] span').length;")
    png = base64.b64decode(m.shot())
    with open(a.out, "wb") as f:
        f.write(png)
    print(f"P4 'f' binding: {hints} hint labels rendered -> {a.out} ({len(png)} bytes)", file=sys.stderr)
    m.ctx("chrome"); m.key("Escape"); time.sleep(0.4)

    # --- P5: real '/' keydown -> native findbar ---------------------------------
    m.key("/")
    time.sleep(0.9)
    findbar = m.exe(
        "return !!document.querySelector('findbar:not([hidden]), .findbar:not([hidden])');")
    print(f"P5 '/' binding: findbar_open={findbar}", file=sys.stderr)

    p4 = bool(hints and hints > 0)
    ok = p4 and bool(findbar)
    print("RESULT:", "PASS" if ok else f"P4={'ok' if p4 else 'FAIL'} P5={'ok' if findbar else 'FAIL'}",
          file=sys.stderr)
    m.quit()
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
