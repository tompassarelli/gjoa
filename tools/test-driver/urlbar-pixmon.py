#!/usr/bin/env python3
# urlbar-pixmon.py — PIXEL-level frame monitor for the Ctrl+L palette open/close animation.
#
# The palette is a top-layer popover in browser CHROME: Playwright/WebDriver can't see it,
# and a niri hidden-workspace window isn't composited (so no rAF / no rendered opacity).
# This runs gjoa inside a HEADLESS cage compositor (real offscreen render, software pixman)
# so grim captures true pixels AND computed opacity/geometry are live — without touching the
# owner's screen. It then asserts the owner's invariant: during despawn nothing extra spawns
# and the bar never restores its resting geometry WHILE STILL VISIBLE (the "retraction
# through the tab row after Enter" — a fixed 150ms teardown timer racing a nav-delayed fade;
# fixed by gating finish-teardown on the opacity transitionend, urlbar.bjs #150).
#
#   python3 tools/test-driver/urlbar-pixmon.py [--grim]     # needs `nix run nixpkgs#cage` + grim
#
# Exit 0 = clean; 1 = a visible-retraction frame (bar visible with retracted geometry).
import argparse, json, os, shutil, signal, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OBJ = os.path.join(REPO, "engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa")
RT = "/tmp/urlbar-pixmon-rt"; PROF = "/tmp/urlbar-pixmon-prof"; PORT = 3220

SAMPLE = ("const u=document.getElementById('urlbar');const c=getComputedStyle(u);"
          "const r=u.getBoundingClientRect();const R=document.documentElement;"
          "return JSON.stringify({op:parseFloat(c.opacity),w:Math.round(r.width),top:Math.round(r.top),"
          "float:R.hasAttribute('gjoa-urlbar-floating'),tear:R.hasAttribute('gjoa-urlbar-teardown'),"
          "snap:R.hasAttribute('gjoa-urlbar-snap'),ghosts:document.querySelectorAll('#gjoa-urlbar-ghost').length});")
ACT = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
       "try{gURLBar.focus();}catch(e){}return 1;")
TYPE = ("try{gURLBar.value='youtube.com';gURLBar.dispatchEvent(new Event('input',{bubbles:true}));"
        "if(gURLBar.startQuery)gURLBar.startQuery({allowAutofill:false,searchString:'youtube.com'});}catch(e){}return 1;")
DEACT = "document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));return 1;"


def launch():
    for d in (RT, PROF):
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    os.chmod(RT, 0o700)
    with open(os.path.join(PROF, "user.js"), "w") as f:
        f.write('user_pref("marionette.port",%d);\nuser_pref("marionette.enabled",true);\n'
                'user_pref("browser.sessionstore.resume_from_crash",false);\n' % PORT)
    env = dict(os.environ, XDG_RUNTIME_DIR=RT, WLR_BACKENDS="headless", WLR_RENDERER="pixman",
               WLR_HEADLESS_OUTPUTS="1", GJOA_ALLOW_INSECURE="1", GJOA_DEV_LOADER="1")
    p = subprocess.Popen(
        ["nix", "run", "nixpkgs#cage", "--", "--", OBJ, "-no-remote", "-profile", PROF,
         "-marionette", "-remote-allow-system-access", "about:blank"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(90):
        try:
            s = socket.create_connection(("127.0.0.1", PORT), timeout=1); s.close(); time.sleep(1.5); return p
        except OSError:
            if p.poll() is not None:
                raise RuntimeError("cage/gjoa exited rc=%s" % p.returncode)
            time.sleep(1)
    raise RuntimeError("marionette %d never came up" % PORT)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--keep", action="store_true"); a = ap.parse_args()
    if not os.path.exists(OBJ):
        print("obj binary missing (build the dev binary first):", OBJ); sys.exit(2)
    proc = launch()
    m = cs.Marionette(PORT); m.newsession(); m.ctx("chrome")
    V = lambda r: r.get("value") if isinstance(r, dict) else r
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;")

    def measure(name, pre):
        for delay, script in pre:
            m.exec_chrome(script); time.sleep(delay)
        floatW = json.loads(V(m.exec_chrome(SAMPLE)))["w"]
        m.exec_chrome(DEACT)
        samples, t0 = [], time.monotonic()
        while time.monotonic() - t0 < 0.9:
            s = json.loads(V(m.exec_chrome(SAMPLE))); s["t"] = int((time.monotonic() - t0) * 1000)
            samples.append(s)
        # visible-retraction: bar still painting (op>0.05) but geometry already reverted
        # (width shrunk >10% below floating, or lifted toward the resting slot) — i.e. the
        # resting-geometry restore is being PAINTED instead of hidden behind opacity:0.
        retract = [s for s in samples if s["op"] > 0.05 and (s["w"] < 0.9 * floatW and s["top"] > 120)]
        # also: settled clean (last 150ms) — resting bar, no ghost, no floating/teardown/snap
        tail = [s for s in samples if s["t"] >= samples[-1]["t"] - 150]
        unsettled = [s for s in tail if s["float"] or s["tear"] or s["snap"] or s["ghosts"]]
        print("\n=== %s: %d samples, floatW=%d ===" % (name, len(samples), floatW))
        print("  visible-retraction frames:", len(retract))
        for s in retract[:5]:
            print("    ✗ op=%.2f w=%d top=%d @%dms" % (s["op"], s["w"], s["top"], s["t"]))
        print("  settled clean:", "yes" if not unsettled else "NO (%d unsettled tail frames)" % len(unsettled))
        return len(retract) + len(unsettled)

    fails = 0
    fails += measure("enter", [(0.4, ACT), (0.6, TYPE)])   # the reported nav-teardown path
    m.exec_chrome(ACT); time.sleep(0.5); m.exec_chrome(DEACT); time.sleep(0.6)
    fails += measure("reopen-enter", [(0.4, ACT), (0.6, TYPE)])  # re-summon then close (race guard)

    if not a.keep:
        try: m.quit()
        except Exception: pass
        try: os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception: pass
    print("\n%s — %d violation(s)" % ("CLEAN" if not fails else "ARTIFACT", fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
