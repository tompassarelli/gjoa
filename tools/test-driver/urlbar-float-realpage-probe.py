#!/usr/bin/env python3
# Reproduce the 2026-07-19 regression: on a REAL (loaded) page, Ctrl+L expands the
# urlbar IN the sidebar (breakout-extend) instead of the centered floating palette —
# i.e. activate-floating threw before setting gjoa-urlbar-floating / showPopover.
# The ghost builder (unguarded) is the suspect; run its exact risky sweep with a
# try/catch to name the throwing element, then dispatch a real Ctrl+L and read state.
import argparse, json, os, shutil, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# The exact risky logic from the ghost builder, wrapped to report the culprit.
SWEEP = r"""
const urlbar=document.getElementById('urlbar');
const rect=urlbar.getBoundingClientRect();
try{
  const container=urlbar.querySelector('.urlbar-input-container')||urlbar;
  const vis=(el)=>{const r=el.getBoundingClientRect();const c=getComputedStyle(el);
    return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden';};
  let scanned=0, iconTag=null;
  const iconEl=Array.from(container.querySelectorAll('*')).find((el)=>{
    scanned++;
    if(!vis(el))return false;
    const r=el.getBoundingClientRect();const c=getComputedStyle(el);
    return r.width<=28 && (c.listStyleImage!=='none'||c.backgroundImage!=='none');});
  if(iconEl) iconTag=iconEl.tagName.toLowerCase()+(iconEl.id?'#'+iconEl.id:'');
  const input=urlbar.querySelector('.urlbar-input')||(window.gURLBar&&gURLBar.inputField);
  const tl = input ? Math.round(input.getBoundingClientRect().left-rect.left) : null;
  return JSON.stringify({ok:true, scanned, iconTag, textLeft:tl, hasInput:!!input});
}catch(e){ return JSON.stringify({ok:false, error:String(e), stack:String(e&&e.stack||'').slice(0,300)}); }
"""

STATE = r"""
const r=document.documentElement, u=document.getElementById('urlbar');
return JSON.stringify({
  floating:r.hasAttribute('gjoa-urlbar-floating'),
  arming:r.hasAttribute('gjoa-urlbar-arming'),
  backdrop:!!document.getElementById('gjoa-urlbar-backdrop'),
  ghost:!!document.getElementById('gjoa-urlbar-ghost'),
  popoverOpen:u.matches(':popover-open'),
  urlbarLeft:Math.round(u.getBoundingClientRect().left),
  urlbarWidth:Math.round(u.getBoundingClientRect().width),
  innerWidth:window.innerWidth,
});
"""

CTRL_L = ("try{const el=gURLBar.inputField||gURLBar;gURLBar.focus();"
          "el.dispatchEvent(new KeyboardEvent('keydown',{key:'l',ctrlKey:true,bubbles:true,cancelable:true}));"
          "document.dispatchEvent(new KeyboardEvent('keydown',{key:'l',ctrlKey:true,bubbles:true,cancelable:true}));}"
          "catch(e){} return 'ctrl-l';")


