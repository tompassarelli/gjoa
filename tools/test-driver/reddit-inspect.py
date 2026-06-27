#!/usr/bin/env python3
"""Identify the EXACT element behind Reddit's "Find anything" search and why gjoa's
editable detector misses it. Wide viewport (like the user). Clicks the search,
dumps the deep-active element (tag/type/role/contentEditable/all attrs/ancestor
chain/which frame), and gjoa's editable verdict + _gjoaEditable.
"""
import argparse, base64, json, socket, sys, time

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=10); self.s.settimeout(120); break
            except OSError as e: last=e; time.sleep(0.2)
        else: raise SystemExit(f"connect failed: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf:
            c=self.s.recv(65536);
            if not c: raise SystemExit("closed")
            self.buf+=c
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need:
            c=self.s.recv(65536)
            if not c: raise SystemExit("closed")
            self.buf+=c
        p=self.buf[i+1:need]; self.buf=self.buf[need:]; return json.loads(p.decode())
    def send(self,name,params):
        mid=self.id; self.id+=1
        msg=json.dumps([0,mid,name,params]).encode()
        self.s.sendall(f"{len(msg)}:".encode()+msg)
        while True:
            r=self._frame()
            if isinstance(r,list) and r[0]==1 and r[1]==mid:
                if r[2]: raise SystemExit(f"{name} error: {r[2]}")
                return r[3]
    def newsession(self): return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def rect(self,w,h): self.send("WebDriver:SetWindowRect",{"width":w,"height":h,"x":0,"y":0})
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAVFAIL {e}"
    def exe(self,s,t=30000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def click_xy(self,x,y):
        self.send("WebDriver:PerformActions",{"actions":[{"type":"pointer","id":"m","parameters":{"pointerType":"mouse"},"actions":[
            {"type":"pointerMove","duration":0,"x":int(x),"y":int(y)},{"type":"pointerDown","button":0},{"type":"pointerUp","button":0}]}]})
    def keys(self,s):
        acts=[]
        for ch in s: acts+=[{"type":"keyDown","value":ch},{"type":"keyUp","value":ch}]
        self.send("WebDriver:PerformActions",{"actions":[{"type":"key","id":"kb","actions":acts}]})
    def shot(self,p):
        r=self.send("WebDriver:TakeScreenshot",{"full":False})
        open(p,"wb").write(base64.b64decode(r.get("value") if isinstance(r,dict) else r)); return p
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

DUMP = r"""
  function deep(a){ while(a && a.shadowRoot && a.shadowRoot.activeElement) a=a.shadowRoot.activeElement; return a; }
  const a = deep(document.activeElement);
  if(!a) return JSON.stringify({none:true});
  const attrs={}; for(const at of (a.attributes||[])) attrs[at.name]=at.value.slice(0,40);
  const chain=[]; let p=a; for(let i=0;i<6&&p;i++){ chain.push(p.tagName+(p.getAttribute&&p.getAttribute('role')?'[role='+p.getAttribute('role')+']':'')); p=p.parentElement||(p.getRootNode&&p.getRootNode().host); }
  // mimic gjoa editable-element? exactly
  const UN=['button','checkbox','color','file','hidden','image','radio','reset','submit'];
  function edible(el){ if(!el||typeof el.nodeName!=='string') return false;
    if(el.readOnly===true) return false;
    const tag=el.nodeName.toLowerCase();
    if(tag==='input') return !UN.includes((el.type||'').toLowerCase());
    if(tag==='textarea'||tag==='select') return true;
    if(typeof el.isContentEditable==='boolean' && el.isContentEditable) return true;
    const role=(el.getAttribute&&(el.getAttribute('role')||'')||'').toLowerCase();
    return ['textbox','searchbox','combobox','application'].includes(role); }
  return JSON.stringify({tag:a.tagName, type:a.type, role:a.getAttribute&&a.getAttribute('role'),
    isCE:a.isContentEditable, ceAttr:a.getAttribute&&a.getAttribute('contenteditable'),
    ph:a.placeholder, ariaLabel:a.getAttribute&&a.getAttribute('aria-label'),
    inIframe:(window.top!==window), attrs, chain, gjoaEditable:edible(a)});
"""

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    m.rect(1900,1200)
    m.ctx("content"); nav=m.navigate("https://www.reddit.com/")
    if isinstance(nav,str) and nav.startswith("NAVFAIL"): print(f"net down {nav}",file=sys.stderr); m.quit(); sys.exit(1)
    time.sleep(7.0)
    # find + click the top search (the "Find anything" bar lives near top-center)
    bar=m.exe(r"""
      const c=[...document.querySelectorAll('reddit-search-large,[aria-label*="earch" i],input,textarea,[contenteditable],[role=combobox],[role=searchbox],[role=textbox]')]
        .filter(e=>{const r=e.getBoundingClientRect(); return r.width>120 && r.top<120 && r.top>=0;});
      if(!c.length) return null; const e=c[0]; const r=e.getBoundingClientRect();
      return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,tag:e.tagName});""")
    print(f"  top search bar: {bar}",file=sys.stderr)
    if bar:
        b=json.loads(bar); m.click_xy(b["x"],b["y"]); time.sleep(2.0)
    print(f"  FOCUSED ELEMENT AFTER CLICK:\n    {m.exe(DUMP)}",file=sys.stderr)
    m.shot("/tmp/reddit-inspect-expanded.png")
    # type 't' and see misfire
    m.keys("t"); time.sleep(0.6)
    m.ctx("chrome"); picker=m.exe("const p=document.getElementById('gjoa-picker'); return !!(p && !p.hidden);")
    edit=m.exe("return gBrowser.selectedBrowser._gjoaEditable===true;")
    print(f"  AFTER 't': pickerMisfired={picker}  _gjoaEditable={edit}",file=sys.stderr)
    m.shot("/tmp/reddit-inspect-after-t.png")
    m.quit(); sys.exit(0)

if __name__=="__main__": main()
