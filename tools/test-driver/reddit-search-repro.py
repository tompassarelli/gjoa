#!/usr/bin/env python3
"""Faithful repro of the user's exact flow: load reddit, CLICK the search bar to
EXPAND it (the dropdown), then type 't'. Screenshots before/after. Reports whether
the tab picker misfired + what element is focused + _gjoaEditable at each step.
"""
import argparse, base64, json, socket, sys, time

SPECIAL = {"Escape": chr(0xE00C)}


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
            raise SystemExit(f"connect failed: {last}")
        self._frame()

    def _frame(self):
        while b":" not in self.buf:
            c = self.s.recv(65536)
            if not c: raise SystemExit("closed")
            self.buf += c
        i = self.buf.index(b":"); n = int(self.buf[:i]); need = i + 1 + n
        while len(self.buf) < need:
            c = self.s.recv(65536)
            if not c: raise SystemExit("closed")
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

    def newsession(self): return self.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}})
    def ctx(self, c): self.send("Marionette:SetContext", {"value": c})
    def navigate(self, url):
        try: return self.send("WebDriver:Navigate", {"url": url})
        except SystemExit as e: return f"NAVFAIL {e}"
    def exe(self, s, t=30000):
        r = self.send("WebDriver:ExecuteScript", {"script": s, "args": [], "scriptTimeout": t, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r

    def click_xy(self, x, y):
        self.send("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "m", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "duration": 0, "x": int(x), "y": int(y)},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})

    def keys(self, s):
        acts = []
        for ch in s:
            v = SPECIAL.get(ch, ch); acts += [{"type": "keyDown", "value": v}, {"type": "keyUp", "value": v}]
        self.send("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})

    def shot(self, path):
        self.ctx("chrome")
        r = self.send("WebDriver:TakeScreenshot", {"full": False})
        data = r.get("value") if isinstance(r, dict) else r
        open(path, "wb").write(base64.b64decode(data))
        print(f"  screenshot -> {path}", file=sys.stderr)

    def quit(self):
        try: self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except SystemExit: pass


PICKER = "const p=document.getElementById('gjoa-picker'); return !!(p && !p.hidden);"
ACTIVE = (r"""
  function deep(a){ while(a && a.shadowRoot && a.shadowRoot.activeElement) a=a.shadowRoot.activeElement; return a; }
  const a = deep(document.activeElement);
  return JSON.stringify({tag:a&&a.tagName, type:a&&a.type, role:a&&a.getAttribute&&a.getAttribute('role'),
    ce:a&&a.isContentEditable, ph:a&&a.placeholder});
""")
FIND_BAR = (r"""
  const cands=[...document.querySelectorAll('reddit-search-large, [aria-label*="earch" i], input[type="search"], [name="q"]')];
  const el=cands.find(e=>e.getBoundingClientRect().width>50) || cands[0];
  if(!el) return null;
  el.scrollIntoView({block:'center'});
  const r=el.getBoundingClientRect();
  return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2, tag:el.tagName});
""")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=2828)
    a = ap.parse_args()
    m = M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)

    m.ctx("content")
    nav = m.navigate("https://www.reddit.com/")
    if isinstance(nav, str) and nav.startswith("NAVFAIL"):
        print(f"network down: {nav}", file=sys.stderr); m.quit(); sys.exit(1)
    time.sleep(6.0)
    print(f"  title={m.exe('return document.title;')!r}", file=sys.stderr)

    bar = m.exe(FIND_BAR)
    print(f"  search bar: {bar}", file=sys.stderr)
    if not bar: print("  no search bar found", file=sys.stderr); m.quit(); sys.exit(2)
    b = json.loads(bar)

    # CLICK to expand (the user's action), then let Reddit's JS move focus
    m.click_xy(b["x"], b["y"]); time.sleep(1.5)
    print(f"  after click, focused={m.exe(ACTIVE)}", file=sys.stderr)
    m.shot("/tmp/reddit-1-expanded.png")
    m.ctx("chrome"); pre = m.exe(PICKER); edit_pre = m.exe("return gBrowser.selectedBrowser._gjoaEditable===true;")
    print(f"  pre-type: pickerOpen={pre}  _gjoaEditable={edit_pre}", file=sys.stderr)

    # type 't' — the misfire trigger
    m.keys("t"); time.sleep(0.6)
    m.ctx("chrome"); post = m.exe(PICKER)
    m.ctx("content"); focus_post = m.exe(ACTIVE)
    m.shot("/tmp/reddit-2-after-t.png")
    print(f"  AFTER 't': pickerOpened={post} (expect False)  focused={focus_post}", file=sys.stderr)

    # also try typing IMMEDIATELY after a fresh click (focus-transition window)
    print("  --- immediate-type variant ---", file=sys.stderr)
    m.ctx("content"); m.exe("document.activeElement&&document.activeElement.blur&&document.activeElement.blur();")
    time.sleep(0.3); m.click_xy(b["x"], b["y"]); m.keys("t"); time.sleep(0.5)
    m.ctx("chrome"); imm = m.exe(PICKER)
    print(f"  immediate click+'t': pickerOpened={imm} (expect False)", file=sys.stderr)

    misfire = bool(post) or bool(imm)
    print(f"\nRESULT: {'MISFIRE REPRODUCED' if misfire else 'no misfire — current code yields correctly on real Reddit'}",
          file=sys.stderr)
    m.quit(); sys.exit(2 if misfire else 0)


if __name__ == "__main__":
    main()
