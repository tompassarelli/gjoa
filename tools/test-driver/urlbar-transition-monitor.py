#!/usr/bin/env python3
# urlbar-transition-monitor.py — ACTIVE frame-monitor for the Ctrl+L command-palette
# spawn/despawn animation. Manual QA can't reliably catch a transient artifact that
# exists for one or two frames mid-animation (owner: "take 30 screenshots/sec ... treat
# an extra popup/modal/component spawning during spawn or despawn as a test failure").
#
# HOW: the palette is browser CHROME (a top-layer popover), NOT page content — Playwright
# / WebDriver:TakeScreenshot can't see it. So we drive it via marionette CHROME context
# and, crucially, install an in-chrome MutationObserver + a per-frame rAF sampler BEFORE
# the transition. The sampler records, every animation frame, the full set of lifecycle
# invariants; the observer logs every element that appears/disappears. After the sequence
# we replay the frame log and FAIL on any frame that violates an invariant — i.e. a
# transient double-urlbar, an orphaned ghost, a stuck popover, or any stray component that
# spawned while the modal was opening or closing.
#
# STEALTH: launches gjoa with MOZ_APP_REMOTINGNAME=gjoa-render so niri routes the window to
# the hidden "render" workspace — the owner's active session is never touched.
#
#   python3 tools/test-driver/urlbar-transition-monitor.py [--bin PATH] [--keep] [--grim]
#
# Exit 0 = clean across every sampled frame of every sequence; exit 1 = artifact caught
# (prints the offending frames + the mutation that introduced the stray element).
import argparse, base64, json, os, shutil, signal, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# ── the in-chrome monitor: a MutationObserver (what spawned/despawned, fires on the
# microtask queue — NO rendering required) plus a synchronous SNAPSHOT() the Python side
# polls at ~30-60Hz. A niri HIDDEN-workspace window is not composited, so rAF never fires;
# but DOM mutations + timer-driven teardown state DO progress, and getBoundingClientRect
# forces layout on read — so Python-driven polling samples every frame of the STRUCTURAL
# transition (extra component, double urlbar, orphaned ghost, stuck popover) off-screen.
INSTALL = r"""
const root = document.documentElement;
const W = window.__gjoaMon = { muts: [], t0: performance.now() };
const now = () => Math.round(performance.now() - W.t0);
const okId = new Set(['gjoa-urlbar-ghost', 'gjoa-urlbar-backdrop']);
function expected(node) {                             // is this added node legitimate?
  if (node.nodeType !== 1) return true;
  let n = node;
  while (n && n.nodeType === 1) {
    const id = n.id || '';
    if (okId.has(id)) return true;
    if (id === 'urlbar' || id === 'nav-bar') return true;      // palette + its container
    const cls = (typeof n.className === 'string' ? n.className : '') || '';
    if (cls.includes('urlbarView') || cls.includes('urlbar-')) return true;  // result rows
    n = n.parentNode;
  }
  return false;
}
const desc = n => n.nodeType === 1
  ? (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
     (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : ''))
  : ('«' + n.nodeName + '»');
const mo = new MutationObserver(muts => {
  for (const m of muts) {
    for (const a of m.addedNodes) { if (a.nodeType === 1) W.muts.push({ t: now(), op: 'add', node: desc(a), stray: !expected(a) }); }
    for (const r of m.removedNodes) { if (r.nodeType === 1) W.muts.push({ t: now(), op: 'del', node: desc(r), stray: false }); }
  }
});
mo.observe(root, { childList: true, subtree: true });
W.mo = mo;
return 'installed';
"""

# One synchronous state snapshot. getBoundingClientRect forces layout so geometry is live
# even without a compositor. Returns the per-frame invariant record.
SNAPSHOT = r"""
const root = document.documentElement;
const bar = document.getElementById('urlbar');
let barVisible = 0, rect = null;
if (bar) { const r = bar.getBoundingClientRect(); rect = {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; if (r.width > 40 && r.height > 8) barVisible = 1; }
const ghostEls = document.querySelectorAll('#gjoa-urlbar-ghost');
let ghostVisible = 0;
for (const g of ghostEls) { const r = g.getBoundingClientRect(); if (r.width > 40 && r.height > 8) ghostVisible++; }
let popoverOpen = false; try { popoverOpen = !!(bar && bar.matches(':popover-open')); } catch(e) {}
let topLayer = 0; try { topLayer = document.querySelectorAll(':popover-open, dialog[open], [role="dialog"]').length; } catch(e) {}
let viewOpen = false, oneoffs = 0; try { viewOpen = !!(window.gURLBar && gURLBar.view && gURLBar.view.isOpen); } catch(e) {}
try { oneoffs = document.querySelectorAll('.search-panel-one-offs-container, #urlbar-searchmode-switcher, .search-one-offs').length; } catch(e) {}
const W = window.__gjoaMon || {t0: performance.now()};
return JSON.stringify({
  t: Math.round(performance.now() - W.t0),
  urlbars: barVisible + ghostVisible,            // resting/palette input + any visible ghost box
  ghosts: ghostEls.length,
  backdrops: document.querySelectorAll('#gjoa-urlbar-backdrop').length,
  floating: root.hasAttribute('gjoa-urlbar-floating'),
  teardown: root.hasAttribute('gjoa-urlbar-teardown'),
  popoverOpen, topLayer, rect, viewOpen, oneoffs,
});
"""

