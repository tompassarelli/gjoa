#!/usr/bin/env python3
# Boot dev gjoa, navigate a URL, dump ground-truth computed styles for dark-mode debug.
import sys, time, subprocess, os
sys.path.insert(0, os.path.dirname(__file__))
from importlib import import_module
rd = import_module("render-darkmode".replace("-","_")) if False else None
# reuse M class
import socket, json, base64
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
            c=self.s.recv(65536); self.buf+=c
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need:
            c=self.s.recv(65536); self.buf+=c
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
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAV {e}"
    def exe(self,s,t=20000):
        try:
            r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
            return r.get("value") if isinstance(r,dict) else r
        except SystemExit as e: return f"ERR {e}"

port=int(sys.argv[1]); url=sys.argv[2]; settle=float(sys.argv[3]) if len(sys.argv)>3 else 18
m=M(port); m.newsession(); m.ctx("content")
m.navigate("about:blank"); time.sleep(0.3); m.navigate(url); time.sleep(settle)
probe=r"""
const out={};
const cs=el=>el?getComputedStyle(el):null;
// inversion active?
const p=document.createElement('span');p.style.cssText='color:#000;position:fixed;left:-9999px';document.body.appendChild(p);
out.blackProbeColor=getComputedStyle(p).color;p.remove();
const w=document.createElement('div');w.style.cssText='position:fixed;left:-9999px;background:#fff';document.body.appendChild(w);
out.whiteProbeBg=getComputedStyle(w).backgroundColor;w.remove();
out.normalized=document.documentElement.getAttribute('data-gjoa-normalized');
out.normalizeDetail=document.documentElement.getAttribute('data-gjoa-normalize-detail');
out.htmlBg=cs(document.documentElement).backgroundColor;
out.bodyBg=cs(document.body).backgroundColor;
// find big headings and report fg + nearest opaque ancestor bg
function ancBg(el){let e=el;while(e){const c=getComputedStyle(e).backgroundColor;if(c && !/, 0\)$/.test(c) && c!=='transparent')return {bg:c,on:e.tagName+'.'+(e.className||'').toString().slice(0,30)};e=e.parentElement;}return{bg:'none'};}
const hs=[...document.querySelectorAll('h1,h2,h3')].filter(h=>h.textContent.trim().length>2).slice(0,6);
out.heads=hs.map(h=>{const r=h.getBoundingClientRect();const a=ancBg(h);return{t:h.textContent.trim().slice(0,20),fg:cs(h).color,bg:a.bg,bgOn:a.on,y:Math.round(r.top),cn:h.getAttribute('data-gjoa-cn'),panel:h.closest('[data-gjoa-panel]')?.getAttribute('data-gjoa-panel')};});
// big light panels present?
let panels=[];for(const el of document.body.querySelectorAll('div,section,header,main')){const r=el.getBoundingClientRect();if(r.width*r.height<28000||r.top>1000||r.bottom<0)continue;const c=getComputedStyle(el).backgroundColor;const m=c.match(/[\d.]+/g);if(!m)continue;const rgb=m.slice(0,3).map(Number);const L=(0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2])/255;if(L>0.5){panels.push({tag:el.tagName,cls:(el.className||'').toString().slice(0,25),bg:c,L:L.toFixed(2),tagged:el.getAttribute('data-gjoa-panel'),w:Math.round(r.width),h:Math.round(r.height)});}}
out.lightPanels=panels.slice(0,8);
return JSON.stringify(out);
"""
r=m.exe(probe)
print(r)
