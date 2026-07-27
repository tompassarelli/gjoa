#!/usr/bin/env python3
import sys, time, socket, json
class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=5); self.s.settimeout(180); break
            except OSError as e: last=e; time.sleep(0.3)
        else: raise SystemExit(f"connect {host}:{port}: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf: self.buf+=self.s.recv(65536)
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need: self.buf+=self.s.recv(65536)
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
port=int(sys.argv[1]); url=sys.argv[2]; needle=sys.argv[3]; settle=float(sys.argv[4]) if len(sys.argv)>4 else 18
m=M(port); m.newsession(); m.ctx("content")
m.navigate("about:blank"); time.sleep(0.3); m.navigate(url); time.sleep(settle)
probe=r"""
const NEEDLE=arguments[0]||"iPhone";
""".replace("arguments[0]", json.dumps(needle)) + r"""
function bgChain(el){const out=[];let e=el;let depth=0;while(e&&depth<8){const cs=getComputedStyle(e);out.push({tag:e.tagName,cls:(e.className||'').toString().slice(0,28),bg:cs.backgroundColor,bgImg:(cs.backgroundImage||'none').slice(0,40),panel:e.getAttribute&&e.getAttribute('data-gjoa-panel')});e=e.parentElement;depth++;}return out;}
const all=[...document.querySelectorAll('*')].filter(el=>{for(const n of el.childNodes){if(n.nodeType===3&&n.textContent.includes(NEEDLE))return true;}return false;});
const res=all.slice(0,4).map(el=>{const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return{tag:el.tagName,cls:(el.className||'').toString().slice(0,30),txt:el.textContent.trim().slice(0,24),fg:cs.color,y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),cn:el.getAttribute('data-gjoa-cn'),chain:bgChain(el)};});
// also: any <img>/<picture> in top 1200px and their rects
const imgs=[...document.querySelectorAll('img,picture,video')].map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),dim:el.getAttribute('data-gjoa-dim')};}).filter(o=>o.y<1200&&o.w>100&&o.h>100).slice(0,6);
return JSON.stringify({found:all.length,res,imgs});
"""
print(m.exe(probe))
