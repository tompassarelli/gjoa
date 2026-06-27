#!/usr/bin/env python3
"""Correct repro, built on the PASSING vim-hotkeys test's proven picker detection.
Three steps:
  A) HARNESS BASELINE — focus the chrome panel, fire 't' (chrome ctx). Picker MUST
     open, else the harness can't trigger vim and nothing below is meaningful.
  B) CONTENT NON-EDITABLE — focus a content div, type 't' (content ctx). Tells us
     whether content keystrokes reach the chrome vim handler at all.
  C) CONTENT EDITABLE — focus a textarea, type 't'. Picker must NOT open (yield).
     Plus a dynamic-modal variant (async-created+focused textarea, type immediately)
     — the real-world race the user hits.
Canonical detection + a DOM dump of the open picker so we SEE the truth.
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

# GENUINE open state: #gjoa-picker present AND not hidden AND has its live input
# child (the input is created on open). Existence alone is a false positive — the
# vbox persists hidden after first open.
POPEN = ("const p=document.getElementById('gjoa-picker');"
         "return !!(p && !p.hidden && p.querySelector('.gjoa-picker-input'));")
PSTATE = ("const p=document.getElementById('gjoa-picker');"
          "return JSON.stringify({exists:!!p, hidden:(p?p.hidden:null), "
          "input:!!(p&&p.querySelector('.gjoa-picker-input')), open:!!(p&&!p.hidden&&p.querySelector('.gjoa-picker-input'))});")
# close via the picker's OWN Escape path (no force-hide), then settle
CLOSE = ("try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,which:27,keyCode:27}));}catch(e){} return 1;")

def chrome_close(m):
    m.ctx("chrome"); m.exe(CLOSE); time.sleep(0.3)
    # verify genuinely closed; if Escape didn't take, force-hide as a labeled fallback
    if m.exe(POPEN):
        m.exe("const p=document.getElementById('gjoa-picker'); if(p){p.hidden=true; p.querySelectorAll('.gjoa-picker-input').forEach(e=>e.remove());} return 1;")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gjoaTest && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    m.exe("Services.prefs.setBoolPref('gjoa.keys.useLeader', false); return 1;")

    # A) harness baseline — chrome panel focus, chrome-ctx 't'
    chrome_close(m)
    m.exe("const t=gBrowser.addTab('about:blank',{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});"
          "gBrowser.selectedTab=t; const p=document.getElementById('gjoa-tab-panel'); if(p){p.setAttribute('tabindex','0');p.focus();} return 1;")
    time.sleep(0.4); m.keys("t"); time.sleep(0.6)
    a_open=m.exe(POPEN); a_st=m.exe(PSTATE)
    print(f"  A) chrome-panel 't': open={a_open}  state={a_st}  (MUST be open=True)", file=sys.stderr)

    # B) content non-editable div, content-ctx 't'
    chrome_close(m); m.ctx("content")
    m.navigate("data:text/html,<body style='height:1500px'><div tabindex=0 id=d style='position:fixed;top:0;left:0'>x</div><script>onload=()=>d.focus()</script></body>")
    time.sleep(1.0); m.exe("document.getElementById('d').focus(); return document.activeElement.id;")
    m.ctx("chrome"); m.keys("t"); time.sleep(0.6)
    m.ctx("chrome"); b_open=m.exe(POPEN); b_st=m.exe(PSTATE)
    print(f"  B) content non-editable 't': open={b_open} {b_st}  (True => content keys reach chrome vim)", file=sys.stderr)

    # C) content textarea (editable), content-ctx 't' — must YIELD
    chrome_close(m); m.ctx("content")
    m.navigate("data:text/html,<body style='height:1500px'><textarea id=ta style='position:fixed;top:0;left:0'></textarea><script>onload=()=>ta.focus()</script></body>")
    time.sleep(1.2); m.exe("document.getElementById('ta').focus(); return document.activeElement.tagName;")
    m.ctx("chrome")
    pre_edit=m.exe("return gBrowser.selectedBrowser._gjoaEditable;")
    pre_active=m.exe("return document.activeElement && document.activeElement.tagName;")
    m.keys("t"); time.sleep(0.6)
    c_open=m.exe(POPEN); post_edit=m.exe("return gBrowser.selectedBrowser._gjoaEditable;")
    m.ctx("content"); focused=m.exe("return document.activeElement && document.activeElement.tagName;")
    val=m.exe("const t=document.getElementById('ta'); return t?t.value:'(gone)';")
    print(f"  C) textarea: preEdit={pre_edit} chromeActive={pre_active} || after 't': pickerOpen={c_open} postEdit={post_edit} contentFocused={focused} value={val!r}", file=sys.stderr)
    c_st=""

    # D) DYNAMIC MODAL — async create+focus a textarea, type immediately (the race)
    chrome_close(m); m.ctx("content")
    m.navigate("data:text/html,<body style='height:1500px'><button id=b style='position:fixed;top:0;left:0'>open</button><script>document.getElementById('b').addEventListener('click',()=>{setTimeout(()=>{const t=document.createElement('textarea');t.id='dyn';t.style='position:fixed;top:40px;left:0';document.body.appendChild(t);t.focus();},10);});</script></body>")
    time.sleep(0.8)
    # click the button (content-ctx pointer) then IMMEDIATELY type — focus lands async
    m.send("WebDriver:PerformActions",{"actions":[{"type":"pointer","id":"m","parameters":{"pointerType":"mouse"},"actions":[
        {"type":"pointerMove","duration":0,"x":20,"y":12},{"type":"pointerDown","button":0},{"type":"pointerUp","button":0}]}]})
    m.ctx("chrome"); m.keys("t"); time.sleep(0.6)
    m.ctx("content"); dval=m.exe("const t=document.getElementById('dyn'); return t?t.value:'(no textarea)';")
    m.ctx("chrome"); d_open=m.exe(POPEN); d_st=m.exe(PSTATE)
    print(f"  D) DYNAMIC modal click+immediate 't': open={d_open} (want False) {d_st}  dyn.value={dval!r}", file=sys.stderr)

    print("\n  SUMMARY:", file=sys.stderr)
    print(f"    harness fires vim: {a_open}", file=sys.stderr)
    print(f"    content keys reach vim: {b_open}", file=sys.stderr)
    print(f"    static textarea misfire: {c_open}  | dynamic-modal misfire: {d_open}", file=sys.stderr)
    m.quit(); sys.exit(0)

if __name__=="__main__": main()
