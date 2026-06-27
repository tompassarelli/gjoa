#!/usr/bin/env python3
"""Mechanism test for the general fix: does a CONTENT-process capturing keydown
listener that calls stopImmediatePropagation() prevent gjoa's CHROME keydown
handler from firing the vim command? If yes, the fix is tiny (the actor stops the
event when event.target is editable). If no, the gate must move fully into the
actor. Also tests the inverse: with the listener gone, the command fires (baseline).
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
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAVFAIL {e}"
    def exe(self,s,t=30000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def keys(self,s):
        acts=[]
        for ch in s: acts+=[{"type":"keyDown","value":ch},{"type":"keyUp","value":ch}]
        self.send("WebDriver:PerformActions",{"actions":[{"type":"key","id":"kb","actions":acts}]})
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

PICKER="const p=document.getElementById('gjoa-picker'); return !!(p && !p.hidden);"
CLOSE="const p=document.getElementById('gjoa-picker'); if(p)p.hidden=true; return 1;"
# non-editable focusable div: vim SHOULD fire 't' here
PAGE=("data:text/html,<body style='height:1500px'><div tabindex=0 id=d "
      "style='position:fixed;top:0;left:0'>focus me</div>"
      "<script>onload=()=>document.getElementById('d').focus()</script></body>")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)

    # baseline: non-editable div focused, 't' should fire the picker
    m.ctx("chrome"); m.exe(CLOSE)
    m.ctx("content"); m.navigate(PAGE); time.sleep(1.0)
    m.exe("document.getElementById('d').focus(); return 1;")
    m.keys("t"); time.sleep(0.4)
    m.ctx("chrome"); base=m.exe(PICKER)
    print(f"  BASELINE (no listener): pickerOpened={base}  (expect True — vim fires on non-editable)", file=sys.stderr)

    # now add a CONTENT capturing keydown listener that stops propagation on 't'
    m.exe(CLOSE)
    m.ctx("content")
    m.exe("window.__hits=0; document.addEventListener('keydown', function(e){ window.__hits++; "
          "if(e.key==='t'){ e.stopImmediatePropagation(); } }, true); "
          "document.getElementById('d').focus(); return 1;")
    m.keys("t"); time.sleep(0.4)
    hits=m.exe("return window.__hits;")
    m.ctx("chrome"); stopped=m.exe(PICKER)
    print(f"  WITH stopImmediatePropagation: pickerOpened={stopped}  contentListenerHits={hits}", file=sys.stderr)

    # also test stopPropagation (non-immediate)
    m.exe(CLOSE); m.ctx("content")
    m.exe("document.addEventListener('keydown', function(e){ if(e.key==='t'){ e.stopPropagation(); } }, true); "
          "document.getElementById('d').focus(); return 1;")
    m.keys("t"); time.sleep(0.4)
    m.ctx("chrome"); stopped2=m.exe(PICKER)
    print(f"  WITH stopPropagation: pickerOpened={stopped2}", file=sys.stderr)

    print("\n  VERDICT:", file=sys.stderr)
    if base and not stopped:
        print("  ✓ content stopImmediatePropagation BLOCKS the chrome command → tiny fix viable "
              "(actor stops event when event.target editable)", file=sys.stderr)
    elif base and stopped:
        print("  ✗ content stopProp does NOT block chrome → must move the gate into the actor "
              "(forward non-editable keys to chrome)", file=sys.stderr)
    else:
        print(f"  ? baseline didn't fire (base={base}) — env issue, rerun", file=sys.stderr)
    m.quit(); sys.exit(0)

if __name__=="__main__": main()
