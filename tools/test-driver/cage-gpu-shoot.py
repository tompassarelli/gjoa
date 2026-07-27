#!/usr/bin/env python3
# GPU-rendered headless harness for gjoa — cage on the real GL renderer (radeonsi),
# so gjoa runs HARDWARE WebRender + the native Wayland compositor path, and grim
# captures true composited pixels. This is the GPU counterpart to urlbar-pixmon.py
# (which uses software pixman). Built to chase the Ctrl+L "palette cut off at the
# sidebar" report, which does NOT reproduce under software rendering.
#
#   python3 tools/test-driver/cage-gpu-shoot.py --url https://en.wikipedia.org/ --shot out.png
#
# The dev obj build is NOT nix-wrapped, so it can't find the GLVND libEGL.so.1 /
# libgbm the graphics stack needs — without them Firefox logs
# FEATURE_FAILURE_EGL_LOAD_3 and silently falls back to SOFTWARE WebRender (a fake
# "GPU" harness). We pull the exact mesa/libglvnd/libgbm store paths out of the
# native `result/bin/gjoa` wrapper and prepend them to LD_LIBRARY_PATH; the harness
# asserts EGL actually loaded so a software fallback can't masquerade as a GPU run.
#
# NOTE (2026-07-20): even with confirmed hardware WebRender + native compositor
# forced on, the floating palette renders CORRECTLY over content here. cage does not
# advertise the protocols (dmabuf-feedback / direct-scanout) that make niri composite
# page content over chrome, so the "cut off" repro needs niri itself, not cage.
import argparse, json, os, shutil, socket, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cs = import_module("chrome-shoot")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def graphics_ld_paths():
    """The mesa / libglvnd / libgbm / libdrm store paths the native wrapper adds."""
    wrapper = os.path.join(REPO, "result/bin/gjoa")
    paths = []
    if os.path.exists(wrapper):
        r = subprocess.run(["bash", "-c",
            "grep -oE '/nix/store/[a-z0-9]+-(mesa|libglvnd|libdrm|libgbm)[^:\\'' ]*/lib(64)?' "
            + wrapper + " | sort -u"], capture_output=True, text=True)
        paths = [p for p in r.stdout.split() if p]
    return paths


def launch(binp, port, rt, prof, native_compositor=True):
    for d in (rt, prof):
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    os.chmod(rt, 0o700)
    prefs = ['user_pref("marionette.port",%d);' % port,
             'user_pref("marionette.enabled",true);',
             'user_pref("browser.sessionstore.resume_from_crash",false);',
             'user_pref("gfx.webrender.all",true);',
             'user_pref("gfx.webrender.software",false);']
    if native_compositor:
        prefs += ['user_pref("gfx.webrender.compositor",true);',
                  'user_pref("gfx.webrender.compositor.force-enabled",true);']
    else:
        prefs += ['user_pref("gfx.webrender.compositor",false);']
    with open(os.path.join(prof, "user.js"), "w") as f:
        f.write("\n".join(prefs) + "\n")
    drv = "/run/opengl-driver/lib"
    ld = ":".join(graphics_ld_paths() + [drv, os.environ.get("LD_LIBRARY_PATH", "")])
    env = dict(os.environ, XDG_RUNTIME_DIR=rt, WLR_BACKENDS="headless", WLR_RENDERER="gles2",
               WLR_RENDER_DRM_DEVICE="/dev/dri/renderD128", WLR_HEADLESS_OUTPUTS="1",
               MOZ_ENABLE_WAYLAND="1", GJOA_ALLOW_INSECURE="1", GJOA_DEV_LOADER="1",
               LD_LIBRARY_PATH=ld,
               __EGL_VENDOR_LIBRARY_DIRS="/run/opengl-driver/share/glvnd/egl_vendor.d",
               LIBGL_DRIVERS_PATH=drv + "/dri")
    log = os.path.join(rt, "cage.log")
    p = subprocess.Popen(["nix", "run", "nixpkgs#cage", "--", "--", binp, "-no-remote",
        "-profile", prof, "-marionette", "-remote-allow-system-access", "about:blank"],
        env=env, stdout=open(log, "w"), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(90):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1); s.close(); time.sleep(1.5)
            return p, env, log
        except OSError:
            if p.poll() is not None: raise RuntimeError("cage/gjoa exited rc=%s" % p.returncode)
            time.sleep(1)
    raise RuntimeError("marionette never came up")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(REPO, "engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"))
    ap.add_argument("--url", default="https://en.wikipedia.org/wiki/Main_Page")
    ap.add_argument("--port", type=int, default=3373)
    ap.add_argument("--shot", default="/tmp/cage-gpu-shot.png")
    ap.add_argument("--no-native-compositor", action="store_true")
    a = ap.parse_args()
    binp = a.bin if os.path.exists(a.bin) else os.path.join(REPO, "result/bin/gjoa")
    proc, env, log = launch(binp, a.port, "/tmp/gjoa-cagegpu-rt", "/tmp/gjoa-cagegpu-prof",
                            native_compositor=not a.no_native_compositor)
    m = cs.Marionette(a.port); m.newsession(); V = lambda r: r.get("value") if isinstance(r, dict) else r
    m.ctx("content"); m.send("WebDriver:Navigate", {"url": a.url}); time.sleep(6)
    m.ctx("chrome"); m.exec_chrome("try{window.docShell.isActive=true;window.focus();}catch(e){}return 1;"); time.sleep(0.5)
    m.exec_chrome("document.dispatchEvent(new CustomEvent('gjoa-urlbar-activate',{detail:{intent:'current'}}));try{window.focus();gURLBar.focus();}catch(e){}return 1;"); time.sleep(0.4)
    m.exec_chrome("try{gURLBar.focus();gURLBar.value='r';gURLBar.dispatchEvent(new Event('input',{bubbles:true}));if(gURLBar.startQuery)gURLBar.startQuery({allowAutofill:false,searchString:'r'});}catch(e){}return 1;"); time.sleep(1.2)
    r = subprocess.run(["grim", a.shot], env=dict(env, WAYLAND_DISPLAY="wayland-0"), capture_output=True, text=True)
    egl_failed = "EGL_LOAD" in open(log).read() or "Failed GL context" in open(log).read()
    print("shot:", a.shot if os.path.exists(a.shot) else "MISSING", "| grim rc:", r.returncode)
    print("HARDWARE WebRender:", "NO (EGL failed → software fallback!)" if egl_failed else "yes (EGL loaded)")
    m.quit()
    try: proc.terminate()
    except Exception: pass
    if egl_failed:
        sys.stderr.write("WARN: gjoa fell back to SOFTWARE WebRender — not a real GPU run.\n"); sys.exit(1)


if __name__ == "__main__":
    main()
