#!/usr/bin/env python3
"""Navigate real sites, screenshot the CONTENT, and report gjoa's darkmode verdict
per site (the actor's applied mode + a luminance sample of the rendered page, so we
can tell 'actually dark' from 'gjoa thinks it handled it'). For the YouTube etc.
'dark mode must just work' audit.
"""
import argparse, base64, json, socket, sys, time

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf = b""; self.id = 1
        deadline = time.time() + timeout; last = None
        while time.time() < deadline:
            try:
                self.s = socket.create_connection((host, port), timeout=10); self.s.settimeout(120); break
            except OSError as e:
                last = e; time.sleep(0.2)
        else: raise SystemExit(f"connect failed: {last}")
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
        p = self.buf[i+1:need]; self.buf = self.buf[need:]
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
    def shot(self, path, full=False):
        r = self.send("WebDriver:TakeScreenshot", {"full": full})
        data = r.get("value") if isinstance(r, dict) else r
        open(path, "wb").write(base64.b64decode(data)); return path
    def quit(self):
        try: self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except SystemExit: pass

# Sample background luminance of <html>/<body> + a grid of points, to judge "is it
# actually dark on screen" independent of what the actor THINKS it did.
LUMA = r"""
  function lum(c){ const m=c&&c.match(/\d+/g); if(!m) return null;
    const [r,g,b]=m.map(Number); return 0.2126*r+0.7152*g+0.0722*b; }
  const bodyBg = getComputedStyle(document.body||document.documentElement).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  // sample elementsFromPoint luminance across a 5x5 grid
  let lights=0, total=0;
  for(let i=1;i<=5;i++) for(let j=1;j<=5;j++){
    const el=document.elementFromPoint(window.innerWidth*i/6, window.innerHeight*j/6);
    if(!el) continue; const L=lum(getComputedStyle(el).backgroundColor);
    if(L!=null){ total++; if(L>140) lights++; }
  }
  return JSON.stringify({bodyBg, htmlBg, lightPatches:lights, sampled:total,
    htmlClass:document.documentElement.className.slice(0,80),
    colorScheme:getComputedStyle(document.documentElement).colorScheme});
"""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=2828)
    ap.add_argument("--sites", default="https://www.youtube.com/")
    a = ap.parse_args()
    m = M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    dm = m.exe("try{return JSON.stringify({init:!!window.gjoaTest, dm:(window.GjoaDarkmode?'present':'n/a')});}catch(e){return String(e);}")
    print(f"  chrome darkmode hook: {dm}", file=sys.stderr)
    for idx, url in enumerate(a.sites.split(",")):
        url = url.strip()
        m.ctx("content"); nav = m.navigate(url)
        if isinstance(nav, str) and nav.startswith("NAVFAIL"):
            print(f"  {url}: NAVFAIL ({nav})", file=sys.stderr); continue
        time.sleep(8.0)  # heavy SPA settle
        title = m.exe("return document.title;")
        luma = m.exe(LUMA)
        slug = url.replace("https://","").replace("/","_").strip("_")[:30]
        path = f"/tmp/dm-{idx}-{slug}.png"
        m.shot(path)
        print(f"\n  [{url}] title={title!r}", file=sys.stderr)
        print(f"    luma: {luma}", file=sys.stderr)
        print(f"    shot: {path}", file=sys.stderr)
    m.quit(); sys.exit(0)

if __name__ == "__main__":
    main()
