import os,sys,time,json,socket,subprocess,shutil,signal
sys.path.insert(0,"/home/tom/code/gjoa/tools/test-driver")
from importlib import import_module
cs=import_module("chrome-shoot")
OBJ="/home/tom/code/gjoa/engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"
GP=os.path.expanduser("~/.config/mozilla/gjoa/4859ptgk.default-default")
RT="/tmp/hrt-rt";PROF="/tmp/hrt-prof";PORT=3262
CSS="/home/tom/code/gjoa/src/gjoa/chrome/css/gjoa.uc.css"
for d in (RT,PROF): shutil.rmtree(d,ignore_errors=True); os.makedirs(d)
os.chmod(RT,0o700)
subprocess.run(["rsync","-a","--exclude=*.lock","--exclude=lock","--exclude=.parentlock",GP+"/",PROF+"/"],capture_output=True)
open(PROF+"/user.js","w").write('user_pref("marionette.port",%d);\nuser_pref("marionette.enabled",true);\n'%PORT)
env=dict(os.environ,XDG_RUNTIME_DIR=RT,WLR_BACKENDS="headless",WLR_RENDERER="pixman",WLR_HEADLESS_OUTPUTS="1",GJOA_ALLOW_INSECURE="1",GJOA_DEV_LOADER="1")
p=subprocess.Popen(["nix","run","nixpkgs#cage","--","--",OBJ,"-no-remote","-profile",PROF,"-marionette","-remote-allow-system-access","about:blank"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
for _ in range(90):
    try: s=socket.create_connection(("127.0.0.1",PORT),timeout=1);s.close();break
    except OSError:
        if p.poll() is not None: sys.exit("cage died")
        time.sleep(1)
time.sleep(2)
m=cs.Marionette(PORT); m.newsession(); m.ctx("chrome")
V=lambda r: r.get("value") if isinstance(r,dict) else r
m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;")
GET="return getComputedStyle(document.documentElement).getPropertyValue('--gjoa-hr-test')||'(unset)';"
print("BEFORE edit: --gjoa-hr-test =", V(m.exec_chrome(GET)))
# 1) edit CSS with a detectable marker
orig=open(CSS).read()
open(CSS,"w").write(orig + "\n:root{--gjoa-hr-test:42}\n")
# 2) recompile -> stamp changes
print("recompiling (chrome:dist)...")
subprocess.run(["bun","run","chrome:dist"],cwd="/home/tom/code/gjoa",capture_output=True)
# 3) poll the RUNNING browser for the new value (proves live hot-reload, no restart)
applied=None
t0=time.monotonic()
while time.monotonic()-t0<8:
    v=V(m.exec_chrome(GET))
    if v.strip()=="42": applied=round(time.monotonic()-t0,1); break
    time.sleep(0.4)
print("AFTER recompile: --gjoa-hr-test =", V(m.exec_chrome(GET)), "| live-applied in", applied, "s" if applied else "-> NOT APPLIED (hot-reload failed)")
# 4) verify drawer JS re-inited cleanly: Ctrl+L still works + settles clean, no dup state
m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));try{gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.5)
op=json.loads(V(m.exec_chrome("const u=document.getElementById('urlbar');return JSON.stringify({fl:document.documentElement.hasAttribute('gjoa-urlbar-floating'),ghosts:document.querySelectorAll('#gjoa-urlbar-ghost').length});")))
m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));return 1;"); time.sleep(0.6)
ex=json.loads(V(m.exec_chrome("const u=document.getElementById('urlbar');return JSON.stringify({fl:document.documentElement.hasAttribute('gjoa-urlbar-floating'),ghosts:document.querySelectorAll('#gjoa-urlbar-ghost').length,w:Math.round(u.getBoundingClientRect().width)});")))
print("post-reload urlbar works: open floating=%s ghosts=%d -> exit floating=%s ghosts=%d w=%d"%(op['fl'],op['ghosts'],ex['fl'],ex['ghosts'],ex['w']))
# 5) revert CSS
open(CSS,"w").write(orig)
subprocess.run(["bun","run","chrome:dist"],cwd="/home/tom/code/gjoa",capture_output=True)
m.quit()
try: os.killpg(os.getpgid(p.pid),signal.SIGTERM)
except Exception: pass
