#!/usr/bin/env python3
# Inspect WHY a page's large header/nav bands render light under gjoa dark mode.
# Loads a URL in gjoa-dev (content ctx), walks the DOM for big elements in the top
# region whose PAINTED background is light, and dumps each one's background TYPE
# (solid color / css gradient / url image) + computed colors + whether the engine
# inverted it. Tells us exactly what the actor light-band fix must target.
import argparse, json, socket, sys, time

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=10); self.s.settimeout(180); break
            except OSError as e: last=e; time.sleep(0.2)
        else: raise SystemExit(f"connect failed: {last}")
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
                if r[2]: raise SystemExit(f"{name} error: {r[2]}")
                return r[3]
    def newsession(self): return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def nav(self,u): self.send("WebDriver:Navigate",{"url":u})
    def exe(self,s,t=40000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

INSPECT = r"""
  // Replicate the actor's engineInverting() black-probe: is the engine
  // luminance-inverting this doc right now?
  let engineInverting = null;
  try {
    const pr = document.createElement('span');
    pr.style.cssText = 'color:#000;position:fixed;left:-9999px;top:0';
    document.body.appendChild(pr);
    const cstr = getComputedStyle(pr).color;
    const pc = (cstr.match(/[\d.]+/g)||[]).map(Number);
    pr.remove();
    engineInverting = /okl|lab|lch/i.test(cstr) ? pc[0] > 0.5 : (pc[0]+pc[1]+pc[2] > 300);
  } catch(e) { engineInverting = 'err:'+e; }
  const taggedPanels = document.querySelectorAll('[data-gjoa-panel]').length;
  const taggedDim = document.querySelectorAll('[data-gjoa-dim]').length;
  const de = document.documentElement;
  const csDecl = getComputedStyle(de).colorScheme;
  const metaCS = (document.querySelector('meta[name="color-scheme"]')||{}).content || null;
  const rootBg = getComputedStyle(de).backgroundColor;
  const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null;
  const out = [];
  const W = innerWidth, H = 1000; // top region
  const lum = (r,g,b) => 0.2126*r + 0.7152*g + 0.0722*b;
  const parse = s => { const m=(s||'').match(/rgba?\(([^)]+)\)/); if(!m) return null;
    const p=m[1].split(',').map(x=>parseFloat(x)); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; };
  const all = document.querySelectorAll('div,section,header,nav,ul,aside,main,body,tr,td');
  let scanned=0;
  for (const el of all) {
    if (++scanned>6000) break;
    let r; try { r=el.getBoundingClientRect(); } catch(e){ continue; }
    if (r.width*r.height < 30000 || r.top>H || r.bottom<0 || r.width<200) continue;
    const cs = getComputedStyle(el);
    const bgc = parse(cs.backgroundColor);
    const bgi = cs.backgroundImage || 'none';
    const hasGrad = /gradient\(/i.test(bgi);
    const hasUrl = /url\(/i.test(bgi);
    // Is this element PAINTED light? sample its own bg color if opaque, else skip solids.
    let paintedLight=null, srcL=null;
    if (bgc && bgc.a>0.5) { srcL = lum(bgc.r,bgc.g,bgc.b); paintedLight = srcL>150; }
    // For gradients/images, extract any rgb stops to gauge lightness.
    let gradL=null;
    if (hasGrad) {
      const stops=[...bgi.matchAll(/rgba?\(([^)]+)\)/g)].map(m=>m[1].split(',').map(parseFloat));
      if (stops.length){ gradL = Math.max(...stops.map(s=>lum(s[0],s[1],s[2]))); }
    }
    const interesting = (paintedLight===true) || (hasGrad && (gradL===null || gradL>150)) || hasUrl;
    if (!interesting) continue;
    out.push({
      tag: el.tagName, id: el.id||'', cls: (el.className&&el.className.toString?el.className.toString():'').slice(0,50),
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
      bgColor: cs.backgroundColor, bgColorLum: srcL!==null?Math.round(srcL):null,
      bgType: hasUrl?'url':hasGrad?'gradient':(paintedLight?'solid':'?'),
      bgImage: bgi.slice(0,90), gradMaxLum: gradL!==null?Math.round(gradL):null,
    });
  }
  // de-dup by (tag,cls,top), keep biggest
  return JSON.stringify({engineInverting, csDecl, metaCS, rootBg, bodyBg, taggedPanels, taggedDim, bands: out.slice(0,8)});
"""

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--urls",required=True); ap.add_argument("--settle",type=int,default=16)
    a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("content")
    for u in a.urls.split(","):
        u=u.strip()
        if not u: continue
        try:
            m.nav(u); time.sleep(a.settle)
            rows=json.loads(m.exe(INSPECT))
        except Exception as e:
            rows=[{"error":str(e)}]
        print(json.dumps({"url":u,"diag":rows}, indent=1))
    m.quit()

if __name__=="__main__": main()
