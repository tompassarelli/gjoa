#!/usr/bin/env python3
"""Reproduce the real-world vim misfire: type into a freshly-focused field and the
tab-search picker opens. Two probes:

  A) RACE THRESHOLD — focus an input, wait `delay` ms, type 't'. If the picker
     opens at small delays but not large ones, the bug is the async _gjoaEditable
     cache lagging the keystroke (chrome reads a flag the content actor sets over
     IPC). Prints the delay at which it stops misfiring.

  B) REAL REDDIT (if network) — load reddit.com, deep-find the search field
     (piercing shadow roots), focus it, type 't' immediately. Reports whether the
     picker opened + what gjoa's detector says about the focused element.
"""
import argparse, json, socket, sys, time

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
            raise SystemExit(f"connect {host}:{port} failed: {last}")
        self._frame()

    def _frame(self):
        while b":" not in self.buf:
            c = self.s.recv(65536)
            if not c: raise SystemExit("socket closed")
            self.buf += c
        i = self.buf.index(b":"); n = int(self.buf[:i]); need = i + 1 + n
        while len(self.buf) < need:
            c = self.s.recv(65536)
            if not c: raise SystemExit("socket closed")
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
        return self.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}, "firstMatch": [{}]}})

    def ctx(self, c): self.send("Marionette:SetContext", {"value": c})

    def navigate(self, url):
        try: return self.send("WebDriver:Navigate", {"url": url})
        except SystemExit as e: return f"NAVFAIL {e}"

    def exe(self, script, timeout=30000):
        r = self.send("WebDriver:ExecuteScript",
                      {"script": script, "args": [], "scriptTimeout": timeout, "newSandbox": False})
        return r.get("value") if isinstance(r, dict) else r

    def keys(self, s):
        acts = []
        for ch in s:
            v = SPECIAL.get(ch, ch)
            acts += [{"type": "keyDown", "value": v}, {"type": "keyUp", "value": v}]
        self.send("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})

    def quit(self):
        try: self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except SystemExit: pass


PICKER = "const p=document.getElementById('gjoa-picker'); return !!(p && !p.hidden);"
CLOSE_PICKER = ("const p=document.getElementById('gjoa-picker'); if(p){p.hidden=true;} "
                "return 1;")
FORM = ("data:text/html,<body style='height:1500px'>"
        "<input id=i style='position:fixed;top:0;left:0'></body>")

# deep-find a searchish editable, piercing open+closed shadow is not possible from
# content JS (closed), but open shadow + light DOM covers Reddit's faceplate input.
DEEP_FIND = r"""
  function* walk(root){
    const els = root.querySelectorAll('*');
    for(const el of els){ yield el; if(el.shadowRoot) yield* walk(el.shadowRoot); }
  }
  const want = el => {
    const t=(el.tagName||'').toLowerCase();
    const r=(el.getAttribute&&el.getAttribute('role')||'').toLowerCase();
    if(t==='input'){const ty=(el.type||'text').toLowerCase();
      return !['button','checkbox','color','file','hidden','image','radio','reset','submit'].includes(ty);}
    return t==='textarea'||el.isContentEditable||['textbox','searchbox','combobox'].includes(r);
  };
  for(const el of walk(document)){ if(want(el) && el.offsetParent!==null){
    el.focus();
    const a=document.activeElement;
    return JSON.stringify({found:true, tag:(a&&a.tagName), type:(a&&a.type), role:(a&&a.getAttribute&&a.getAttribute('role')), ce:(a&&a.isContentEditable)});
  }}
  return JSON.stringify({found:false});
"""


def wait_ready(m):
    m.ctx("chrome")
    for _ in range(120):  # up to 30s — headless GFX restore can be slow
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"):
            return True
        time.sleep(0.25)
    diag = m.exe("return JSON.stringify({gBrowser:typeof window.gBrowser, "
                 "gjoaTest:(window.gjoaTest?Object.keys(window.gjoaTest):null), "
                 "panel:!!document.getElementById('gjoa-tab-panel'), "
                 "uri:(gBrowser&&gBrowser.currentURI&&gBrowser.currentURI.spec)});")
    print(f"  not-ready diag: {diag}", file=sys.stderr)
    return False


def probe_race(m):
    print("\n=== A) RACE THRESHOLD (focus → wait Nms → type 't') ===", file=sys.stderr)
    results = []
    for delay in [0, 30, 80, 150, 300, 600, 1200]:
        m.ctx("chrome"); m.exe(CLOSE_PICKER)
        m.ctx("content"); m.navigate(FORM); time.sleep(0.8)
        m.exe("document.getElementById('i').focus(); return document.activeElement.id;")
        if delay: time.sleep(delay / 1000.0)
        m.keys("t"); time.sleep(0.4)
        val = m.exe("return (document.getElementById('i')||{}).value || '';")
        m.ctx("chrome"); picker = m.exe(PICKER)
        misfire = bool(picker) or (val != "t")
        results.append((delay, misfire, picker, val))
        print(f"  delay={delay:>4}ms  misfire={misfire!s:>5}  pickerOpened={picker!s:>5}  input.value={val!r}",
              file=sys.stderr)
    bad = [d for (d, mf, _p, _v) in results if mf]
    print(f"  -> misfired at delays(ms): {bad if bad else 'NONE'}", file=sys.stderr)
    return results


def probe_reddit(m):
    print("\n=== B) REAL REDDIT (network) ===", file=sys.stderr)
    m.ctx("chrome"); m.exe(CLOSE_PICKER)
    m.ctx("content")
    nav = m.navigate("https://www.reddit.com/")
    if isinstance(nav, str) and nav.startswith("NAVFAIL"):
        print(f"  network unavailable ({nav}) — skipped", file=sys.stderr); return None
    time.sleep(6.0)
    title = m.exe("return document.title || '';")
    print(f"  loaded title={title!r}", file=sys.stderr)
    info = m.exe(DEEP_FIND)
    print(f"  search-field focus: {info}", file=sys.stderr)
    try: parsed = json.loads(info)
    except Exception: parsed = {"found": False}
    if not parsed.get("found"):
        print("  could not locate a search field — manual inspection needed", file=sys.stderr); return parsed
    time.sleep(0.05)  # type almost immediately, like a human who just clicked
    m.keys("t"); time.sleep(0.5)
    m.ctx("chrome"); picker = m.exe(PICKER)
    edit = m.exe("return (gBrowser.selectedBrowser._gjoaEditable===true);")
    print(f"  after 't': pickerOpened={picker} (expect False)  _gjoaEditable={edit} (expect True)",
          file=sys.stderr)
    parsed["misfire"] = bool(picker); parsed["gjoaEditable"] = edit
    return parsed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2828)
    ap.add_argument("--no-reddit", action="store_true")
    a = ap.parse_args()
    m = M(a.port); m.newsession()
    if not wait_ready(m):
        print("gjoa not ready", file=sys.stderr); m.quit(); sys.exit(3)
    race = probe_race(m)
    reddit = None if a.no_reddit else probe_reddit(m)
    m.quit()
    race_bad = [d for (d, mf, _p, _v) in race if mf]
    print("\n=== VERDICT ===", file=sys.stderr)
    if race_bad:
        print(f"  RACE CONFIRMED — misfires at focus→type delays {race_bad}ms "
              f"(async _gjoaEditable lags the keystroke)", file=sys.stderr)
    else:
        print("  no race in synthetic test (actor cache kept up at all delays)", file=sys.stderr)
    if reddit and reddit.get("found"):
        print(f"  REDDIT: misfire={reddit.get('misfire')} gjoaEditable={reddit.get('gjoaEditable')} "
              f"focused={reddit.get('tag')}/{reddit.get('role')}", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
