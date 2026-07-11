#!/usr/bin/env python3
"""Crash-isolating control-arm renderer for the dark-mode eval TAIL.

Same capture semantics as render-darkmode.py (1600x1000, settle, top+mid
screenshots via chrome context) so dr/light pairs stay comparable to the gjoa
arm — but hardened for the corpus tail, where logged-in FF control profiles hit
anti-bot / account flows (e.g. instagram/facebook serve an AWS WAF challenge that
NULLs the top browsing context: `this[#curBrowser].contentBrowser is null`). That
wedge poisons the whole marionette session — in-process recovery (new tab/switch)
does NOT heal it (verified). So a wedge is fatal to THIS browser: we name the
crasher, and exit 42 so the runner reboots and resumes past it. Idempotent:
already-rendered slugs (output file present) are skipped, so reboot-resume is cheap.

Extras vs the base renderer: pageLoadStrategy=eager + a real pageLoad timeout, so
a never-settling SPA can't block WebDriver:Navigate for the marionette default.
"""
import argparse, base64, json, os, socket, sys, time

class Wedge(Exception): pass

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
    def newsession(self):
        return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{"pageLoadStrategy":"eager"},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def timeouts(self,pl): self.send("WebDriver:SetTimeouts",{"pageLoad":pl,"script":20000,"implicit":0})
    def rect(self,w,h):
        try: self.send("WebDriver:SetWindowRect",{"width":w,"height":h,"x":0,"y":0})
        except SystemExit: pass
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAV {e}"
    # exe: on a WEDGE (dead browsing context) raise Wedge so the caller can bail
    # + reboot; on an ordinary script error return None (matches base renderer).
    def exe(self,s,t=15000):
        try:
            r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
            return r.get("value") if isinstance(r,dict) else r
        except SystemExit as e:
            msg=str(e)
            if ("no such window" in msg or "contentBrowser is null" in msg
                    or "Browsing context" in msg or "web element reference" in msg):
                raise Wedge(msg)
            return None
    def shot(self,path):
        self.ctx("chrome")
        r=self.send("WebDriver:TakeScreenshot",{"full":False})
        data=r.get("value") if isinstance(r,dict) else r
        open(path,"wb").write(base64.b64decode(data))
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

def sld(h):
    h=(h or "").replace("www.",""); p=str(h).split("."); return p[-2] if len(p)>=2 else h

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--prefix",required=True)     # dr | light
    ap.add_argument("--outdir",default="/tmp/dr-compare-remainder")
    ap.add_argument("--urls",required=True)        # comma-sep
    ap.add_argument("--settle",type=float,default=18.0)
    ap.add_argument("--skip",default="")           # comma-sep slugs the runner has blacklisted
    ap.add_argument("--crasher-file",default="/tmp/dr-arm-crasher")
    a=ap.parse_args()
    skip=set(s for s in a.skip.split(",") if s)
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(80):
        try:
            if m.exe("return !!window.gBrowser;")==True: break
        except Wedge: pass
        time.sleep(0.25)
    m.timeouts(25000); m.rect(1600,1000)
    for url in [u.strip() for u in a.urls.split(",") if u.strip()]:
        slug="".join(c if c.isalnum() else "_" for c in url.replace("https://","").replace("www.",""))[:32]
        want=sld(url.replace("https://","").replace("http://","").split("/")[0])
        if slug in skip: continue
        top=f"{a.outdir}/{a.prefix}-{slug}-1top.png"
        if os.path.exists(top):    # idempotent: already rendered on a prior boot
            print(f"  {a.prefix}: {slug} (already done)", file=sys.stderr); continue
        try:
            m.ctx("content")
            m.navigate("about:blank"); time.sleep(0.3)
            m.navigate(url); time.sleep(a.settle)
            host=m.exe("return location.host;")
            for _try in range(2):
                if sld(host)==want: break
                m.navigate("about:blank"); time.sleep(0.3); m.navigate(url); time.sleep(a.settle)
                host=m.exe("return location.host;")
            if sld(host)!=want:
                print(f"  {a.prefix}: {slug} WRONG-PAGE want={want} got={host!r} (skipped, no false pair)", file=sys.stderr)
                continue
            try: m.exe("window.scrollTo(0,0); return 1;")
            except Wedge: raise
            except Exception: pass
            time.sleep(0.6)
            m.shot(top)
            m.ctx("content")
            try: m.exe("window.scrollTo(0, Math.min(1100, (document.body?document.body.scrollHeight:1100))); return 1;")
            except Wedge: raise
            except Exception: pass
            time.sleep(1.2)
            m.shot(f"{a.outdir}/{a.prefix}-{slug}-2mid.png")
            print(f"  {a.prefix}: {slug}", file=sys.stderr)
        except Wedge as w:
            # This browser is poisoned. Name the crasher for the runner's blacklist,
            # then exit so the runner reboots and resumes at the next url.
            open(a.crasher_file,"w").write(slug)
            print(f"  {a.prefix}: {slug} WEDGE ({str(w)[:70]}) -> reboot", file=sys.stderr)
            sys.exit(42)
    m.quit()

if __name__=="__main__": main()
