#!/usr/bin/env bash
# Acceptance harness: render N sites in BOTH gjoa (current dev binary, real profile) and
# Firefox+DarkReader (control), into paired screenshots for an Opus judge. The bar:
# gjoa's dark mode >= Dark Reader on every site. Pairs are OUT/gjoa-<slug>-{1top,2mid}.png
# vs OUT/dr-<slug>-{1top,2mid}.png — feed to tools/test-driver/dr-judge.wf.js.
#
# Usage: tools/test-driver/dr-compare.sh [site-list] [N] [outdir]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LIST="${1:-$REPO/configs/dark-mode-200.txt}"
N="${2:-200}"
OUT="${3:-/tmp/dr-compare}"
# Prefer the native nix binary (baked chrome — the deliverable); fall back to the dev obj binary.
GBIN="$REPO/result/bin/gjoa"; [ -x "$GBIN" ] || GBIN="$(echo "$REPO"/engine/obj-*/dist/bin/gjoa)"
FF=/run/current-system/sw/bin/firefox
GPROF_SRC="$HOME/.config/mozilla/gjoa/4859ptgk.default-default"
DPROF_SRC="$HOME/.mozilla/firefox/bgtdfn4f.default"
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')

mkdir -p "$OUT"; rm -f "$OUT"/*.png
URLS=$(grep -vE '^\s*#|^\s*$' "$LIST" | head -n "$N" | paste -sd,)
echo "comparing $N sites -> $OUT"

run_arm() { # $1=label $2=bin $3=profile-src $4=port $5..=extra bin args
  local label="$1" bin="$2" psrc="$3" port="$4"; shift 4
  local dst="/tmp/cmp-$label"; rm -rf "$dst"; mkdir -p "$dst"
  rsync -a "${RSX[@]}" "$psrc/" "$dst/" 2>/dev/null
  # gfx.webrender.software + LIBGL_ALWAYS_SOFTWARE below force CPU (llvmpipe) compositing:
  # headless renders must NEVER touch the amdgpu GPU. Bulk/parallel browser instances on
  # amdgpu trip ring-timeout/SQC-page-fault hangs that froze the whole box (2026-06 crashes).
  printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\nuser_pref("gfx.webrender.software",true);\nuser_pref("gfx.canvas.accelerated",false);\nuser_pref("media.hardware-video-decoding.enabled",false);\nuser_pref("layers.acceleration.disabled",true);\n' "$port" >> "$dst/user.js"
  # GJOA_DEV_LOADER only for the dev obj binary (loose chrome); the nix binary bakes it.
  local dev=""; case "$bin" in *obj-*) dev="GJOA_DEV_LOADER=1";; esac
  env MOZ_HEADLESS=1 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe GJOA_ALLOW_INSECURE=1 $dev timeout 2400 "$bin" -no-remote -profile "$dst" "$@" -marionette -remote-allow-system-access about:blank >"/tmp/cmp-$label.log" 2>&1 &
  local pid=$!
  sleep 14
  timeout 3000 python3 "$REPO/tools/test-driver/render-darkmode.py" --port "$port" --prefix "$label" --outdir "$OUT" --urls "$URLS" --settle 18
  kill "$pid" 2>/dev/null
}

# Both arms run concurrently (distinct ports/profiles/outdirs) — halves wall-time, which
# matters at N=200. 2 headless browsers is well within budget.
echo "=== rendering gjoa + dark-reader arms concurrently ==="
run_arm gjoa "$GBIN" "$GPROF_SRC" 2873 &
GPID=$!
run_arm dr "$FF" "$DPROF_SRC" 2899 &
DPID=$!
wait "$GPID" "$DPID"

echo "pairs rendered:"; ls "$OUT"/gjoa-*-1top.png 2>/dev/null | wc -l
