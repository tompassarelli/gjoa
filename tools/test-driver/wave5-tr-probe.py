#!/usr/bin/env python3
"""Wave5 W-F transparent-root probe. Connect to a booted gjoa over marionette,
navigate each site, and for each report the DECISION-relevant state:
  - authored/computed html+body backgroundColor + alpha (transparent-root test)
  - engineInverting (black-probe computed color, oklch/rgb robust)
  - whether gjoa's #gjoa-darkmode-root-opaque sheet is present
  - a 7x7 elementFromPoint bg-luminance grid: light-patch count + mean L
Plus a content screenshot (top + mid). Emits one JSON line per site to stdout.
"""
import argparse, base64, json, socket, sys, time

class M:
    def __init__(self, port, host="127.0.0.1", timeout=120):
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
    def newsession(self): return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{"pageLoadStrategy":"eager"},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def timeouts(self,pl): self.send("WebDriver:SetTimeouts",{"pageLoad":pl,"script":30000,"implicit":0})
    def rect(self,w,h):
        try: self.send("WebDriver:SetWindowRect",{"width":w,"height":h,"x":0,"y":0})
        except SystemExit: pass
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAV {e}"
    def exe(self,s,t=30000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def shot(self,path):
        self.ctx("chrome")
        r=self.send("WebDriver:TakeScreenshot",{"full":False})
        data=r.get("value") if isinstance(r,dict) else r
        open(path,"wb").write(base64.b64decode(data))
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

PROBE = r"""
function parse(c){ const m=c&&c.match(/[\d.]+/g); return m?m.map(Number):null; }
function alpha(c){ if(!c||c==='transparent') return 0; const p=parse(c); if(!p) return 1; return p.length>=4?p[3]:1; }
function lum(c){ const p=parse(c); if(!p||p.length<3) return null; return 0.2126*p[0]+0.7152*p[1]+0.0722*p[2]; }
const html=document.documentElement, body=document.body;
const htmlBg=getComputedStyle(html).backgroundColor;
const bodyBg=body?getComputedStyle(body).backgroundColor:'';
let inv=null;
try{ const s=document.createElement('span'); s.style.cssText='color:#000;position:fixed;left:-9999px;top:0'; body.appendChild(s);
  const cc=getComputedStyle(s).color; const p=(cc.match(/[\d.]+/g)||[]).map(Number);
  inv=/okl|lab|lch/i.test(cc)?(p.length>=1&&p[0]>0.5):(p.length>=3&&p[0]+p[1]+p[2]>300); s.remove(); }catch(e){}
const rootSheet=!!document.getElementById('gjoa-darkmode-root-opaque');
let lights=0,total=0,sumL=0;
for(let i=1;i<=7;i++)for(let j=1;j<=7;j++){ const el=document.elementFromPoint(innerWidth*i/8, innerHeight*j/8);
  if(!el)continue; const L=lum(getComputedStyle(el).backgroundColor); if(L!=null){total++;sumL+=L;if(L>140)lights++;} }
return JSON.stringify({htmlBg,bodyBg,htmlAlpha:+alpha(htmlBg).toFixed(2),bodyAlpha:+alpha(bodyBg).toFixed(2),
  engineInverting:inv,rootOpaqueSheet:rootSheet,lightPatches:lights,sampled:total,
  avgL:total?Math.round(sumL/total):null,colorScheme:getComputedStyle(html).colorScheme});
"""

def sld(h):
    h=(h or "").replace("www.",""); p=str(h).split("."); return p[-2] if len(p)>=2 else h

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--prefix",required=True)   # before | after
    ap.add_argument("--outdir",required=True)
    ap.add_argument("--urls",required=True)     # comma-sep
    ap.add_argument("--settle",type=float,default=16.0)
    a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!window.gBrowser;")==True: break
        time.sleep(0.25)
    m.timeouts(30000); m.rect(1600,1000)
    for url in [u.strip() for u in a.urls.split(",") if u.strip()]:
        slug="".join(c if c.isalnum() else "_" for c in url.replace("https://","").replace("www.",""))[:32]
        m.ctx("content")
        m.navigate("about:blank"); time.sleep(0.3)
        m.navigate(url); time.sleep(a.settle)
        try: m.exe("window.scrollTo(0,0); return 1;")
        except Exception: pass
        time.sleep(0.5)
        try: probe=m.exe(PROBE)
        except SystemExit as e: probe=f"PROBEFAIL {e}"
        m.shot(f"{a.outdir}/{a.prefix}-{slug}-1top.png")
        m.ctx("content")
        try: m.exe("window.scrollTo(0, Math.min(1100,(document.body?document.body.scrollHeight:1100))); return 1;")
        except Exception: pass
        time.sleep(1.0)
        m.shot(f"{a.outdir}/{a.prefix}-{slug}-2mid.png")
        print(json.dumps({"slug":slug,"url":url,"probe":probe}), flush=True)
    m.quit()

if __name__=="__main__": main()
