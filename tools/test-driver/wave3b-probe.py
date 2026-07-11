#!/usr/bin/env python3
"""Wave-3 W-B decision-layer probe: navigate each URL in a live gjoa (marionette),
screenshot, and dump the DECISION-LAYER state as JSON per site:
  - colorInversionOverride (chrome read of the tab's top browsingContext)
  - engine inversion active? (content black/white probe computed colors)
  - body/html computed bg, color-scheme, meta color-scheme
  - actor artifacts: style#gjoa-darkmode-* sheets, data-gjoa-* attrs
Usage: wave3b-probe.py --port N --outdir DIR --urls a,b,c [--settle S]
"""
import argparse, base64, json, socket, sys, time

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=5); self.s.settimeout(180); break
            except OSError as e: last=e; time.sleep(0.3)
        else: raise SystemExit(f"connect {host}:{port}: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf:
            c=self.s.recv(65536)
            if not c: raise SystemExit("closed")
            self.buf+=c
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need:
            c=self.s.recv(65536)
            if not c: raise SystemExit("closed")
            self.buf+=c
        p=self.buf[i+1:need]; self.buf=self.buf[need:]; return json.loads(p.decode())
    def send(self,name,params):
        mid=self.id; self.id+=1; msg=json.dumps([0,mid,name,params]).encode()
        self.s.sendall(f"{len(msg)}:".encode()+msg)
        while True:
            r=self._frame()
            if isinstance(r,list) and r[0]==1 and r[1]==mid:
                if r[2]: raise SystemExit(f"{name}: {r[2]}")
                return r[3]
    def newsession(self): return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def rect(self,w,h):
        try: self.send("WebDriver:SetWindowRect",{"width":w,"height":h,"x":0,"y":0})
        except SystemExit: pass
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAV {e}"
    def exe(self,s,t=20000):
        try:
            r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":True})
            return r.get("value") if isinstance(r,dict) else r
        except SystemExit as e: return {"_err":str(e)}
    def shot(self,path):
        self.ctx("chrome")
        r=self.send("WebDriver:TakeScreenshot",{"full":False})
        data=r.get("value") if isinstance(r,dict) else r
        open(path,"wb").write(base64.b64decode(data))

CONTENT_PROBE = r"""
const doc = document, win = window, out = {};
try {
  const probe = (css) => {
    const el = doc.createElement("span");
    el.style.cssText = css + ";position:fixed;left:-9999px;top:0";
    (doc.body || doc.documentElement).appendChild(el);
    const c = win.getComputedStyle(el).color, b = win.getComputedStyle(el).backgroundColor;
    el.remove(); return {color: c, bg: b};
  };
  out.blackProbe = probe("color:#000;background-color:#fff");
  out.whiteProbe = probe("color:#fff;background-color:#000");
  out.bodyBg = doc.body ? win.getComputedStyle(doc.body).backgroundColor : null;
  out.htmlBg = win.getComputedStyle(doc.documentElement).backgroundColor;
  out.bodyColor = doc.body ? win.getComputedStyle(doc.body).color : null;
  out.rootColorScheme = win.getComputedStyle(doc.documentElement).colorScheme;
  const meta = doc.querySelector('meta[name="color-scheme"]');
  out.metaColorScheme = meta ? meta.content : null;
  out.prefersDark = win.matchMedia("(prefers-color-scheme: dark)").matches;
  out.sheets = {};
  for (const id of ["gjoa-darkmode-root-opaque","gjoa-darkmode-media-dim","gjoa-darkmode-panels","gjoa-darkmode-image-pass"]) {
    const s = doc.getElementById(id);
    out.sheets[id] = s ? (s.textContent||"").length : null;
  }
  out.normalized = doc.documentElement.getAttribute("data-gjoa-normalized");
  out.normalizeDetail = doc.documentElement.getAttribute("data-gjoa-normalize-detail");
  out.dimTagged = doc.querySelectorAll("[data-gjoa-dim]").length;
  out.panelTagged = doc.querySelectorAll("[data-gjoa-panel]").length;
  out.cnTagged = doc.querySelectorAll("[data-gjoa-cn]").length;
  out.title = (doc.title||"").slice(0,80);
  out.readyState = doc.readyState;
  out.filterHtml = win.getComputedStyle(doc.documentElement).filter;
  out.filterBody = doc.body ? win.getComputedStyle(doc.body).filter : null;
} catch (e) { out._probeErr = String(e); }
return out;
"""

CHROME_PROBE = r"""
const b = gBrowser.selectedBrowser;
const bc = b.browsingContext;
const out = {};
try { out.override = bc.colorInversionOverride; } catch (e) { out.override = "ERR:"+e; }
try { out.currentURI = b.currentURI.spec; } catch (e) {}
try {
  out.prefs = {};
  for (const p of ["gjoa.darkmode.enabled","gjoa.darkmode.mode","gjoa.darkmode.hybrid.default-invert",
                   "gjoa.darkmode.force","gjoa.darkmode.invert.enabled","gjoa.darkmode.invert.bgLightness",
                   "gjoa.darkmode.scrim.alpha","gjoa.darkmode.media-dim.pct","gjoa.darkmode.normalize.enabled",
                   "gjoa.darkmode.image-analysis.enabled"]) {
    try {
      const t = Services.prefs.getPrefType(p);
      out.prefs[p] = t===Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(p)
        : t===Services.prefs.PREF_INT ? Services.prefs.getIntPref(p)
        : t===Services.prefs.PREF_STRING ? Services.prefs.getStringPref(p) : "(none)";
    } catch (e) { out.prefs[p] = "ERR"; }
  }
} catch (e) {}
return out;
"""

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--outdir",default="/tmp/wave3b")
    ap.add_argument("--urls",required=True)
    ap.add_argument("--settle",type=float,default=18.0)
    a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(80):
        if m.exe("return !!window.gBrowser;"): break
        time.sleep(0.25)
    m.rect(1600,1000)
    results={}
    for url in [u.strip() for u in a.urls.split(",") if u.strip()]:
        slug="".join(c if c.isalnum() else "_" for c in url.replace("https://","").replace("www.",""))[:32]
        m.ctx("content")
        m.navigate("about:blank"); time.sleep(0.3)
        m.navigate(url); time.sleep(a.settle)
        r={}
        m.ctx("content")
        r["content"]=m.exe(CONTENT_PROBE)
        m.ctx("chrome")
        r["chrome"]=m.exe(CHROME_PROBE)
        m.shot(f"{a.outdir}/probe-{slug}.png")
        results[slug]=r
        print(f"probed {slug}", file=sys.stderr)
    print(json.dumps(results,indent=1))

if __name__=="__main__": main()