def launch_cage(binp, port, prof):
    """Launch under a headless cage compositor (real offscreen render, 1280x720) so
    the window is wide enough to tell CENTERED (left~210) from sidebar-anchored
    (left~40) — the 708px render workspace can't distinguish them."""
    if os.path.exists(prof): shutil.rmtree(prof, ignore_errors=True)
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "user.js"), "w") as f:
        f.write('user_pref("marionette.port",%d);\n' % port)
        f.write('user_pref("marionette.enabled",true);\n')
        f.write('user_pref("browser.sessionstore.resume_from_crash",false);\n')
    rt = "/tmp/gjoa-cage-rt-%d" % port
    os.makedirs(rt, exist_ok=True)
    env = dict(os.environ, XDG_RUNTIME_DIR=rt, WLR_BACKENDS="headless",
               WLR_RENDERER="pixman", WLR_HEADLESS_OUTPUTS="1",
               GJOA_ALLOW_INSECURE="1", GJOA_DEV_LOADER="1")
    p = subprocess.Popen(
        ["nix", "run", "nixpkgs#cage", "--", "--", binp, "-no-remote", "-profile", prof,
         "-marionette", "-remote-allow-system-access", "about:blank"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(200):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1); s.close(); return p
        except OSError:
            if p.poll() is not None: raise RuntimeError("cage/gjoa exited rc=%s" % p.returncode)
            time.sleep(0.3)
    raise RuntimeError("marionette never came up (cage)")


def launch(binp, port, prof):
    if os.path.exists(prof): shutil.rmtree(prof, ignore_errors=True)
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "user.js"), "w") as f:
        f.write('user_pref("marionette.port",%d);\n' % port)
        f.write('user_pref("marionette.enabled",true);\n')
        f.write('user_pref("browser.sessionstore.resume_from_crash",false);\n')
    subprocess.run(["bash", "-c",
        'command -v niri >/dev/null && command -v jq >/dev/null || exit 0; '
        'idx=$(niri msg --json workspaces 2>/dev/null | jq -r '
        '"[.[]|select(.name==null)]|min_by(.idx)|.idx" 2>/dev/null); '
        '[ -n "$idx" ] && [ "$idx" != null ] && niri msg action set-workspace-name --workspace "$idx" render || true'],
        timeout=8)
    env = dict(os.environ, GJOA_ALLOW_INSECURE="1", GJOA_DEV_LOADER="1", MOZ_APP_REMOTINGNAME="gjoa-render")
    p = subprocess.Popen([binp, "-no-remote", "-profile", prof, "-marionette",
        "-remote-allow-system-access", "about:blank"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(150):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1); s.close(); return p
        except OSError:
            if p.poll() is not None: raise RuntimeError("gjoa exited rc=%s" % p.returncode)
            time.sleep(0.2)
    raise RuntimeError("marionette never came up")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(REPO, "engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"))
    ap.add_argument("--port", type=int, default=3315)
    ap.add_argument("--url", default="https://example.com/")
    ap.add_argument("--cage", action="store_true", help="launch under headless cage (1280px window)")
    a = ap.parse_args()
    binp = a.bin if os.path.exists(a.bin) else os.path.join(REPO, "result/bin/gjoa")
    print("bin:", binp, "url:", a.url, "cage:", a.cage, flush=True)
    proc = (launch_cage if a.cage else launch)(binp, a.port, "/tmp/urlbar-float-real-prof")
    m = cs.Marionette(a.port); m.newsession()
    def V(r): return r.get("value") if isinstance(r, dict) else r
    # navigate content + wait for the real load (identity box only populates once loaded)
    m.ctx("content")
    try: m.send("WebDriver:Navigate", {"url": a.url})
    except Exception as e: print("nav error:", e)
    loc = None
    for _ in range(30):
        try: loc = V(m.exec_chrome("return document.location.href;"))
        except Exception: loc = None
        if loc and a.url.split("//")[-1].split("/")[0] in str(loc): break
        time.sleep(0.5)
    print("loaded location:", loc, flush=True)
    time.sleep(1.0)
    m.ctx("chrome")
    # dump the populated identity box structure (what differs from about:blank)
    idbox = V(m.exec_chrome(
        "const c=document.querySelector('#urlbar .urlbar-input-container');"
        "if(!c)return '[]';"
        "return JSON.stringify(Array.from(c.querySelectorAll('*')).slice(0,40).map(e=>{"
        "const r=e.getBoundingClientRect();const s=getComputedStyle(e);"
        "return {t:e.tagName.toLowerCase()+(e.id?'#'+e.id:''),w:Math.round(r.width),"
        "vis:(r.width>0&&s.display!=='none'&&s.visibility!=='hidden'),"
        "img:(s.listStyleImage!=='none'?'L':'')+(s.backgroundImage!=='none'?'B':'')};}));"))
    print("identity-box children:", idbox, flush=True)
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){} return 1;")
    time.sleep(0.5)
    sweep = json.loads(V(m.exec_chrome(SWEEP)))
    m.exec_chrome(CTRL_L); time.sleep(0.5)
    state = json.loads(V(m.exec_chrome(STATE)))
    # also drive a query so the results view opens (breakout-extend) — the exact state in
    # the owner's screenshot (results showing) — and re-measure centering there.
    m.exec_chrome("try{gURLBar.focus();gURLBar.value='reddit.com';"
                  "gURLBar.dispatchEvent(new Event('input',{bubbles:true}));"
                  "if(gURLBar.startQuery)gURLBar.startQuery({allowAutofill:false,searchString:'reddit.com'});}catch(e){}return 1;")
    time.sleep(0.8)
    state_typed = json.loads(V(m.exec_chrome(STATE)))
    state_typed["breakoutExtend"] = V(m.exec_chrome("return String(document.getElementById('urlbar').hasAttribute('breakout-extend'));"))
    diag = V(m.exec_chrome(
        "const u=document.getElementById('urlbar');const s=getComputedStyle(u);"
        "const anc=[];let n=u.parentElement;"
        "while(n){const cs=getComputedStyle(n);"
        "if(cs.transform!=='none'||cs.filter!=='none'||cs.perspective!=='none'||cs.willChange.includes('transform')||cs.contain.includes('paint')||cs.contain.includes('layout'))"
        "anc.push((n.id||n.tagName.toLowerCase())+':'+(cs.transform!=='none'?'transform ':'')+(cs.filter!=='none'?'filter ':'')+(cs.willChange!=='auto'?('wc='+cs.willChange+' '):'')+(cs.contain!=='none'?('contain='+cs.contain):''));"
        "n=n.parentElement;}"
        "return JSON.stringify({position:s.position,left:s.left,right:s.right,insetInlineStart:s.insetInlineStart,insetInlineEnd:s.insetInlineEnd,"
        "marginLeft:s.marginLeft,marginRight:s.marginRight,width:s.width,offsetParent:(u.offsetParent?(u.offsetParent.id||u.offsetParent.tagName.toLowerCase()):null),"
        "containingBlockAncestors:anc});"))
    print(json.dumps({"sweep": sweep, "state_after_ctrl_l": state, "diag": json.loads(diag)}, indent=1))
    m.quit()
    try: proc.terminate()
    except Exception: pass
    print("\n--- VERDICT ---", file=sys.stderr)
    if not sweep.get("ok"):
        print("GHOST-SWEEP THREW: %s" % sweep.get("error"), file=sys.stderr)
        print("stack: %s" % sweep.get("stack"), file=sys.stderr)
    else:
        print("ghost sweep ok (scanned=%s icon=%s textLeft=%s)" % (sweep.get("scanned"), sweep.get("iconTag"), sweep.get("textLeft")), file=sys.stderr)
    s = state
    iw, uw, ul = s.get("innerWidth", 0), s.get("urlbarWidth", 0), s.get("urlbarLeft", 0)
    expected_left = round((iw - uw) / 2)
    off = abs(ul - expected_left)
    print("after real Ctrl+L: floating=%s backdrop=%s popover=%s width=%s left=%s (innerW=%s, centered-left≈%s, off=%s)" %
          (s.get("floating"), s.get("backdrop"), s.get("popoverOpen"), uw, ul, iw, expected_left, off), file=sys.stderr)
    fail = False
    if not s.get("floating") or not s.get("backdrop"):
        print("FAIL: floating palette did NOT activate (no floating attr / backdrop) — the regression.", file=sys.stderr); fail = True
    # centered within 40px of viewport center; a sidebar-anchored palette lands far left
    if iw and off > 40:
        print("FAIL: palette NOT centered — left=%s but viewport-center wants ≈%s (off %spx). Anchored to the sidebar containing-block?" % (ul, expected_left, off), file=sys.stderr); fail = True
    # same centering check with results OPEN (breakout-extend) — the screenshot state
    st = state_typed
    iw2, uw2, ul2 = st.get("innerWidth", 0), st.get("urlbarWidth", 0), st.get("urlbarLeft", 0)
    exp2 = round((iw2 - uw2) / 2)
    off2 = abs(ul2 - exp2)
    print("with results open (breakout-extend=%s): width=%s left=%s (centered-left≈%s, off=%s)" %
          (st.get("breakoutExtend"), uw2, ul2, exp2, off2), file=sys.stderr)
    if iw2 and off2 > 40:
        print("FAIL: palette NOT centered with results open (off %spx)." % off2, file=sys.stderr); fail = True
    if fail: sys.exit(1)
    print("PASS: floating palette activated + centered on a real page (empty AND results-open).", file=sys.stderr)


if __name__ == "__main__":
    main()
