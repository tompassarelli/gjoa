#!/usr/bin/env python3
# Structural verification of the Ctrl+L command-palette DISMISS smoothness fix
# (2026-07-18). We can't get faithful PIXELS from a hidden-workspace window (its
# animations aren't composited), but getComputedStyle + event flags ARE reliable.
# Asserts the two concrete jank sources are gone:
#   (1) TEARDOWN uses PURE opacity fade, NO scale (scaling the tall results panel
#       re-rasterized its text -> blur = "artifact degradation").
#   (2) Escape is defaultPrevented by gjoa's capture handler, so FF's
#       UrlbarController (window-bubble) view.close() never fires — the results
#       don't snap shut before the fade. Palette stays floating + view stays open
#       right after Escape; teardown attr is set (fade engaged).
# Run via urlbar-teardown-drive.sh (real-GUI stealth render). Exits nonzero on fail.
import argparse, json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

ACTIVATE_WIN = "try{window.docShell.isActive=true;window.focus();return 'active';}catch(e){return 'e:'+e;}"
SUMMON = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
          "try{window.focus();gURLBar.focus();}catch(e){}"
          "return document.documentElement.hasAttribute('gjoa-urlbar-floating');")

# Open the results view so the "results must not snap" path is exercised.
OPEN_VIEW = r"""
  try {
    gURLBar.focus();
    gURLBar.value = 'news';
    gURLBar.startQuery({ searchString: 'news', allowAutofill: false });
    return 'query';
  } catch(e) { return 'openview-err:'+e; }
"""

# Dispatch a REAL Escape keydown from #urlbar. dispatchEvent returns false iff
# cancelable && preventDefault() was called — that's our "FF blocked" signal.
ESCAPE = r"""
  const u = document.getElementById('urlbar');
  const ev = new KeyboardEvent('keydown', {key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true, cancelable:true, view:window});
  const notPrevented = u.dispatchEvent(ev);
  return JSON.stringify({ defaultPrevented: !notPrevented });
"""

TEARDOWN_STYLE = r"""
  const u = document.getElementById('urlbar');
  const cs = getComputedStyle(u);
  return JSON.stringify({
    floating: document.documentElement.hasAttribute('gjoa-urlbar-floating'),
    teardown: document.documentElement.hasAttribute('gjoa-urlbar-teardown'),
    scale: cs.scale,
    opacity: +parseFloat(cs.opacity).toFixed(3),
    transition: cs.transitionProperty,
    viewOpen: !!(window.gURLBar && window.gURLBar.view && window.gURLBar.view.isOpen),
  });
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--settle-ms", type=int, default=5000)
    a = ap.parse_args()
    m = cs.Marionette(a.port)
    m.newsession(); m.ctx("chrome")
    time.sleep(a.settle_ms / 1000.0)
    def _val(r): return r.get("value") if isinstance(r, dict) else r

    out = {}
    m.exec_chrome(ACTIVATE_WIN)
    out["summon"] = _val(m.exec_chrome(SUMMON))
    time.sleep(0.2); m.exec_chrome(ACTIVATE_WIN)
    out["openView"] = _val(m.exec_chrome(OPEN_VIEW)); time.sleep(0.5)
    out["beforeEscape"] = json.loads(_val(m.exec_chrome(TEARDOWN_STYLE)))

    # Freeze the refresh driver so we can read the teardown transition mid-flight.
    m.exec_chrome("window.windowUtils.advanceTimeAndRefresh(0); return 'frozen';")
    out["escape"] = json.loads(_val(m.exec_chrome(ESCAPE)))
    out["t0"] = json.loads(_val(m.exec_chrome(TEARDOWN_STYLE)))          # fade just started
    m.exec_chrome("window.windowUtils.advanceTimeAndRefresh(65); return 'adv';")
    out["t65"] = json.loads(_val(m.exec_chrome(TEARDOWN_STYLE)))         # mid-fade
    m.exec_chrome("window.windowUtils.advanceTimeAndRefresh(80); return 'adv';")
    out["t145"] = json.loads(_val(m.exec_chrome(TEARDOWN_STYLE)))        # fade complete
    m.exec_chrome("try{window.windowUtils.restoreNormalRefresh();}catch(e){}")

    t0, t65, t145 = out["t0"], out["t65"], out["t145"]
    checks = {
        "escape_defaultPrevented (FF view.close blocked)": out["escape"]["defaultPrevented"] is True,
        "teardown_engaged": t0["teardown"] is True and t0["floating"] is True,
        "no_scale_on_teardown (blur fix)": t0["scale"] in ("none", "1", None) and t65["scale"] in ("none", "1", None),
        "opacity_fades_monotonically": (t0["opacity"] >= t65["opacity"] >= t145["opacity"]) and t145["opacity"] < 0.1,
        "transition_is_opacity_only": "opacity" in (t0["transition"] or "") and "scale" not in (t0["transition"] or ""),
    }
    out["checks"] = checks
    print(json.dumps(out, indent=2))
    m.quit()
    failed = [k for k, v in checks.items() if not v]
    if failed:
        sys.stderr.write("FAIL: " + " | ".join(failed) + "\n"); sys.exit(1)
    sys.stderr.write("PASS: smooth opacity-only dismiss, FF snap blocked\n")

if __name__ == "__main__":
    main()
