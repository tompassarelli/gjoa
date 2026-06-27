#!/usr/bin/env python3
"""Single question: do CONTENT-context keystrokes reach the chrome vim handler?
Focus a non-editable content div, type 't' in CONTENT context, see if the vim tab
picker opens. picker=True => content keys route to chrome (real-keyboard-like) =>
the vim-misfire class is machine-testable here. Run headless vs headful to compare.
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
        self.send("WebDriver:PerformActions",{"actions":[{"type":"key","id":"kbd","actions":acts}]})
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

    # content: non-editable focusable div, focused
    m.ctx("content")
    m.navigate("data:text/html,<body style='height:1500px'><div tabindex=0 id=d style='position:fixed;top:0;left:0'>x</div><script>onload=()=>d.focus()</script></body>")
    time.sleep(1.0)
    m.exe("document.getElementById('d').focus(); return document.activeElement.id;")
    # type 't' in CONTENT context (the real user path)
    m.keys("t"); time.sleep(0.5)
    m.ctx("chrome"); picker=m.exe(POPEN)
    print(f"  CONTENT-ctx 't' on non-editable div -> pickerOpened={picker}", file=sys.stderr)
    print(f"  => content keys {'REACH' if picker else 'do NOT reach'} the chrome vim handler", file=sys.stderr)
    m.quit(); sys.exit(0)

if __name__=="__main__": main()
