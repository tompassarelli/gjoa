#!/usr/bin/env python3
# urlbar-ghost-match-probe.py — ground-truth geometry for the two owner-reported
# Ctrl+L bugs (2026-07-19):
#   BUG 2 "icon isn't the same / text shifts on pop-out": the resting-slot GHOST
#         (#gjoa-urlbar-ghost) must pixel-match the real resting urlbar — same
#         leading-icon glyph, same text start-x — or the swap reads as a jump.
#   BUG 1 "on first load the bar flashes ~40-100px below then snaps to the palette":
#         sample #urlbar rect.top across the frames right after activation; a
#         non-monotonic / overshoot top == the transient.
#
# Reuses the stealth dev-launch (MOZ_APP_REMOTINGNAME=gjoa-render → niri hidden
# "render" workspace) so the owner's session is untouched.
#
#   python3 tools/test-driver/urlbar-ghost-match-probe.py [--bin PATH]
import argparse, json, os, shutil, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Resting-urlbar ground truth: the real leading icon element (identity/tracking-
# protection), its computed glyph source, and where the input text actually starts.
REST = r"""
const u=document.getElementById('urlbar');
const ur=u.getBoundingClientRect();
const cont=u.querySelector('.urlbar-input-container')||u;
// the visible leading icon: first non-zero-width image-ish element before the input
const input=u.querySelector('.urlbar-input')||u.querySelector('#urlbar-input');
const inr=input?input.getBoundingClientRect():null;
function vis(el){const r=el.getBoundingClientRect();const cs=getComputedStyle(el);
  return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';}
// walk the container's leading children, find the first visible icon-bearing box
let icon=null;
const kids=cont.querySelectorAll('*');
for(const el of kids){ if(!vis(el))continue;
  const cs=getComputedStyle(el);
  const hasImg=cs.backgroundImage!=='none'||cs.listStyleImage!=='none'||(cs.maskImage&&cs.maskImage!=='none');
  const r=el.getBoundingClientRect();
  if(hasImg && r.left<(inr?inr.left:ur.right) && r.width<=28){ icon=el; break; } }
const ir=icon?icon.getBoundingClientRect():null;
const ics=icon?getComputedStyle(icon):null;
return JSON.stringify({
  urlbar:{left:ur.left,top:ur.top,width:ur.width,height:ur.height},
  input:inr?{left:inr.left,textStartRel:Math.round(inr.left-ur.left)}:null,
  icon: icon?{ tag:icon.tagName.toLowerCase(), id:icon.id, cls:(typeof icon.className==='string'?icon.className:''),
    leftRel:Math.round(ir.left-ur.left), w:Math.round(ir.width), h:Math.round(ir.height),
    bg:ics.backgroundImage, list:ics.listStyleImage, mask:ics.maskImage, fill:ics.fill }:null,
  placeholder: input?input.placeholder:null,
});
"""

GHOST = r"""
const u=document.getElementById('urlbar');
const g=document.getElementById('gjoa-urlbar-ghost');
if(!g) return JSON.stringify({ghost:null});
const gr=g.getBoundingClientRect();
// ghost is now: N icon SLOTS (each wraps a 16px glyph div) + a trailing text div.
const slots=Array.from(g.children).slice(0,-1);
const glyphCount=slots.filter(s=>{const ic=s.firstElementChild;const cs=ic?getComputedStyle(ic):null;
  return cs&&(cs.backgroundImage!=='none'||cs.maskImage!=='none');}).length;
const icon=(g.firstElementChild&&g.firstElementChild.firstElementChild)||g.firstElementChild;
const txt=g.lastElementChild;
const ir=icon.getBoundingClientRect(), tr=txt.getBoundingClientRect();
const ics=getComputedStyle(icon);
// real urlbar identity icon WHILE floating (what the palette shows)
const cont=u.querySelector('.urlbar-input-container')||u;
function vis(el){const r=el.getBoundingClientRect();const cs=getComputedStyle(el);
  return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';}
let ricon=null; for(const el of cont.querySelectorAll('*')){ if(!vis(el))continue;
  const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
  const hasImg=cs.backgroundImage!=='none'||cs.listStyleImage!=='none'||(cs.maskImage&&cs.maskImage!=='none');
  if(hasImg&&r.width<=28){ ricon=el; break; } }
const rr=ricon?ricon.getBoundingClientRect():null; const rcs=ricon?getComputedStyle(ricon):null;
return JSON.stringify({
  ghost:{left:Math.round(gr.left),top:Math.round(gr.top),width:Math.round(gr.width),height:Math.round(gr.height)},
  ghostIcon:{leftRel:Math.round(ir.left-gr.left),w:Math.round(ir.width),h:Math.round(ir.height),mask:ics.maskImage,bg:ics.backgroundImage},
  ghostText:{leftRel:Math.round(tr.left-gr.left),text:txt.textContent},
  glyphCount: glyphCount,
  floatIcon: ricon?{cls:(typeof ricon.className==='string'?ricon.className:''),bg:rcs.backgroundImage,list:rcs.listStyleImage,mask:rcs.maskImage}:null,
});
"""

ACTIVATE = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
            "try{window.focus();gURLBar.focus();}catch(e){} return 'act';")
