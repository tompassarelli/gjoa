#!/usr/bin/env bash
# render-arm.sh — K-way sharded headless renderer for one dark-mode eval arm.
#
# Usage:
#   render-arm.sh <label> <binary> <profile-src> <url-list-file> <outdir> [shards=6] [port-base=3000]
#
# Port allocation:
#   Shard i uses port (port-base + i). Caller must space port-base values by ≥ shards
#   between concurrent arms so port ranges don't overlap.
#   Example with shards=6: arm-A at 2887 (2887-2892), arm-B at 2899 (2899-2904),
#   arm-C at 2911 (2911-2916) — each gap is exactly shards (6).
#
# Env vars:
#   EXTRA_PREFS   — multi-line user_pref(...) block appended to every shard's user.js
#   DR_SENTINEL   — set to 1 to run dr-sentinel.py on port-base after browser startup

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

if [ $# -lt 5 ]; then
  echo "Usage: render-arm.sh <label> <binary> <profile-src> <url-list-file> <outdir> [shards=6] [port-base=3000]" >&2
  exit 1
fi

LABEL="$1"
BIN="$2"
PROF_SRC="$3"
URL_LIST="$4"
OUTDIR="$5"
SHARDS="${6:-6}"
PORT_BASE="${7:-3000}"

# STEALTH=1 — drop MOZ_HEADLESS; run under the live Wayland/X compositor instead.
# Many bot-walls detect headless via canvas/WebGL fingerprint; real-profile rendering
# passes those checks while marionette (and navigator.webdriver=true) stays intact.
# Sites that still wall on the webdriver flag are honestly quarantined (no injection).
STEALTH="${STEALTH:-0}"

RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' \
     --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')

mkdir -p "$OUTDIR"

URLS_ALL=$(grep -vE '^\s*#|^\s*$' "$URL_LIST")
TOTAL=$(printf '%s\n' "$URLS_ALL" | grep -c .)

# Timeouts scale per-shard: each shard handles ~ceil(N/K) URLs; 45s/url + slack
N_PER=$(( (TOTAL + SHARDS - 1) / SHARDS ))
TMO_BROWSER=$(( N_PER * 45 + 600 ))
TMO_RENDER=$(( N_PER * 45 + 300 ))

echo "[$LABEL] $TOTAL URLs → $SHARDS shards, ports ${PORT_BASE}-$((PORT_BASE+SHARDS-1)), tmo browser=${TMO_BROWSER}s render=${TMO_RENDER}s"

BPIDS=()
cleanup() {
  for pid in "${BPIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# Dev loader: only for loose-chrome obj builds; baked nix binary doesn't need it
DEV_EXTRA=""
case "$BIN" in *obj-*) DEV_EXTRA="GJOA_DEV_LOADER=1";; esac

# Build launch env: headless (normal) or real-display (stealth)
if [ "${STEALTH}" = "1" ]; then
  # Drop MOZ_HEADLESS; inherit the live compositor from the calling env.
  # WAYLAND_DISPLAY / DISPLAY must be set in the caller's environment.
  # MOZ_APP_REMOTINGNAME sets the Wayland app-id -> niri window-rule routes
  # these windows to the "render" workspace, unfocused (owner never sees them).
  LAUNCH_ENV="GJOA_ALLOW_INSECURE=1 MOZ_APP_REMOTINGNAME=gjoa-render"
  [ -n "${DEV_EXTRA:-}" ] && LAUNCH_ENV="${LAUNCH_ENV} ${DEV_EXTRA}"
  echo "[$LABEL] STEALTH mode: real display (WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset} DISPLAY=${DISPLAY:-unset})"
else
  LAUNCH_ENV="MOZ_HEADLESS=1 GJOA_ALLOW_INSECURE=1"
  [ -n "${DEV_EXTRA:-}" ] && LAUNCH_ENV="${LAUNCH_ENV} ${DEV_EXTRA}"
fi

