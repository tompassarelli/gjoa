#!/usr/bin/env python3
# End-to-end regression check for the "Collapse Layout" width bug (2026-07-18):
# collapsing the vertical sidebar must snap it to the ~56px favicon rail (labels
# hidden), NOT a ~140px half-width strip with tab labels still showing.
#
# Runs against a REAL-GUI gjoa (see collapse-gui-drive.sh — stealth niri render),
# drives the launcher toggle exactly as the sidebar-button command does, and
# measures #sidebar-main width + the icons-only state before/after. Exits nonzero
# if the collapsed sidebar is not a favicon rail. Companion fast test:
# tools/test-driver/functional/collapse-flags.functional.mjs (pure truth table).
import argparse, base64, json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

MEASURE_JS = r"""
  const sb = document.getElementById('sidebar-main');
  const panel = document.getElementById('gjoa-tab-panel');
  let label = document.querySelector('#gjoa-tab-panel .gjoa-tab-label') || document.querySelector('.gjoa-tab-label');
  const lr = label ? label.getBoundingClientRect() : null;
  return JSON.stringify({
    sidebarMainWidth: sb ? +sb.getBoundingClientRect().width.toFixed(1) : null,
    launcherExpandedAttr: sb ? sb.hasAttribute('sidebar-launcher-expanded') : null,
    panelIconsOnly: panel ? panel.hasAttribute('gjoa-icons-only') : null,
    docSidebarCollapsed: document.documentElement.hasAttribute('gjoa-sidebar-collapsed'),
    labelVisible: lr ? (lr.width > 1 && lr.height > 1) : null,
  });
"""

# Toggle the launcher exactly as the sidebar-button command does (what gjoa's
# "Collapse Layout" menu reaches via the native button).
COLLAPSE_JS = r"""
  const SC = window.SidebarController;
  if (SC && SC.handleToolbarButtonClick) { SC.handleToolbarButtonClick(); return 'handleToolbarButtonClick'; }
  if (SC) { try { SC._state.launcherExpanded = !SC._state.launcherExpanded; return 'controller-state'; } catch(e){} }
  return 'no-path';
"""

# A window on a hidden niri workspace can throttle rAF; mark the docShell active
# so the rAF-coalesced positionPanel fires (matches a real visible window).
ACTIVATE = "try{window.docShell.isActive=true;return 'active';}catch(e){return 'act-err:'+e;}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--settle-ms", type=int, default=5000)
    ap.add_argument("--outdir", default="/tmp/collapse-gui")
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    m = cs.Marionette(a.port)
    m.newsession(); m.ctx("chrome")
    time.sleep(a.settle_ms / 1000.0)

    def _val(r): return r.get("value") if isinstance(r, dict) else r
    def measure(): return json.loads(_val(m.exec_chrome(MEASURE_JS)))
    def save_shot(name):
        try:
            with open(os.path.join(a.outdir, name), "wb") as f:
                f.write(base64.b64decode(m.shot(full=True)))
        except Exception as e:
            sys.stderr.write(f"shot {name} failed: {e}\n")

    m.exec_chrome(ACTIVATE)
    out = {}
    out["expanded"] = measure(); save_shot("01-expanded.png")
    out["collapsePath"] = _val(m.exec_chrome(COLLAPSE_JS))
    m.exec_chrome(ACTIVATE); time.sleep(3.0)
    out["afterCollapse"] = measure(); save_shot("02-collapsed.png")
    m.exec_chrome(COLLAPSE_JS); m.exec_chrome(ACTIVATE); time.sleep(3.0)
    out["afterReexpand"] = measure(); save_shot("03-reexpanded.png")

    exp, col, re = out["expanded"], out["afterCollapse"], out["afterReexpand"]
    checks = {
        "collapsed_is_favicon_rail": (col["sidebarMainWidth"] is not None and col["sidebarMainWidth"] < 90),
        "collapsed_icons_only_set": col["panelIconsOnly"] is True,
        "collapsed_labels_hidden": col["labelVisible"] in (False, None),
        "expanded_shows_labels": exp["labelVisible"] is True and exp["sidebarMainWidth"] > 150,
        "reexpand_restores_width": re["sidebarMainWidth"] is not None and re["sidebarMainWidth"] > 150,
    }
    out["checks"] = checks
    print(json.dumps(out, indent=2))
    m.quit()
    failed = [k for k, v in checks.items() if not v]
    if failed:
        sys.stderr.write("FAIL: " + ", ".join(failed) + "\n")
        sys.exit(1)
    sys.stderr.write("PASS: collapse -> favicon rail\n")

if __name__ == "__main__":
    main()