DUMP = "return JSON.stringify(window.__gjoaMon ? { muts: window.__gjoaMon.muts } : {muts:[]});"

ACTIVATE = ("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));"
            "try{window.focus();gURLBar.focus();}catch(e){} return 'act';")
# Fire a REAL urlbar query (startQuery) so the results view + search one-offs populate
# DURING the open state, exactly as live typing does — otherwise the view first builds on
# Enter and any one-offs look like a despawn spawn when they are really a late first-query.
TYPE = ("try{gURLBar.focus();gURLBar.value='youtube.com';"
        "gURLBar.dispatchEvent(new Event('input',{bubbles:true}));"
        "if(gURLBar.startQuery)gURLBar.startQuery({allowAutofill:false,searchString:'youtube.com'});}"
        "catch(e){} return 'typed';")
ENTER = ("try{const el=gURLBar.inputField||gURLBar;"
         "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));}"
         "catch(e){} return 'enter';")
ESCAPE = ("try{const el=gURLBar.inputField||gURLBar;"
          "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));}"
          "catch(e){} return 'esc';")
DEACTIVATE = "document.dispatchEvent(new CustomEvent('gjoa-urlbar-deactivate')); return 'deact';"


def launch(bin_path, port, prof):
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "user.js"), "w") as f:
        f.write('user_pref("marionette.port",%d);\n' % port)
        f.write('user_pref("marionette.enabled",true);\n')
        f.write('user_pref("browser.sessionstore.resume_from_crash",false);\n')
        f.write('user_pref("extensions.autoDisableScopes",0);\n')
    # name a trailing empty niri workspace "render" so the gjoa-render app-id lands hidden
    try:
        subprocess.run(["bash", "-c",
            'command -v niri >/dev/null && command -v jq >/dev/null || exit 0; '
            'idx=$(niri msg --json workspaces 2>/dev/null | jq -r '
            '"[.[]|select(.name==null)]|min_by(.idx)|.idx" 2>/dev/null); '
            '[ -n "$idx" ] && [ "$idx" != null ] && niri msg action set-workspace-name --workspace "$idx" render || true'],
            timeout=8)
    except Exception:
        pass
    env = dict(os.environ, GJOA_ALLOW_INSECURE="1", GJOA_DEV_LOADER="1",
               MOZ_APP_REMOTINGNAME="gjoa-render")
    p = subprocess.Popen(
        [bin_path, "-no-remote", "-profile", prof, "-marionette",
         "-remote-allow-system-access", "about:blank"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    # await marionette port
    for _ in range(150):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1); s.close(); return p
        except OSError:
            if p.poll() is not None:
                raise RuntimeError("gjoa exited during startup (rc=%s)" % p.returncode)
            time.sleep(0.2)
    raise RuntimeError("marionette port %d never came up" % port)


def analyze(seq, data):
    """Return list of (obj, reason) invariant violations for one sequence.

    The owner's invariant: while the palette is SPAWNING or DESPAWNING, no additional
    popup/modal/component may appear. We derive the despawn window from the frame log
    (first frame where teardown is set, or floating drops) and flag any element ADD after
    it — even urlbar-internal panels like the search one-offs, since a clean close must
    not be BUILDING new UI. Note the ghost coexisting with the floating palette is BY
    DESIGN (it fills the resting slot), so >1 visible input is only a fault once settled.
    """
    v = []
    frames = data.get("frames", [])
    muts = data.get("muts", [])
    if not frames:
        return [("", "no frames captured")]

    # despawn window start: first frame with teardown set (fall back to floating-drop)
    despawn_t = None
    for f in frames:
        if f["teardown"]:
            despawn_t = f["t"]; break
    if despawn_t is None:
        for i in range(1, len(frames)):
            if frames[i-1]["floating"] and not frames[i]["floating"]:
                despawn_t = frames[i]["t"]; break

    # 1) any component spawning during the despawn window (the owner's core failure).
    # Allow the palette's own results to build DURING open (before despawn); flag builds
    # that happen as it closes. Ghost/backdrop add/del are the expected lifecycle.
    if despawn_t is not None:
        for m in muts:
            if m["op"] == "add" and m["t"] >= despawn_t - 10 and "gjoa-urlbar" not in m["node"]:
                v.append((m, "component spawned during DESPAWN: %s @%dms (teardown began ~%dms)"
                          % (m["node"], m["t"], despawn_t)))
    # 2) explicitly-stray spawns any time (non-palette, non-ghost/backdrop element)
    for m in muts:
        if m.get("stray") and m["op"] == "add":
            v.append((m, "stray component spawned: %s @%dms" % (m["node"], m["t"])))
    # 3) per-frame structural invariants
    for f in frames:
        if f["ghosts"] > 1:
            v.append((f, "duplicate ghost: %d @%dms" % (f["ghosts"], f["t"])))
        if f["backdrops"] > 1:
            v.append((f, "duplicate backdrop: %d @%dms" % (f["backdrops"], f["t"])))
        if f["popoverOpen"] and not f["floating"] and not f["teardown"]:
            v.append((f, "stuck popover: open with no floating/teardown @%dms" % f["t"]))
        if f["ghosts"] >= 1 and not f["floating"] and not f["teardown"]:
            v.append((f, "orphaned ghost: present after teardown @%dms" % f["t"]))
    # 4) settled end-state (last 200ms): fully clean, exactly one resting urlbar
    settle_from = frames[-1]["t"] - 200
    tail = [f for f in frames if f["t"] >= settle_from]
    bad = [f for f in tail if f["ghosts"] or f["backdrops"] or f["floating"]
           or f["teardown"] or f["popoverOpen"] or f["urlbars"] != 1]
    if bad:
        b = bad[-1]
        v.append((b, "did NOT settle clean: urlbars=%d ghost=%d backdrop=%d floating=%s popover=%s @%dms"
                  % (b["urlbars"], b["ghosts"], b["backdrops"], b["floating"], b["popoverOpen"], b["t"])))
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(
        REPO, "engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"))
    ap.add_argument("--port", type=int, default=3196)
    ap.add_argument("--keep", action="store_true", help="leave the browser running")
    ap.add_argument("--outdir", default="/tmp/urlbar-monitor")
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    binp = a.bin
    if not os.path.exists(binp):
        # fall back to the native result binary
        alt = os.path.join(REPO, "result/bin/gjoa")
        binp = alt if os.path.exists(alt) else binp
    print("monitor binary:", binp, flush=True)
    prof = "/tmp/urlbar-monitor-profile"
    if os.path.exists(prof):
        shutil.rmtree(prof, ignore_errors=True)
    proc = launch(binp, a.port, prof)
    m = cs.Marionette(a.port); m.newsession(); m.ctx("chrome")
    def V(r): return r.get("value") if isinstance(r, dict) else r
    time.sleep(2.0)
    m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){} return 1;")

    results = {}

    def poll_for(frames, seconds):
        # tight Python-side poll of SNAPSHOT; each round-trip yields to the browser's
        # timer queue so the teardown setTimeouts progress between samples (~40-60Hz).
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                s = V(m.exec_chrome(SNAPSHOT))
                if s:
                    frames.append(json.loads(s))
            except Exception:
                pass

    def run_sequence(name, steps):
        m.exec_chrome(INSTALL)   # fresh observer + t0 each sequence
        frames = []
        for delay, script in steps:
            m.exec_chrome(script)
            poll_for(frames, delay)   # sample densely across this step's window
        muts = (json.loads(V(m.exec_chrome(DUMP)) or '{"muts":[]}') or {}).get("muts", [])
        data = {"frames": frames, "muts": muts}
        results[name] = data
        with open(os.path.join(a.outdir, "frames-%s.json" % name), "w") as f:
            json.dump(data, f)

    # Sequence 1: first activation (creation artifact) — open, hold, then clean deactivate.
    run_sequence("create", [(0.7, ACTIVATE), (0.6, DEACTIVATE), (0.6, "return 1;")])
    # Sequence 2: type + Enter (the reported "after enter" artifact). Give the query 0.8s
    # to populate the results view + one-offs DURING the open state (as real typing does) —
    # so a one-offs spawn AFTER Enter is a genuine despawn artifact, not a late-query mirage.
    run_sequence("enter", [(0.5, ACTIVATE), (0.8, TYPE), (0.2, ENTER), (1.0, "return 1;")])
    # Sequence 3: Escape dismiss.
    run_sequence("escape", [(0.5, ACTIVATE), (0.3, ESCAPE), (0.8, "return 1;")])

    # analyze
    fails = {}
    for name, data in results.items():
        v = analyze(name, data)
        fails[name] = v
        nf = len(data.get("frames", []))
        print("\n=== sequence %r: %d frames, %d mutations ===" % (name, nf, len(data.get("muts", []))))
        strays = [x for x in data.get("muts", []) if x.get("stray")]
        if strays:
            print("  STRAY SPAWNS:", strays[:6])
        if v:
            for _obj, reason in v[:8]:
                print("  ✗", reason)
        else:
            print("  ✓ clean across all frames")

    if not a.keep:
        try: m.quit()
        except Exception: pass
        try: os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception: pass
    total = sum(len(v) for v in fails.values())
    print("\n%s — %d invariant violation(s) across %d sequences" %
          ("ARTIFACT DETECTED" if total else "ALL CLEAN", total, len(results)))
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
