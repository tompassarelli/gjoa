#!/usr/bin/env python3
# Reproduce the janky teardown state: after a NON-escape dismiss (backdrop/deactivate),
# is the urlbar left FOCUSED + breakout-extend + popover-open (expanded top-sites at slot)?
import os, sys, time, json, socket, subprocess, shutil, signal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "test-driver"))
from importlib import import_module
cs = import_module("chrome-shoot")
OBJ=str(ROOT / "engine" / "obj-x86_64-pc-linux-gnu" / "dist" / "bin" / "gjoa")
GPROF=os.path.expanduser("~/.config/mozilla/gjoa/4859ptgk.default-default")
RT="/tmp/tdr-rt"; PROF="/tmp/tdr-prof"; PORT=3253
for d in (RT,PROF): shutil.rmtree(d,ignore_errors=True); os.makedirs(d)
os.chmod(RT,0o700)
subprocess.run(["rsync","-a","--exclude=cache2/","--exclude=startupCache/","--exclude=*.lock","--exclude=lock","--exclude=.parentlock",GPROF+"/",PROF+"/"],capture_output=True)
open(PROF+"/user.js","w").write('user_pref("marionette.port",%d);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\n'%PORT)
env=dict(os.environ,XDG_RUNTIME_DIR=RT,WLR_BACKENDS="headless",WLR_RENDERER="pixman",WLR_HEADLESS_OUTPUTS="1",GJOA_ALLOW_INSECURE="1",GJOA_DEV_LOADER="1")
p=subprocess.Popen(["nix","run","nixpkgs#cage","--","--",OBJ,"-no-remote","-profile",PROF,"-marionette","-remote-allow-system-access","about:blank"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
for _ in range(90):
    try: s=socket.create_connection(("127.0.0.1",PORT),timeout=1); s.close(); break
    except OSError:
        if p.poll() is not None: sys.exit("cage died")
        time.sleep(1)
time.sleep(2)
m=cs.Marionette(PORT); m.newsession(); m.ctx("chrome")
V=lambda r: r.get("value") if isinstance(r,dict) else r
m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;")
STATE=("const u=document.getElementById('urlbar');const a=document.activeElement;"
       "const foc=!!(a&&(a===u||u.contains(a)));const r=u.getBoundingClientRect();"
       "let vopen=false;try{vopen=!!(gURLBar&&gURLBar.view&&gURLBar.view.isOpen);}catch(e){}"
       "let pop=false;try{pop=u.matches(':popover-open');}catch(e){}"
       "return JSON.stringify({focused:foc,breakout:u.hasAttribute('breakout-extend'),"
       "floating:document.documentElement.hasAttribute('gjoa-urlbar-floating'),"
       "popoverOpen:pop,viewOpen:vopen,w:Math.round(r.width),top:Math.round(r.top),"
       "rows:document.querySelectorAll('.urlbarView-row').length});")
def shot(name):
    with open("/tmp/"+name,"wb") as f: f.write(__import__("base64").b64decode(m.shot(full=True)))

def trial(label, dismiss_js):
    # open palette + populate results
    m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));try{gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.4)
    m.exec_chrome("try{gURLBar.startQuery&&gURLBar.startQuery({allowAutofill:false});}catch(e){}return 1;"); time.sleep(0.5)
    m.exec_chrome(dismiss_js); time.sleep(0.6)
    st=json.loads(V(m.exec_chrome(STATE)))
    bad = st['popoverOpen'] and not st['floating']   # popover left open, not floating = janky
    bad2 = st['breakout'] and st['viewOpen']          # expanded-in-sidebar with results
    print("%-22s -> %s  BAD=%s" % (label, st, bad or bad2))
    return st, (bad or bad2)

# Escape (should be clean — returns focus to content)
s1,b1=trial("escape", "try{const el=gURLBar.inputField||gURLBar;el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true}));}catch(e){}return 1;")
# backdrop-style deactivate (suspected buggy — no focus return)
s2,b2=trial("deactivate(backdrop)", "document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));return 1;")
if b2: shot("teardown-bad-deactivate.png")
# deactivate while keeping focus on urlbar (forces the focused-breakout race)
m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));try{gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.4)
m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));try{gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.6)
s3=json.loads(V(m.exec_chrome(STATE))); b3=(s3['popoverOpen'] and not s3['floating']) or (s3['breakout'] and s3['viewOpen'])
print("%-22s -> %s  BAD=%s"%("deact+refocus", s3, b3))
if b3: shot("teardown-bad-refocus.png")
bad_any = b1 or b2 or b3
print('RESULT:', 'CLEAN' if not bad_any else 'JANKY-TEARDOWN DETECTED')
m.quit()
try: os.killpg(os.getpgid(p.pid),signal.SIGTERM)
except Exception: pass
