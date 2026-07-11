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
DPROF_SRC="$HOME/.mozilla/firefox/tom"                # FF profile with Dark Reader ACTIVE — the control
LPROF_SRC="$HOME/.mozilla/firefox/bgtdfn4f.default"   # FF profile, NO Dark Reader — the light baseline (3rd leg of the triple)
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')

mkdir -p "$OUT"; rm -f "$OUT"/*.png
URLS=$(grep -vE '^\s*#|^\s*$' "$LIST" | head -n "$N" | paste -sd,)
echo "comparing $N sites -> $OUT"

# Timeouts must scale with N: the FF arms run ~32s/site (DR extension + system FF),
# gjoa ~22s/site. Fixed 2400s killed the FF browsers at site ~68 of a 104-site run
# (2026-07-11 baseline: BrokenPipe mid-corpus) while gjoa squeaked under — a pace
# divergence a 3-site smoke test cannot expose. 45s/site + slack covers the slow arm.
TMO_BROWSER=$((N * 45 + 600))
TMO_RENDER=$((N * 45 + 300))

run_arm() { # $1=label $2=bin $3=profile-src $4=port $5..=extra bin args
  local label="$1" bin="$2" psrc="$3" port="$4"; shift 4
  local dst="/tmp/cmp-$label"; rm -rf "$dst"; mkdir -p "$dst"
  rsync -a "${RSX[@]}" "$psrc/" "$dst/" 2>/dev/null
  # HW (amdgpu) rendering. The 2026-06 gfx1150 CWSR/MES ring-timeout hangs were fixed at the
  # root via kernel param amdgpu.cwsr_enable=0, so the GPU is safe again. If those hangs ever
  # return, force software: add gfx.webrender.software=true + layers.acceleration.disabled=true
  # to the prefs below and LIBGL_ALWAYS_SOFTWARE=1 to the env line.
  printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\n' "$port" >> "$dst/user.js"
  # Light-baseline arm: pin the site's LIGHT rendering (no Dark Reader; force prefers-color-scheme:light so
  # OS-dark doesn't make sites auto-serve their own dark theme). 1 = light per layout.css.prefers-color-scheme.content-override.
  [ "$label" = light ] && printf 'user_pref("layout.css.prefers-color-scheme.content-override",1);\n' >> "$dst/user.js"
  # GJOA_DEV_LOADER only for the dev obj binary (loose chrome); the nix binary bakes it.
  local dev=""; case "$bin" in *obj-*) dev="GJOA_DEV_LOADER=1";; esac
  env MOZ_HEADLESS=1 GJOA_ALLOW_INSECURE=1 $dev timeout "$TMO_BROWSER" "$bin" -no-remote -profile "$dst" "$@" -marionette -remote-allow-system-access about:blank >"/tmp/cmp-$label.log" 2>&1 &
  local pid=$!
  sleep 14
  timeout "$TMO_RENDER" python3 "$REPO/tools/test-driver/render-darkmode.py" --port "$port" --prefix "$label" --outdir "$OUT" --urls "$URLS" --settle 18
  kill "$pid" 2>/dev/null
}

# All three arms run concurrently (distinct ports/profiles, shared outdir with distinct prefixes) —
# collapses wall-time, which matters at N=200. 3 headless browsers is well within budget on this box.
echo "=== rendering gjoa + dark-reader + light-baseline arms concurrently ==="
run_arm gjoa  "$GBIN" "$GPROF_SRC" 2873 &
GPID=$!
run_arm dr    "$FF"   "$DPROF_SRC" 2899 &
DPID=$!
run_arm light "$FF"   "$LPROF_SRC" 2911 &
LPID=$!
wait "$GPID" "$DPID" "$LPID"

echo "triples rendered (sites with all 3 gjoa/dr/light tops):"
cnt=0; for f in "$OUT"/gjoa-*-1top.png; do [ -f "$f" ] || continue; s="${f##*/gjoa-}"; s="${s%-1top.png}"; [ -f "$OUT/dr-$s-1top.png" ] && [ -f "$OUT/light-$s-1top.png" ] && cnt=$((cnt+1)); done
echo "$cnt"
