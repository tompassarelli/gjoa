#!/usr/bin/env python3
# Capture the FULL Ctrl+L exit sequence on a real compositor: palette open (ghost
# holding the slot) -> dismiss -> teardown frames -> settled. The floating palette
# is top-layer (not captured), but the SIDEBAR is — so this proves the exit is
# clean sidebar-side: the frozen ghost renders, then hands back to the real resting
# urlbar with no empty-slot flash / stuck box / spilled text.
import argparse, base64, json, time, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,required=True)
    ap.add_argument("--settle-ms",type=int,default=5000); ap.add_argument("--outdir",default="/tmp/urlbar-exit")
    a=ap.parse_args(); os.makedirs(a.outdir,exist_ok=True)
    m=cs.Marionette(a.port); m.newsession(); m.ctx("chrome"); time.sleep(a.settle_ms/1000)
    def V(r): return r.get("value") if isinstance(r,dict) else r
    def shot(n):
        with open(os.path.join(a.outdir,n),"wb") as f: f.write(base64.b64decode(m.shot(full=True)))
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;")
    # open (ghost created same-exec) — grab ghost state + shot
    st=V(m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
        "const g=document.getElementById('gjoa-urlbar-ghost');const r=g?g.getBoundingClientRect():null;const tx=g?g.lastElementChild:null;"
        "return JSON.stringify({ghost:!!g,txt:tx?tx.textContent:null,masked:g?getComputedStyle(g.firstElementChild).maskImage!=='none':null});"))
    shot("1-open.png")
    # dismiss + rapid frames through the ~150ms teardown
    m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));return 1;")
    for i in range(4): shot(f"2-tear-{i}.png")
    time.sleep(0.4); shot("3-settled.png")
    settled=V(m.exec_chrome("const u=document.getElementById('urlbar');const g=document.getElementById('gjoa-urlbar-ghost');"
        "return JSON.stringify({ghostGone:!g,popoverOpen:u.matches(':popover-open'),floating:document.documentElement.hasAttribute('gjoa-urlbar-floating')});"))
    print("open:",st); print("settled:",settled); m.quit()

if __name__=="__main__": main()
