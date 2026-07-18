#!/usr/bin/env python3
# Measure the Ctrl+L palette width on a FRESH summon vs a POST-DISMISS re-summon,
# to catch the "palette not expanding to full width" regression. The floating
# palette must break OUT of the narrow sidebar (top-layer popover) to
# min(860, innerWidth-40); if the popover isn't re-established after a dismiss it
# stays constrained to the sidebar column.
import argparse, json, time, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

MEAS = r"""
  const u=document.getElementById('urlbar'); const rc=u.getBoundingClientRect();
  const g=document.getElementById('gjoa-urlbar-ghost');
  const gInput = g ? g.querySelector('input,.urlbar-input,[anonid=input],moz-input-box') : null;
  const gIdentity = g ? g.querySelector('[class*=identity],[class*=tracking-protection],.urlbar-input-box>*, image, .toolbarbutton-icon') : null;
  return JSON.stringify({iw:window.innerWidth, expectW:Math.min(860,window.innerWidth-40),
    urlbarW:Math.round(rc.width), urlbarLeft:Math.round(rc.left),
    popoverOpen:u.matches(':popover-open'),
    floating:document.documentElement.hasAttribute('gjoa-urlbar-floating'),
    ghost: !!g,
    ghostChildCount: g ? g.querySelectorAll('*').length : 0,
    ghostHasInput: !!gInput,
    ghostPlaceholder: gInput ? (gInput.getAttribute('placeholder')||gInput.placeholder||null) : null,
    ghostHasIdentity: !!gIdentity});
"""
SUMMON = "document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));try{window.focus();gURLBar.focus();}catch(e){} return 'ok';"
DISMISS = "document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate')); return 'ok';"

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--port",type=int,required=True); ap.add_argument("--settle-ms",type=int,default=5000)
    a=ap.parse_args(); m=cs.Marionette(a.port); m.newsession()
    try: m.send("WebDriver:SetWindowRect",{"x":0,"y":0,"width":1400,"height":900})
    except Exception: pass
    m.ctx("chrome"); time.sleep(a.settle_ms/1000.0)
    def V(r): return r.get("value") if isinstance(r,dict) else r
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){} return 1;")
    def summon():
        m.exec_chrome(SUMMON); time.sleep(0.3); m.exec_chrome("try{window.focus();gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.2)
        return json.loads(V(m.exec_chrome(MEAS)))
    out={"fresh":summon()}
    m.exec_chrome(DISMISS); time.sleep(0.5)
    out["post_dismiss"]=summon()
    exp=out["fresh"]["expectW"]
    f, p = out["fresh"], out["post_dismiss"]
    # >=90% of the min(860, 100vw-40) target — catches a palette stuck at the narrow
    # sidebar column width (~40%) while tolerating the ~20px box-model delta.
    out["checks"]={
      "fresh_full_width": f["urlbarW"] >= 0.90*exp,
      "fresh_popover": f["popoverOpen"] is True,
      "resummon_full_width": p["urlbarW"] >= 0.90*exp,      # regression: re-summon must also expand
      "resummon_popover": p["popoverOpen"] is True,
      "ghost_frozen_urlbar": f["ghost"] is True and f["ghostHasInput"] is True and f["ghostHasIdentity"] is True,
      "ghost_shows_placeholder": bool(f["ghostPlaceholder"]),
    }
    print(json.dumps(out,indent=1)); m.quit()
    bad=[k for k,v in out["checks"].items() if not v]
    if bad: sys.stderr.write("FAIL: "+", ".join(bad)+"\n"); sys.exit(1)
    sys.stderr.write("PASS: palette expands to full width, fresh + re-summon\n")

if __name__=="__main__": main()
