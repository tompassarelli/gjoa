#!/usr/bin/env python3
"""Repro: on first load, vim captures urlbar typing. The chrome gate excludes
#urlbar and any focused <input>, so this checks: (1) what's focused right after
boot, (2) when the urlbar IS focused, does the gate see it (tag, closest #urlbar),
(3) does typing 't' land in the urlbar or fire the vim picker.
"""
import argparse, json, socket, sys, time

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
    def exe(self,s,t=30000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def keys(self,s):
        acts=[]
        for ch in s: acts+=[{"type":"keyDown","value":ch},{"type":"keyUp","value":ch}]
        self.send("WebDriver:PerformActions",{"actions":[{"type":"key","id":"kbd","actions":acts}]})
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

ACTIVE = (r"""
  const a=document.activeElement;
  if(!a) return JSON.stringify({none:true});
  return JSON.stringify({tag:a.tagName, id:a.id, cls:(a.className||'').toString().slice(0,50),
    inUrlbar:!!(a.closest&&a.closest('#urlbar')), inGjoaSearch:!!(a.closest&&a.closest('.gjoa-search-input')),
    isInputTag:(a.tagName==='INPUT'||a.tagName==='input'||a.tagName==='TEXTAREA'),
    ce:a.isContentEditable});
""")
POPEN = ("const p=document.getElementById('gjoa-picker');"
         "return !!(p && !p.hidden && p.querySelector('.gjoa-picker-input'));")
URLVAL = "try{return gURLBar ? gURLBar.value : (document.getElementById('urlbar-input')||{}).value;}catch(e){return 'ERR '+e;}"

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    # minimal settle — mimic "first load"
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    m.exe("Services.prefs.setBoolPref('gjoa.keys.useLeader', false); return 1;")

    print(f"  [first-load focus] {m.exe(ACTIVE)}", file=sys.stderr)

    # type 't' with WHATEVER is focused on first load (the user's exact action)
    m.keys("t"); time.sleep(0.5)
    fl_picker=m.exe(POPEN); fl_url=m.exe(URLVAL)
    print(f"  [first-load, no manual focus] type 't' -> picker={fl_picker}  urlbar.value={fl_url!r}", file=sys.stderr)

    # now explicitly focus the urlbar and inspect what the gate sees
    m.exe("const p=document.getElementById('gjoa-picker'); if(p)p.hidden=true; try{gURLBar.focus();}catch(e){} return 1;")
    time.sleep(0.3)
    print(f"  [after gURLBar.focus()] {m.exe(ACTIVE)}", file=sys.stderr)
    m.exe("try{gURLBar.value='';}catch(e){} return 1;")
    m.keys("t"); time.sleep(0.5)
    ub_picker=m.exe(POPEN); ub_url=m.exe(URLVAL)
    print(f"  [urlbar focused] type 't' -> picker={ub_picker} (want False)  urlbar.value={ub_url!r} (want 't')", file=sys.stderr)

    print("\n  VERDICT:", file=sys.stderr)
    if fl_picker:
        print("  FIRST-LOAD MISFIRE: nothing editable focused on boot -> vim ate 't' (urlbar not auto-focused?)", file=sys.stderr)
    if ub_picker:
        print("  URLBAR-FOCUSED MISFIRE: gate failed to exclude the focused urlbar", file=sys.stderr)
    if not fl_picker and not ub_picker:
        print("  no misfire in harness", file=sys.stderr)
    m.quit(); sys.exit(0)

if __name__=="__main__": main()
