#!/usr/bin/env python3
"""Fail-closed runtime qualification for the pinned daily Dark Reader control.

It records no visual/aesthetic score: only extension activation, URL/content
identity, and existence of top+mid captures for the six owner-reported URLs.
"""
import argparse, base64, hashlib, json, os, socket, sys, time

class M:
    def __init__(self, port):
        self.s=socket.create_connection(("127.0.0.1",port),timeout=20); self.buf=b""; self.i=0; self.recv()
    def recv(self):
        while b":" not in self.buf: self.buf += self.s.recv(65536)
        n,_,rest=self.buf.partition(b":"); n=int(n)
        while len(rest)<n: rest += self.s.recv(65536)
        self.buf=rest[n:]; return json.loads(rest[:n])
    def send(self,name,params):
        self.i+=1; msg=json.dumps([0,self.i,name,params]).encode(); self.s.sendall(f"{len(msg)}:".encode()+msg)
        while True:
            r=self.recv()
            if r[0]==1 and r[1]==self.i:
                if r[2]: raise RuntimeError(f"{name}: {r[2]}")
                return r[3]
    def start(self): self.send("WebDriver:NewSession",{}); self.send("Marionette:SetContext",{"value":"content"})
    def nav(self,url): self.send("WebDriver:Navigate",{"url":url})
    def js(self,script): return (self.send("WebDriver:ExecuteScript",{"script":script,"args":[]}) or {}).get("value")
    def shot(self,path):
        self.send("Marionette:SetContext",{"value":"chrome"})
        data=(self.send("WebDriver:TakeScreenshot",{"full":False}) or {}).get("value")
        open(path,"wb").write(base64.b64decode(data))
        self.send("Marionette:SetContext",{"value":"content"})

def page(m, url, out, label, slug, require_dr):
    if require_dr:
        before=m.js("return document.querySelectorAll('style.darkreader').length")
        if before <= 0: raise RuntimeError(f"{label} sentinel before navigation: {before} Dark Reader styles")
    m.nav(url); time.sleep(4)
    here=m.js("return location.href")
    text=m.js("return (document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim()")
    if not text: raise RuntimeError(f"{label} empty content at {here}")
    if require_dr:
        after=m.js("return document.querySelectorAll('style.darkreader').length")
        if after <= 0: raise RuntimeError(f"{label} sentinel after navigation: {after} Dark Reader styles")
    m.js("window.scrollTo(0,0); return 1"); time.sleep(.3); top=f"{out}/{label}-{slug}-1top.png"; m.shot(top)
    m.js("window.scrollTo(0,Math.min(1100,document.documentElement.scrollHeight)); return 1"); time.sleep(.3); mid=f"{out}/{label}-{slug}-2mid.png"; m.shot(mid)
    if not (os.path.getsize(top) and os.path.getsize(mid)): raise RuntimeError(f"{label} incomplete captures for {url}")
    return here, hashlib.sha256(text.encode()).hexdigest()

def gjoa_off_light(gjoa):
    gjoa.send("Marionette:SetContext",{"value":"chrome"})
    script="""const w=Services.wm.getMostRecentWindow('navigator:browser'); const p='gjoa.darkmode.enabled';
let old=Services.prefs.getBoolPref(p,true); Services.prefs.setBoolPref(p,false); let off=Services.prefs.getBoolPref(p,true);
Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override',1); let light=Services.prefs.getIntPref('layout.css.prefers-color-scheme.content-override',0);
Services.prefs.setBoolPref(p,old); return {off,light,rollback:Services.prefs.getBoolPref(p,!old)===old};"""
    state=(gjoa.send("WebDriver:ExecuteScript",{"script":script,"args":[]}) or {}).get("value") or {}
    if state != {"off":False,"light":1,"rollback":True}: raise RuntimeError(f"Gjoa off/light/rollback failed: {state}")
    print("gjoa off/light/rollback: PASS")

def main():
    a=argparse.ArgumentParser(); a.add_argument("--gjoa-port",type=int,required=True); a.add_argument("--dr-port",type=int,required=True); a.add_argument("--light-port",type=int,required=True); a.add_argument("--outdir",required=True); a.add_argument("--urls",default="configs/dark-mode-owner-faults.txt"); args=a.parse_args()
    urls=[x.strip() for x in open(args.urls) if x.strip() and not x.startswith('#')]
    if len(urls)!=6: raise SystemExit(f"expected exactly six owner URLs, got {len(urls)}")
    os.makedirs(args.outdir,exist_ok=True); arms={"gjoa":M(args.gjoa_port),"dr":M(args.dr_port),"light":M(args.light_port)}
    for m in arms.values(): m.start()
    gjoa_off_light(arms["gjoa"])
    for n,url in enumerate(urls,1):
        slug=f"owner{n}"; results={name:page(m,url,args.outdir,name,slug,name=="dr") for name,m in arms.items()}
        hashes={v[1] for v in results.values()}
        if len(hashes)!=1: raise RuntimeError(f"same-content mismatch for owner URL {n}: {results}")
        print(f"owner URL {n}: sentinel + top/mid + same-content PASS")

if __name__=="__main__":
    try: main()
    except Exception as e: print(f"qualification FAILED: {e}",file=sys.stderr); sys.exit(1)
