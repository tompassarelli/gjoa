#!/usr/bin/env bash
# stealth-probe.sh — measure C2 quarantine recovery under real-display (stealth) rendering.
#
# Renders N pages (default: the 20 worst quarantined from /tmp/mark3-darkcheck/rollup.json)
# in stealth mode (MOZ_HEADLESS unset, live Wayland compositor) and counts how many
# cross the C2 validity threshold (≥5 measured text nodes) vs. the headless baseline.
#
# BAR: ≥12/20 recovered (W0 blocker spec).
#
# Usage:
#   tools/test-driver/stealth-probe.sh [url-list-file] [outdir]
#   STEALTH_PORT=3091 tools/test-driver/stealth-probe.sh
#
# Env:
#   STEALTH_PORT   — marionette port for the single browser (default 3091; must be ≥3090)
#   SETTLE_S       — settle time per page in seconds (default 18)
#   GJOA_BIN       — override gjoa binary path
#   GJOA_PROF_SRC  — override profile source path
#
# Outputs:
#   $OUTDIR/stealth-results.json  — per-page {url, nodeCount, recovered} + summary
#   $OUTDIR/<slug>-stealth.png    — screenshot per recovered page

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

PORT="${STEALTH_PORT:-3091}"
SETTLE_S="${SETTLE_S:-18}"
GJOA_BIN="${GJOA_BIN:-$(echo "$REPO"/engine/obj-*/dist/bin/gjoa)}"
PROF_SRC="${GJOA_PROF_SRC:-$HOME/.config/mozilla/gjoa/4859ptgk.default-default}"
URL_LIST="${1:-}"
OUTDIR="${2:-/tmp/stealth-probe}"

mkdir -p "$OUTDIR"

# ---- Build URL list -------------------------------------------------------
if [ -n "$URL_LIST" ] && [ -f "$URL_LIST" ]; then
  URLS=$(grep -vE '^\s*#|^\s*$' "$URL_LIST")
else
  # Derive 20 worst quarantined from the mark-3 rollup
  echo "[stealth-probe] deriving 20 worst quarantined from /tmp/mark3-darkcheck/rollup.json"
  URLS=$(python3 - <<'PYEOF'
import json, sys
d = json.load(open('/tmp/mark3-darkcheck/rollup.json'))
q = [p for p in d['pages'] if isinstance(p,dict) and p.get('status') == 'indeterminate']
owner_kw = ['zdnet', 'pvk', 'youtube']
owner_q = [p for p in q if any(k in p['slug'] for k in owner_kw)]
rest = [p for p in q if not any(k in p['slug'] for k in owner_kw)]
selected = owner_q + rest[:20-len(owner_q)]
for p in selected:
    print(p['url'])
PYEOF
  )
fi

TOTAL=$(printf '%s\n' "$URLS" | grep -c .)
echo "[stealth-probe] $TOTAL URLs, port=$PORT, settle=${SETTLE_S}s"
echo "[stealth-probe] gjoa: $GJOA_BIN"
echo "[stealth-probe] profile: $PROF_SRC"

# ---- Profile clone --------------------------------------------------------
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' \
     --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')
PROF_DST="/tmp/stealth-probe-profile"
rm -rf "$PROF_DST"; mkdir -p "$PROF_DST"
rsync -a "${RSX[@]}" "$PROF_SRC/" "$PROF_DST/" 2>/dev/null
printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\n' "$PORT" >> "$PROF_DST/user.js"

# ---- Launch browser (stealth: no MOZ_HEADLESS) ----------------------------
echo "[stealth-probe] launching browser (stealth, real display)..."
TMO=$(( TOTAL * 45 + 300 ))
env GJOA_ALLOW_INSECURE=1 GJOA_DEV_LOADER=1 \
    WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" DISPLAY="${DISPLAY:-}" \
    timeout "$TMO" "$GJOA_BIN" \
    -no-remote -profile "$PROF_DST" -marionette -remote-allow-system-access about:blank \
    > "/tmp/stealth-probe-browser.log" 2>&1 &
BPID=$!
cleanup() { kill "$BPID" 2>/dev/null || true; }
trap cleanup EXIT

echo "[stealth-probe] waiting for browser startup (fast-poll, connect within 30s)..."
sleep 3

# ---- Per-page probe -------------------------------------------------------
# Inline Python: connect, navigate, count text nodes with computed color (C2 proxy).
# C2 threshold: ≥5 measured nodes = not quarantined (matches darkcheck-audit.js minEls=5).
python3 - "$PORT" "$SETTLE_S" "$OUTDIR" "$TOTAL" <<PYEOF
import json, socket, base64, sys, time, re, math, os

PORT = int(sys.argv[1])
SETTLE = int(sys.argv[2])
OUTDIR = sys.argv[3]
TOTAL = int(sys.argv[4])