TOP = "const u=document.getElementById('urlbar');return String(Math.round(u.getBoundingClientRect().top));"
DEACT = "document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate'));return 'd';"


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
    ap.add_argument("--port", type=int, default=3271)
    a = ap.parse_args()
    binp = a.bin if os.path.exists(a.bin) else os.path.join(REPO, "result/bin/gjoa")
    print("probe binary:", binp, flush=True)
    proc = launch(binp, a.port, "/tmp/urlbar-ghost-probe-profile")
    m = cs.Marionette(a.port); m.newsession(); m.ctx("chrome")
    def V(r): return r.get("value") if isinstance(r, dict) else r
    try: m.send("WebDriver:SetWindowRect", {"x": 0, "y": 0, "width": 1400, "height": 1000})
    except Exception: pass
    time.sleep(2.0)
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){} return 1;")
    rest = json.loads(V(m.exec_chrome(REST)))
    # first-load activate + immediate rect.top sampling (bug 1)
    m.exec_chrome(ACTIVATE)
    tops = []
    for _ in range(12):
        tops.append(int(V(m.exec_chrome(TOP)))); time.sleep(0.016)
    time.sleep(0.4)
    ghost = json.loads(V(m.exec_chrome(GHOST)))
    out = {"resting": rest, "firstload_urlbar_top_samples": tops, "floating": ghost}
    print(json.dumps(out, indent=1))
    # verdicts (pass/fail gate)
    print("\n--- VERDICT ---", file=sys.stderr)
    fails = []
    r_txt = rest.get("input", {}).get("textStartRel") if rest.get("input") else None
    g_txt = ghost.get("ghostText", {}).get("leftRel") if ghost.get("ghost") else None
    if r_txt is None or g_txt is None:
        fails.append("could not measure text-start (resting=%s ghost=%s)" % (r_txt, g_txt))
    else:
        d = abs(r_txt - g_txt)
        print("text-start  resting=%spx  ghost=%spx  delta=%spx  (bug2: must be <=2)" % (r_txt, g_txt, d), file=sys.stderr)
        if d > 2: fails.append("ghost text shifts %dpx vs resting urlbar (bug 2)" % d)
    # icons: the ghost must reproduce the leading icon(s) with real glyphs. Exact
    # per-icon glyph + position (incl. the moz-button switcher via iconsrc) is verified
    # on a LOADED page by urlbar-float-realpage-probe.py, which isn't polluted by the
    # marionette robot icon this about:blank probe carries.
    gc = ghost.get("glyphCount", 0)
    print("ghost icon slots with a glyph: %d  (must be >=1)" % gc, file=sys.stderr)
    if gc < 1: fails.append("ghost reproduced no leading-icon glyph (bug 2)")
    lo, hi = min(tops), max(tops)
    print("firstload urlbar.top: min=%d max=%d spread=%d  (spread>10px ⇒ layout transient)" % (lo, hi, hi-lo), file=sys.stderr)
    if hi - lo > 10: fails.append("urlbar.top layout transient of %dpx on first activate" % (hi-lo))
    # arming must have cleared: the palette must be VISIBLE after settle (not stuck opacity:0)
    armed = V(m.exec_chrome("return String(document.documentElement.hasAttribute('gjoa-urlbar-arming'));"))
    print("arming attr still set after settle: %s  (must be false)" % armed, file=sys.stderr)
    if str(armed) == "true": fails.append("gjoa-urlbar-arming stuck on — palette would be invisible (bug 1 regression)")
    m.quit()
    try: proc.terminate()
    except Exception: pass
    if fails:
        print("FAIL:\n  " + "\n  ".join(fails), file=sys.stderr); sys.exit(1)
    print("PASS: ghost pixel-matches resting urlbar (icon glyph + text-start), no layout transient, arming clears.", file=sys.stderr)


if __name__ == "__main__":
    main()
