#!/usr/bin/env python3
# FAITHFUL visual capture of the Ctrl+L command-palette DISMISS, on a REAL
# compositor window (stealth niri render — animations actually composite, unlike a
# hidden/headless window). Summons the palette, populates results, dismisses it two
# ways (Escape AND backdrop click), and rapid-fires screenshots through the teardown
# so the visual artifact is visible frame-by-frame. Saves esc-NN-*.png / bd-NN-*.png.
import argparse, base64, json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

ACTIVATE = "try{window.docShell.isActive=true;window.focus();return 'a';}catch(e){return 'e:'+e;}"
SUMMON = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
          "try{window.focus();gURLBar.focus();}catch(e){}"
          "return document.documentElement.hasAttribute('gjoa-urlbar-floating');")
STATE = (r"""
  const r=document.documentElement, u=document.getElementById('urlbar');
  const g=document.getElementById('gjoa-urlbar-ghost'), bd=document.getElementById('gjoa-urlbar-backdrop');
  const cs=u?getComputedStyle(u):null; const rc=u?u.getBoundingClientRect():null;
  let popoverOpen=null; try{ popoverOpen=u?u.matches(':popover-open'):null; }catch(e){}
  return JSON.stringify({
    floating:r.hasAttribute('gjoa-urlbar-floating'), teardown:r.hasAttribute('gjoa-urlbar-teardown'),
    urlbarOpacity: cs?+parseFloat(cs.opacity).toFixed(2):null,
    urlbarPos: cs?cs.position:null,
    urlbarRect: rc?[Math.round(rc.left),Math.round(rc.top),Math.round(rc.width)]:null,
    popoverAttr: u?u.getAttribute('popover'):null, popoverOpen,
    ghost: !!g, backdrop: !!bd,
    viewOpen: !!(window.gURLBar&&window.gURLBar.view&&window.gURLBar.view.isOpen),
  });
""")
ESCAPE = ("const u=document.getElementById('urlbar');"
          "u.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true,view:window}));return 'esc';")
BACKDROP = ("const b=document.getElementById('gjoa-urlbar-backdrop');"
            "if(b){b.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));return 'bd';}return 'no-bd';")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--settle-ms",type=int,default=5000); ap.add_argument("--outdir",default="/tmp/urlbar-td")
    a=ap.parse_args(); os.makedirs(a.outdir,exist_ok=True)
    m=cs.Marionette(a.port); m.newsession(); m.ctx("chrome"); time.sleep(a.settle_ms/1000.0)
    def _v(r): return r.get("value") if isinstance(r,dict) else r
    def st(): return json.loads(_v(m.exec_chrome(STATE)))
    def shot(n):
        try:
            with open(os.path.join(a.outdir,n),"wb") as f: f.write(base64.b64decode(m.shot(full=True)))
        except Exception as e: sys.stderr.write(f"shot {n}: {e}\n")

    def run(tag, dismiss_js):
        m.exec_chrome(ACTIVATE); m.exec_chrome(SUMMON); time.sleep(0.3)
        m.exec_chrome("try{window.focus();gURLBar.focus();gURLBar.value='news';gURLBar.startQuery({searchString:'news',allowAutofill:false});}catch(e){}")
        time.sleep(0.6); m.exec_chrome(ACTIVATE)
        out={"expanded":st()}; shot(f"{tag}-00-expanded.png")
        m.exec_chrome(dismiss_js)
        frames=[]
        for i in range(8):                # rapid-fire through the ~150ms teardown + past it
            s=st(); frames.append(s); shot(f"{tag}-{i+1:02d}.png")
        out["frames"]=frames
        time.sleep(0.8); out["after"]=st(); shot(f"{tag}-99-after.png")
        return out

    result={"escape":run("esc",ESCAPE)}
    time.sleep(1.0)
    result["backdrop"]=run("bd",BACKDROP)
    # REGRESSION CHECKS: after EVERY dismiss path, the palette must be fully torn
    # down — crucially the urlbar must NOT be left :popover-open (stuck in the top
    # layer over an empty sidebar slot = the "visual artifact on exit"). Also no
    # floating/ghost/backdrop residue and the view closed.
    checks={}
    for path in ("escape","backdrop"):
        a=result[path]["after"]
        checks[f"{path}_popover_closed"]= a.get("popoverOpen") is False
        checks[f"{path}_not_floating"]= a.get("floating") is False
        checks[f"{path}_view_closed"]= a.get("viewOpen") is False
        checks[f"{path}_ghost_gone"]= a.get("ghost") is False
        checks[f"{path}_backdrop_gone"]= a.get("backdrop") is False
        checks[f"{path}_urlbar_in_sidebar"]= (a.get("urlbarRect") or [999])[0] < 60
    result["checks"]=checks
    print(json.dumps(result,indent=1))
    m.quit()
    failed=[k for k,v in checks.items() if not v]
    if failed:
        sys.stderr.write("FAIL: "+", ".join(failed)+"\n"); sys.exit(1)
    sys.stderr.write("PASS: all dismiss paths tear down cleanly (no stuck popover)\n")

if __name__=="__main__": main()
