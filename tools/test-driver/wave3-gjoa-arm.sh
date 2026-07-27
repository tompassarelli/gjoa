#!/usr/bin/env bash
# Wave-3 W-A helper: render the GJOA arm ONLY, using the dev (obj) binary + loose
# chrome (GJOA_DEV_LOADER) so edited actor JS is live after `gjoa sync`. DR/light
# arms are unchanged by actor edits — reuse baseline refs for comparison.
# Usage: wave3-gjoa-arm.sh <outdir> <url1,url2,...>
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?outdir}"; URLS="${2:?comma-sep urls}"
PORT="${PORT:-2957}"
GBIN="$REPO/engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"
GPROF_SRC="$HOME/.config/mozilla/gjoa/4859ptgk.default-default"
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')
mkdir -p "$OUT"
dst="/tmp/wave3-gjoa-prof"; rm -rf "$dst"; mkdir -p "$dst"
rsync -a "${RSX[@]}" "$GPROF_SRC/" "$dst/" 2>/dev/null
printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\n' "$PORT" >> "$dst/user.js"
env MOZ_HEADLESS=1 GJOA_ALLOW_INSECURE=1 GJOA_DEV_LOADER=1 timeout 400 "$GBIN" -no-remote -profile "$dst" -marionette -remote-allow-system-access about:blank >"/tmp/wave3-gjoa.log" 2>&1 &
pid=$!
sleep 14
timeout 380 python3 "$REPO/tools/test-driver/render-darkmode.py" --port "$PORT" --prefix gjoa --outdir "$OUT" --urls "$URLS" --settle 18
kill "$pid" 2>/dev/null
echo "rendered -> $OUT"
ls "$OUT"/gjoa-*-1top.png 2>/dev/null | wc -l