# Clone profile K times and launch K browsers
for i in $(seq 0 $((SHARDS-1))); do
  PORT=$(( PORT_BASE + i ))
  DST="/tmp/ra-$LABEL-$i"
  rm -rf "$DST"; mkdir -p "$DST"
  rsync -a "${RSX[@]}" "$PROF_SRC/" "$DST/" 2>/dev/null
  printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\n' "$PORT" >> "$DST/user.js"
  if [ -n "${EXTRA_PREFS:-}" ]; then
    printf '%s\n' "$EXTRA_PREFS" >> "$DST/user.js"
  fi
  # HW (amdgpu) rendering; amdgpu.cwsr_enable=0 defuses the ring-timeout hang.
  # If hangs return: add gfx.webrender.software=true + layers.acceleration.disabled=true
  # to EXTRA_PREFS and LIBGL_ALWAYS_SOFTWARE=1 to the launch env.
  env ${LAUNCH_ENV} timeout "$TMO_BROWSER" "$BIN" \
    -no-remote -profile "$DST" -marionette -remote-allow-system-access about:blank \
    > "/tmp/ra-$LABEL-$i.log" 2>&1 &
  BPIDS+=($!)
  echo "[$LABEL] shard $i: browser pid ${BPIDS[-1]} port $PORT"
done

# Wait for browser startup: FF+DR extension needs ~35s, gjoa needs ~14s
case "$BIN" in *firefox*) BOOT=35;; *) BOOT=14;; esac
echo "[$LABEL] waiting ${BOOT}s for browser startup..."
sleep "$BOOT"

# DR sentinel: fires on shard 0's port, once per arm (not per shard)
if [ "${DR_SENTINEL:-0}" = "1" ]; then
  echo "[$LABEL] dr-sentinel check on port $PORT_BASE..."
  if ! python3 "$REPO/tools/test-driver/dr-sentinel.py" --port "$PORT_BASE"; then
    echo "FATAL: [$LABEL] Dark Reader sentinel FAILED on port $PORT_BASE — aborting arm (no invalid control data)" >&2
    exit 1
  fi
  echo "[$LABEL] sentinel OK"
fi

# Split URLs round-robin across shards and launch K renderers concurrently
RPIDS=()
for i in $(seq 0 $((SHARDS-1))); do
  PORT=$(( PORT_BASE + i ))
  SHARD_URLS=$(printf '%s\n' "$URLS_ALL" | awk -v s="$i" -v k="$SHARDS" '(NR-1) % k == s')
  [ -z "$SHARD_URLS" ] && { echo "[$LABEL] shard $i: empty, skipping"; continue; }
  SHARD_URL_CSV=$(printf '%s\n' "$SHARD_URLS" | paste -sd,)
  SHARD_N=$(printf '%s\n' "$SHARD_URLS" | grep -c .)
  echo "[$LABEL] shard $i: $SHARD_N URLs → port $PORT"
  timeout "$TMO_RENDER" python3 "$REPO/tools/test-driver/render-darkmode.py" \
    --port "$PORT" --prefix "$LABEL" --outdir "$OUTDIR" \
    --urls "$SHARD_URL_CSV" --settle 18 \
    > "/tmp/ra-$LABEL-render-$i.log" 2>&1 &
  RPIDS+=($!)
done

wait "${RPIDS[@]:-}"

# Per-shard counts (from renderer stderr captured in logs)
echo "=== [$LABEL] per-shard counts ==="
for i in $(seq 0 $((SHARDS-1))); do
  SHARD_URLS=$(printf '%s\n' "$URLS_ALL" | awk -v s="$i" -v k="$SHARDS" '(NR-1) % k == s')
  [ -z "$SHARD_URLS" ] && { echo "  shard $i: 0/0 (empty)"; continue; }
  SHARD_N=$(printf '%s\n' "$SHARD_URLS" | grep -c .)
  SHARD_RENDERED=$(grep -c "  ${LABEL}:" "/tmp/ra-$LABEL-render-$i.log" 2>/dev/null || true)
  echo "  shard $i: $SHARD_RENDERED/$SHARD_N"
done

# Total rendered and miss list — slug logic must match render-darkmode.py exactly
echo "=== [$LABEL] total + misses ==="
python3 - "$LABEL" "$OUTDIR" "$URL_LIST" <<'PYEOF'
import os, sys
label, outdir, url_list = sys.argv[1], sys.argv[2], sys.argv[3]
with open(url_list) as f:
    urls = [l.strip() for l in f if l.strip() and not l.startswith('#')]
def slug(url):
    return ''.join(c if c.isalnum() else '_' for c in url.replace('https://','').replace('www.',''))[:32]
hits = {f[len(label)+1:-9] for f in os.listdir(outdir) if f.startswith(label+'-') and f.endswith('-1top.png')}
misses = [(url, slug(url)) for url in urls if slug(url) not in hits]
print(f'  rendered: {len(urls)-len(misses)}/{len(urls)}')
if misses:
    print(f'  misses ({len(misses)}):')
    for url, s in misses:
        print(f'    MISS: {url}')
else:
    print('  no misses')
PYEOF
