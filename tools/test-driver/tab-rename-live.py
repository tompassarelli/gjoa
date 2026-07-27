#!/usr/bin/env python3
# Behavioural gate for the tab-rename typing regression (owner 2026-07-20:
# "rename activates, but then I can't type any additional letters").
#
#   python3 tools/test-driver/tab-rename-live.py [--bin PATH]
#
# Drives the REAL rename flow in a stealth dev browser (gjoa.test.exposeAPI): focus
# the panel, press `r` to start rename, then dispatch a run of keystrokes INCLUDING
# vim command keys (r/j/x). Before the fix the first printable key tore the rename
# down (focus jumped to the page). After the fix the vim capture handlers bail while
# `vs.renaming` is set, so every key stays in the contenteditable label; Escape still
# cancels via the label's own handler.
#
# Exit 0 = rename holds focus through typing + Escape cancels; exit 1 = regressed.
import argparse, json, os, shutil, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

DRIVE = r"""
const T=window.gjoaTest, vim=T&&T.vim;
if(!vim) return JSON.stringify({err:'gjoaTest.vim not exposed (need gjoa.test.exposeAPI)'});
vim.focusPanel();
document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true,cancelable:true}));
const lbl=document.querySelector('.gjoa-renaming');
if(!lbl) return JSON.stringify({err:'rename did not activate on r'});
const results=[];
for(const k of ['h','e','l','l','o','r','j','x']){  // letters + vim command keys
  lbl.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  results.push({key:k, focused:document.activeElement===lbl,
    renaming:lbl.classList.contains('gjoa-renaming')});
}
lbl.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
const escCancels=!document.querySelector('.gjoa-renaming');
return JSON.stringify({activated:true, results, escCancels});
"""


def launch(binp, port, prof):
    if os.path.exists(prof): shutil.rmtree(prof, ignore_errors=True)
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "user.js"), "w") as f:
        f.write('user_pref("marionette.port",%d);\n' % port)
        f.write('user_pref("marionette.enabled",true);\n')
        f.write('user_pref("gjoa.test.exposeAPI",true);\n')
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
    ap.add_argument("--port", type=int, default=3351)
    a = ap.parse_args()
    binp = a.bin if os.path.exists(a.bin) else os.path.join(REPO, "result/bin/gjoa")
    print("bin:", binp, flush=True)
    proc = launch(binp, a.port, "/tmp/tab-rename-live-prof")
    m = cs.Marionette(a.port); m.newsession(); m.ctx("chrome")
    def V(r): return r.get("value") if isinstance(r, dict) else r
    time.sleep(2.5)
    out = json.loads(V(m.exec_chrome(DRIVE)))
    print(json.dumps(out, indent=1))
    m.quit()
    try: proc.terminate()
    except Exception: pass
    if out.get("err"):
        print("FAIL: %s" % out["err"], file=sys.stderr); sys.exit(1)
    held = all(r["focused"] and r["renaming"] for r in out.get("results", []))
    print("\n--- VERDICT ---", file=sys.stderr)
    print("keystrokes that kept the rename focused+editable: %d/%d" %
          (sum(1 for r in out["results"] if r["focused"] and r["renaming"]), len(out["results"])), file=sys.stderr)
    print("Escape cancels rename: %s" % out.get("escCancels"), file=sys.stderr)
    if not held:
        lost = [r["key"] for r in out["results"] if not (r["focused"] and r["renaming"])]
        print("FAIL: rename lost focus on key(s): %s (typing tears it down)." % lost, file=sys.stderr); sys.exit(1)
    if not out.get("escCancels"):
        print("FAIL: Escape did not cancel rename.", file=sys.stderr); sys.exit(1)
    print("PASS: rename holds focus through all keystrokes (incl. vim keys) + Escape cancels.", file=sys.stderr)


if __name__ == "__main__":
    main()
