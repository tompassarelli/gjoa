#!/usr/bin/env python3
"""Machine-test harness for gjoa's REAL keyboard/focus behavior.

marionette's synthetic content keys never reach the chrome vim handler (proven
headless AND headful — a marionette limitation). The only machine-driven path that
produces TRUSTED keystrokes routing content->chrome exactly like a human is OS-level
injection. So: Xvfb (virtual display) + openbox (so a window holds X focus) + the
mach dev binary headful + xdotool XTEST (real key events) + marionette only for
setup/inspection. No human, fully deterministic.

Run inside: nix shell nixpkgs#xvfb nixpkgs#xdotool nixpkgs#openbox -c \
  python3 tools/test-driver/realkey-harness.py
Exit 0 = all scenarios passed.
"""
import subprocess, socket, json, time, os, sys, signal, tempfile, shutil

SPECIAL = {"Escape": chr(0xE00C)}

class M:
    def __init__(self, port, host="127.0.0.1", timeout=60):
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection((host,port),timeout=5); self.s.settimeout(120); break
            except OSError as e: last=e; time.sleep(0.3)
        else: raise SystemExit(f"connect {host}:{port} failed: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf:
            c=self.s.recv(65536)
            if not c: raise SystemExit("socket closed")
            self.buf+=c
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need:
            c=self.s.recv(65536)
            if not c: raise SystemExit("socket closed")
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

def free_display():
    for n in range(90, 99):
        if not os.path.exists(f"/tmp/.X11-unix/X{n}"): return n
    return 99

def wait_port(port, timeout=70):
    dl=time.time()+timeout
    while time.time()<dl:
        try: s=socket.create_connection(("127.0.0.1",port),timeout=2); s.close(); return True
        except OSError: time.sleep(0.3)
    return False

POPEN=("const p=document.getElementById('gjoa-picker');"
       "return !!(p && !p.hidden && p.querySelector('.gjoa-picker-input'));")

class Harness:
    def __init__(self):
        self.disp=free_display(); self.port=2860; self.procs=[]; self.prof=tempfile.mkdtemp()
        self.env=dict(os.environ, DISPLAY=f":{self.disp}"); self.env.pop("MOZ_HEADLESS",None)
        self.wid=None
    def _spawn(self,cmd,log=None):
        p=subprocess.Popen(cmd,env=self.env,stdout=(open(log,"w") if log else subprocess.DEVNULL),
            stderr=subprocess.STDOUT,start_new_session=True); self.procs.append(p); return p
    def start(self):
        self._spawn(["Xvfb",f":{self.disp}","-screen","0","1600x1000x24","-nolisten","tcp"]); time.sleep(2.0)
        self._spawn(["openbox"]); time.sleep(1.0)
        open(os.path.join(self.prof,"user.js"),"w").write(
            f'user_pref("marionette.port",{self.port});\nuser_pref("marionette.enabled",true);\n'
            'user_pref("browser.shell.checkDefaultBrowser",false);\n')
        self._spawn([os.path.expanduser("~/.local/bin/gjoa"),"dev","-f","-profile",self.prof,
            "-marionette","-remote-allow-system-access"], log="/tmp/rk-gjoa.log")
        if not wait_port(self.port,75): raise SystemExit("marionette port never opened — see /tmp/rk-gjoa.log")
        self.m=M(self.port); self.m.newsession(); self.m.ctx("chrome")
        for _ in range(160):
            if self.m.exe("return !!(window.gBrowser && document.getElementById('gjoa-tab-panel'));"): break
            time.sleep(0.25)
        self.m.exe("Services.prefs.setBoolPref('gjoa.keys.useLeader',false); return 1;")
        self._find_window()
    def _xdo(self,*args):
        return subprocess.run(["xdotool",*args],env=self.env,capture_output=True,text=True,timeout=10).stdout.strip()
    def _win_area(self,wid):
        geo=self._xdo("getwindowgeometry","--shell",wid); w=h=0
        for ln in geo.split("\n"):
            if ln.startswith("WIDTH="): w=int(ln[6:] or 0)
            elif ln.startswith("HEIGHT="): h=int(ln[7:] or 0)
        return w,h
    def _find_window(self):
        # title/class are unreliable here (empty title early; --onlyvisible fails on
        # Xvfb). Use the active window openbox focused on map, else the largest window.
        wid=self._xdo("getactivewindow")
        if wid and wid.isdigit():
            try:
                w,h=self._win_area(wid)
                if w>500 and h>500: self.wid=wid; return
            except Exception: pass
        cand=set()
        for sel in (["--name",""],["--class","Navigator"],["--class","gjoa"],
                    ["--class","firefox"],["--class","Firefox"],["--class","Toolkit"]):
            out=self._xdo("search","--maxdepth","8",*sel)
            cand.update(x.strip() for x in out.split("\n") if x.strip())
        best=None; barea=0
        for wid in cand:
            try: w,h=self._win_area(wid)
            except Exception: continue
            if w>500 and h>500 and w*h>barea: barea=w*h; best=wid
        self.wid=best
    def _ensure_focus(self):
        # Firefox ignores input unless its window has focus. windowactivate --sync
        # (openbox honors it) + raise + focus; then verify via getactivewindow.
        if not self.wid: self._find_window()
        if self.wid:
            self._xdo("windowactivate","--sync",self.wid)
            self._xdo("windowraise",self.wid)
            self._xdo("windowfocus",self.wid)
        time.sleep(0.3)
        return self._xdo("getactivewindow")
    def realkey(self,ch):
        # XTEST (real keyboard): NO --window, so xdotool injects to the focused window.
        a=self._ensure_focus(); self._xdo("key",ch); time.sleep(0.5); return a
    def realkey_type(self,s):
        a=self._ensure_focus(); self._xdo("type","--clearmodifiers",s); time.sleep(0.5); return a
    def hide_picker(self):
        self.m.ctx("chrome")
        self.m.exe("const p=document.getElementById('gjoa-picker'); if(p)p.hidden=true; "
                   "try{const a=document.activeElement; if(a&&a.blur)a.blur();}catch(e){} return 1;")
    def focus_content(self,html):
        self.m.ctx("content")
        self.m.navigate("data:text/html,"+html); time.sleep(1.0)
        return self.m.exe("const e=document.querySelector('[autofocus],#t,#d,textarea,input'); if(e)e.focus(); "
                          "return document.activeElement && document.activeElement.tagName;")
    def picker_open(self):
        self.m.ctx("chrome"); return bool(self.m.exe(POPEN))
    def stop(self):
        try: self.m.quit()
        except Exception: pass
        for p in self.procs:
            try: os.killpg(os.getpgid(p.pid),signal.SIGTERM)
            except Exception: pass
        time.sleep(0.5)
        for p in self.procs:
            try: os.killpg(os.getpgid(p.pid),signal.SIGKILL)
            except Exception: pass
        shutil.rmtree(self.prof,ignore_errors=True)

def main():
    h=Harness(); fails=[]
    try:
        h.start()
        print(f"  harness up: DISPLAY=:{h.disp} window={h.wid}", file=sys.stderr)

        # (0) ISOLATION — can xdotool reach gjoa AT ALL? Type into the chrome urlbar.
        h.m.ctx("chrome")
        h.m.exe("try{gURLBar.focus(); gURLBar.value='';}catch(e){} return 1;")
        active=h.realkey_type("zq")
        uval=h.m.exe("try{return gURLBar.value;}catch(e){return 'ERR';}")
        print(f"  (0) xdotool type into urlbar -> value={uval!r} (want 'zq')  activeWin={active}", file=sys.stderr)
        if uval!="zq":
            fails.append(f"xdotool keys do NOT reach gjoa at all (urlbar value={uval!r}) — focus/window problem")

        # (1) BASELINE — non-editable div focused, real 't' MUST open the picker.
        #     Proves real OS keys route content->chrome. If this fails the harness
        #     can't inject keys and nothing else is meaningful.
        h.hide_picker()
        h.focus_content("<body style='height:1500px'><div tabindex=0 id=d style='position:fixed;top:0;left:0'>x</div><script>onload=()=>d.focus()</script></body>")
        h.realkey("t")
        base=h.picker_open()
        print(f"  (1) non-editable div + REAL 't': pickerOpen={base}  (MUST be True)", file=sys.stderr)
        if not base: fails.append("baseline: real keys did not reach chrome vim handler")

        # (2) MISFIRE TEST — textarea focused, real 't' must YIELD (no picker, types).
        if base:
            h.hide_picker()
            h.focus_content("<body style='height:1500px'><textarea id=t style='position:fixed;top:0;left:0'></textarea><script>onload=()=>t.focus()</script></body>")
            h.realkey("t")
            mis=h.picker_open()
            h.m.ctx("content"); val=h.m.exe("return (document.getElementById('t')||{}).value;")
            print(f"  (2) textarea + REAL 't': pickerOpen={mis} (want False)  value={val!r} (want 't')", file=sys.stderr)
            if mis: fails.append("textarea MISFIRE: vim fired while typing in a field")
            if val!="t": fails.append(f"textarea did not receive the char (value={val!r})")
    finally:
        h.stop()
    print(("  RESULT: PASS — real-key harness works + vim yields to fields" if not fails
           else "  RESULT: FAIL\n    - "+"\n    - ".join(fails)), file=sys.stderr)
    sys.exit(0 if not fails else 2)

if __name__=="__main__": main()
