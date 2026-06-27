#!/usr/bin/env python3
"""Same question, REAL keys: focus a non-editable content div via marionette, then
xdotool (run by the caller) injects a real X 't'. Poll the picker. If it opens, real
OS keystrokes route content->chrome — the vim-misfire class IS machine-testable via
Xvfb + xdotool (no human, no marionette synthetic-key limitation).
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
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

POPEN=("const p=document.getElementById('gjoa-picker');"
       "return !!(p && !p.hidden && p.querySelector('.gjoa-picker-input'));")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    m.exe("Services.prefs.setBoolPref('gjoa.keys.useLeader', false); const p=document.getElementById('gjoa-picker'); if(p)p.hidden=true; return 1;")
    m.ctx("content")
    m.navigate("data:text/html,<body style='height:1500px'><div tabindex=0 id=d style='position:fixed;top:0;left:0'>x</div><script>onload=()=>d.focus()</script></body>")
    time.sleep(1.0)
    m.exe("document.getElementById('d').focus(); return document.activeElement.id;")
    print("SETUP_DONE", flush=True)  # caller xdotool-types after seeing this
    # poll the picker for ~4s while the real key arrives
    opened=False
    for _ in range(40):
        m.ctx("chrome")
        if m.exe(POPEN): opened=True; break
        time.sleep(0.1)
    print(f"  REAL-KEY 't' on non-editable div -> pickerOpened={opened}", file=sys.stderr)
    print(f"  => real OS keys {'REACH' if opened else 'do NOT reach'} the chrome vim handler", file=sys.stderr)
    m.quit(); sys.exit(0 if opened else 2)

if __name__=="__main__": main()
