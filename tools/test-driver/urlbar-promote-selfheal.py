#!/usr/bin/env python3
# Regression gate for the Ctrl+L "palette cut off / clipped under content" bug
# (owner 2026-07-20: correctly diagnosed as a state-management failure, NOT a
# compositor bug).
#
#   python3 tools/test-driver/urlbar-promote-selfheal.py [--bin PATH]
#
# The palette escapes the sidebar's (in compact mode, transformed → own stacking
# context) clip ONLY by being a manual popover in the TOP LAYER. The `popover` attr
# has multiple writers (compact.bjs's observer, activate-floating, teardown), so it
# can be pulled out from under the `activated` flag. When that happens the palette
# falls out of the top layer and is positioned by its containing block (the sidebar)
# → clipped under the page content — the owner's screenshot.
#
# This drives the exact desync: activate (top layer, centered) → a competing writer
# pulls `popover` → re-activate. Before the fix, re-activate left it out of the top
# layer (urlbar.left snapped to its containing-block edge). After the fix,
# activate-floating self-heals via ensure-floating-promoted, so a re-summon always
# lands back in the top layer.
#
# Exit 0 = re-summon re-promotes to the top layer; exit 1 = regressed (desync sticks).
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
import importlib.util
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
spec = importlib.util.spec_from_file_location("probe", os.path.join(REPO, "tools/test-driver/urlbar-float-realpage-probe.py"))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
cs = import_module("chrome-shoot")

ACT = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
       "try{window.focus();gURLBar.focus();}catch(e){}return 1;")
STATE = ("const u=document.getElementById('urlbar');const r=u.getBoundingClientRect();"
         "return JSON.stringify({popoverOpen:u.matches(':popover-open'),"
         "floating:document.documentElement.hasAttribute('gjoa-urlbar-floating'),"
         "left:Math.round(r.left),width:Math.round(r.width)});")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(REPO, "engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"))
    ap.add_argument("--port", type=int, default=3375)
    a = ap.parse_args()
    binp = a.bin if os.path.exists(a.bin) else os.path.join(REPO, "result/bin/gjoa")
    proc = probe.launch_cage(binp, a.port, "/tmp/urlbar-selfheal-prof")
    m = cs.Marionette(a.port); m.newsession(); V = lambda r: r.get("value") if isinstance(r, dict) else r
    m.ctx("content"); m.send("WebDriver:Navigate", {"url": "https://en.wikipedia.org/wiki/Main_Page"}); time.sleep(5)
    m.ctx("chrome"); m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;"); time.sleep(0.5)
    st = lambda: json.loads(V(m.exec_chrome(STATE)))
    m.exec_chrome(ACT); time.sleep(0.5); fresh = st()
    # a competing writer pulls the popover (exactly what compact.bjs's rmattr does)
    m.exec_chrome("document.getElementById('urlbar').removeAttribute('popover');return 1;"); time.sleep(0.2); pulled = st()
    m.exec_chrome(ACT); time.sleep(0.5); healed = st()
    print(json.dumps({"fresh": fresh, "popover_pulled": pulled, "reactivate": healed}, indent=1))
    m.quit()
    try: proc.terminate()
    except Exception: pass
    print("\n--- VERDICT ---", file=sys.stderr)
    print("fresh: popover=%s left=%s | pulled: popover=%s left=%s | reactivate: popover=%s left=%s"
          % (fresh["popoverOpen"], fresh["left"], pulled["popoverOpen"], pulled["left"],
             healed["popoverOpen"], healed["left"]), file=sys.stderr)
    if not fresh["popoverOpen"]:
        print("FAIL: fresh activate did not promote to the top layer.", file=sys.stderr); sys.exit(1)
    if not healed["popoverOpen"]:
        print("FAIL: re-summon left the palette OUT of the top layer (desync sticks → clipped under content).", file=sys.stderr); sys.exit(1)
    # re-promoted geometry must match the fresh centered geometry (back in the top layer)
    if abs(healed["left"] - fresh["left"]) > 4:
        print("FAIL: re-summon geometry (left=%s) != fresh centered (left=%s) — not truly re-promoted."
              % (healed["left"], fresh["left"]), file=sys.stderr); sys.exit(1)
    print("PASS: activate self-heals — a re-summon always re-promotes the palette to the top layer.", file=sys.stderr)


if __name__ == "__main__":
    main()