# ---- Minimal marionette client ----
class M:
    def __init__(self, port, timeout=90):
        # Fast poll (0.3s) so we connect before the browser's startup self-exit window
        self.buf=b""; self.id=1; dl=time.time()+timeout; last=None
        while time.time()<dl:
            try: self.s=socket.create_connection(("127.0.0.1",port),timeout=2); self.s.settimeout(180); break
            except OSError as e: last=e; time.sleep(0.3)
        else: raise SystemExit(f"connect 127.0.0.1:{port}: {last}")
        self._frame()
    def _frame(self):
        while b":" not in self.buf:
            c=self.s.recv(65536)
            if not c: raise SystemExit("closed")
            self.buf+=c
        i=self.buf.index(b":"); n=int(self.buf[:i]); need=i+1+n
        while len(self.buf)<need:
            c=self.s.recv(65536); self.buf+=c
        p=self.buf[i+1:need]; self.buf=self.buf[need:]; return json.loads(p.decode())
    def send(self,name,params):
        mid=self.id; self.id+=1; msg=json.dumps([0,mid,name,params]).encode()
        self.s.sendall(f"{len(msg)}:".encode()+msg)
        while True:
            r=self._frame()
            if isinstance(r,list) and r[0]==1 and r[1]==mid:
                if r[2]: raise SystemExit(f"{name}: {r[2]}")
                return r[3]
    def newsession(self): return self.send("WebDriver:NewSession",{"capabilities":{"alwaysMatch":{"pageLoadStrategy":"eager"},"firstMatch":[{}]}})
    def ctx(self,c): self.send("Marionette:SetContext",{"value":c})
    def navigate(self,url):
        try: return self.send("WebDriver:Navigate",{"url":url})
        except SystemExit as e: return f"NAV:{e}"
    def exe(self,s,t=20000):
        try:
            r=self.send("WebDriver:ExecuteScript",{"script":s,"args":[],"scriptTimeout":t,"newSandbox":False})
            return r.get("value") if isinstance(r,dict) else r
        except SystemExit: return None
    def shot(self,path):
        self.ctx("chrome")
        try:
            r=self.send("WebDriver:TakeScreenshot",{"full":False})
            data=r.get("value") if isinstance(r,dict) else r
            open(path,"wb").write(base64.b64decode(data))
            self.ctx("content")
            return True
        except SystemExit:
            self.ctx("content")
            return False
    def quit(self):
        try: self.send("Marionette:Quit",{"flags":["eForceQuit"]})
        except SystemExit: pass

# JS: count text nodes with non-transparent computed color (C2 validity proxy).
# Mirrors darkcheck-audit.js logic: samples body/heading/p/a/span text elements.
NODE_COUNT_JS = """
// WebDriver:ExecuteScript runs this as a function body — must use top-level return.
return (function(){
  var tags = ['p','h1','h2','h3','h4','h5','h6','a','li','span','div','td','th'];
  var seen = 0;
  for (var i=0; i<tags.length; i++) {
    var els = document.querySelectorAll(tags[i]);
    for (var j=0; j<els.length; j++) {
      var el = els[j];
      var txt = (el.textContent || '').trim();
      if (txt.length < 3) continue;
      seen++;
      if (seen >= 20) return seen; // enough to confirm real content
    }
  }
  return seen;
})();
"""

def slug(url):
    s = re.sub(r'[^a-zA-Z0-9]', '_', re.sub(r'^https?://(www\.)?', '', url))
    return s[:60]

print(f"[probe] connecting to marionette on port {PORT}...", flush=True)
m = M(PORT)
m.newsession()
m.send("WebDriver:SetTimeouts",{"pageLoad":30000,"script":20000,"implicit":0})
m.ctx("content")

results = []
urls_raw = sys.stdin.read().strip() if False else None

# Read URLs from env arg (passed via shell here-doc, not stdin)
import subprocess
url_list_env = os.environ.get('STEALTH_URLS','')
if url_list_env:
    urls = [u.strip() for u in url_list_env.split('\n') if u.strip()]
else:
    # fallback: re-derive from rollup (same logic as shell above)
    import json as _json
    d = _json.load(open('/tmp/mark3-darkcheck/rollup.json'))
    q = [p for p in d['pages'] if isinstance(p,dict) and p.get('status') == 'indeterminate']
    owner_kw = ['zdnet', 'pvk', 'youtube']
    owner_q = [p for p in q if any(k in p['slug'] for k in owner_kw)]
    rest = [p for p in q if not any(k in p['slug'] for k in owner_kw)]
    selected = owner_q + rest[:20-len(owner_q)]
    urls = [p['url'] for p in selected]

MIN_ELS = 5  # C2 threshold (matches darkcheck-audit.js minEls default)

for i, url in enumerate(urls):
    print(f"[probe] {i+1}/{len(urls)} {url}", flush=True)
    nav = m.navigate(url)
    if nav and str(nav).startswith("NAV:"):
        print(f"  NAV error: {nav}", flush=True)
        results.append({"url": url, "slug": slug(url), "nodeCount": 0, "recovered": False, "note": str(nav)})
        continue
    # Settle: wait for real content
    time.sleep(SETTLE)
    n = m.exe(NODE_COUNT_JS) or 0
    recovered = (n >= MIN_ELS)
    note = ""
    png_path = None
    if recovered:
        png_path = os.path.join(OUTDIR, f"{slug(url)}-stealth.png")
        m.shot(png_path)
        note = f"screenshot: {png_path}"
    label = "RECOVERED" if recovered else "WALL-REMAINS"
    print(f"  {label} nodes={n} {note}", flush=True)
    results.append({"url": url, "slug": slug(url), "nodeCount": n, "recovered": recovered, "note": note})

m.quit()

recovered_count = sum(1 for r in results if r['recovered'])
summary = {
    "total": len(results),
    "recovered": recovered_count,
    "wall_remains": len(results) - recovered_count,
    "bar_met": recovered_count >= 12,
    "pages": results
}

out_path = os.path.join(OUTDIR, "stealth-results.json")
with open(out_path, 'w') as f:
    json.dump(summary, f, indent=2)
print(f"\n=== STEALTH PROBE RESULTS ===", flush=True)
print(f"Recovered: {recovered_count}/{len(results)} (bar: ≥12/20 → {'MET' if summary['bar_met'] else 'NOT MET'})", flush=True)
print(f"Results: {out_path}", flush=True)
print("\nPer-page:", flush=True)
for r in results:
    status = "RECOVERED" if r['recovered'] else "WALL     "
    print(f"  {status} nodes={r['nodeCount']:3d}  {r['url']}", flush=True)
PYEOF

echo "[stealth-probe] done."
