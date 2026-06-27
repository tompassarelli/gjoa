#!/usr/bin/env python3
"""Machine-test the vim gate IN-PROCESS (Firefox's own approach): focus a content
element via marionette, then dispatch a real keydown to the CHROME document (the
same mechanism the flaky-test fix already uses to close the picker — it provably
fires gjoa's keydown handler). The gate reads _gjoaEditable (set by the content
actor on focus) and decides. No Xvfb, no xdotool, no window-focus — deterministic.

Tests: non-editable -> picker fires; editable -> yields; and the RACE (dispatch
immediately after focus, before the actor's async report settles).
"""
import argparse, json, socket, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TA_HTML=(b"<!DOCTYPE html><body style='height:1500px'>"
         b"<textarea id=t style='position:fixed;top:0;left:0'></textarea>"
         b"<script>onload=()=>document.getElementById('t').focus()</script></body>")
def start_http():
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type","text/html")
            self.send_header("Content-Length",str(len(TA_HTML))); self.end_headers()
            self.wfile.write(TA_HTML)
        def log_message(self,*a): pass
    srv=ThreadingHTTPServer(("127.0.0.1",0),H)
    threading.Thread(target=srv.serve_forever,daemon=True).start()
    return srv.server_address[1]

class M:
    def __init__(self, port, host="127.0.0.1", timeout=90):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=5); self.s.settimeout(120); break
            except OSError as e: last=e; time.sleep(0.3)
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
    def navigate(self,url): return self.send("WebDriver:Navigate",{"url":url})
    def exe(self,s,t=30000):
        r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
        return r.get("value") if isinstance(r,dict) else r
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

POPEN=("const p=document.getElementById('gjoa-picker');"
       "return !!(p && !p.hidden && p.querySelector('.gjoa-picker-input'));")
HIDE=("const p=document.getElementById('gjoa-picker'); if(p){p.hidden=true;"
      "p.querySelectorAll('.gjoa-picker-input').forEach(e=>e.remove());} return 1;")
DISPATCH=("document.dispatchEvent(new KeyboardEvent('keydown',"
          "{key:'t',code:'KeyT',keyCode:84,which:84,bubbles:true,cancelable:true})); return 1;")
EDIT="return gBrowser.selectedBrowser._gjoaEditable===true;"

def case(m, html, settle):
    m.ctx("chrome"); m.exe(HIDE)
    m.ctx("content"); m.navigate("data:text/html,"+html)
    time.sleep(settle)
    m.exe("const e=document.querySelector('#t,textarea,input,div[tabindex]'); if(e)e.focus(); return 1;")
    if settle>0: time.sleep(settle)
    m.ctx("chrome"); ed=m.exe(EDIT)
    m.exe(DISPATCH); time.sleep(0.3)
    return m.exe(POPEN), ed

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,default=2828); a=ap.parse_args()
    m=M(a.port); m.newsession(); m.ctx("chrome")
    for _ in range(120):
        if m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
        time.sleep(0.25)
    m.exe("Services.prefs.setBoolPref('gjoa.keys.useLeader',false); return 1;")

    DIV="<body style='height:1500px'><div tabindex=0 id=t style='position:fixed;top:0;left:0'>x</div><script>onload=()=>t.focus()</script></body>"
    TA="<body style='height:1500px'><textarea id=t style='position:fixed;top:0;left:0'></textarea><script>onload=()=>t.focus()</script></body>"

    fails=[]
    # baseline: dispatched key fires the handler at all (non-editable -> picker)
    p,ed=case(m, DIV, 1.0)
    print(f"  (A) non-editable div, settled: picker={p} (want True) _gjoaEditable={ed}", file=sys.stderr)
    if not p: fails.append("dispatched key does NOT fire gjoa's handler (harness broken)")
    # editable settled -> must yield
    p,ed=case(m, TA, 1.0)
    print(f"  (B) textarea, settled: picker={p} (want False) _gjoaEditable={ed}", file=sys.stderr)
    if p: fails.append("textarea SETTLED misfire: vim fired while a field was focused")
    # editable, RACE: dispatch immediately after focus (no settle)
    p,ed=case(m, TA, 0.0)
    print(f"  (C) textarea, RACE (no settle): picker={p} (want False) _gjoaEditable={ed}", file=sys.stderr)
    if p: fails.append("textarea RACE misfire: vim fired before _gjoaEditable settled (the real bug)")

    # (D) DETERMINISTIC RACE — textarea really focused, but force the flag stale
    # (exactly the IPC-lag window: editable IS focused, flag hasn't caught up).
    m.ctx("chrome"); m.exe(HIDE)
    m.ctx("content"); m.navigate("data:text/html,"+TA); time.sleep(1.0)
    m.exe("document.getElementById('t').focus(); return 1;")
    m.ctx("chrome")
    m.exe("gBrowser.selectedBrowser._gjoaEditable=false; return 1;")  # simulate stale flag
    m.exe(DISPATCH); time.sleep(0.3)
    pd=m.exe(POPEN)
    print(f"  (D) same-process textarea + FORCED stale flag: picker={pd}  (False = sync read wins, no race here)", file=sys.stderr)

    # (E/F) REMOTE page (real content process -> contentDocument null -> the ASYNC
    # _gjoaEditable path, exactly like Reddit). This is where the race lives.
    hp=start_http()
    m.ctx("chrome"); m.exe(HIDE)
    m.ctx("content"); m.navigate(f"http://127.0.0.1:{hp}/"); time.sleep(1.3)
    m.exe("document.getElementById('t').focus(); return 1;"); time.sleep(0.6)
    m.ctx("chrome")
    cd_null=m.exe("return gBrowser.selectedBrowser.contentDocument===null;")
    print(f"  (E0) remote contentDocument===null (true OOP, uses async _gjoaEditable)? {cd_null}", file=sys.stderr)
    ed=m.exe(EDIT)
    m.exe(DISPATCH); time.sleep(0.3); pe=m.exe(POPEN)
    print(f"  (E) REMOTE textarea, settled: _gjoaEditable={ed} (want True)  dispatch picker={pe} (want False)", file=sys.stderr)
    if not ed: fails.append("REMOTE: actor never reported editable for a focused textarea (detection gap)")
    if pe: fails.append("REMOTE textarea settled misfire")
    m.exe(HIDE); m.exe("gBrowser.selectedBrowser._gjoaEditable=false; return 1;")  # the race window
    m.exe(DISPATCH); time.sleep(0.3); pf=m.exe(POPEN)
    print(f"  (F) REMOTE + FORCED stale flag: picker={pf}  (True = gate misfires on stale flag = THE RACE)", file=sys.stderr)
    if pf: fails.append("REMOTE race CONFIRMED: gate fires when _gjoaEditable is stale-false on a remote page")

    print(("  RESULT: PASS — gate fires correctly, no misfire" if not fails
           else "  RESULT: "+"; ".join(fails)), file=sys.stderr)
    m.quit(); sys.exit(0 if not fails else 2)

if __name__=="__main__": main()
