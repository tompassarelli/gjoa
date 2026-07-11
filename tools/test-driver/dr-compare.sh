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
# STOCK Dark Reader control (fresh profile + AMO XPI, defaults = darken every
# site). The user's live profile runs DR in whitelist mode ("invert listed
# only") — using it as control benchmarked gjoa against a personal site list,
# not against Dark Reader (discovered 2026-07-11: example.com 0 darkreader
# styles / HN 9, same browser). Build/refresh: tools/test-driver/make-dr-stock-profile.sh
DPROF_SRC="/tmp/dr-stock-profile-src"
LPROF_SRC="$HOME/.mozilla/firefox/bgtdfn4f.default"   # FF profile, NO Dark Reader — the light baseline (3rd leg of the triple)
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')

mkdir -p "$OUT"; rm -f "$OUT"/*.png
echo "comparing $N sites -> $OUT"

# Per-arm shards: each arm runs SHARDS concurrent browser+renderer pairs.
# Port layout (spacing = SHARDS between arm bases, so ranges never overlap):
#   gjoa : 2887–(2887+SHARDS-1)
#   dr   : 2899–(2899+SHARDS-1)
#   light: 2911–(2911+SHARDS-1)
# 2887 is the first port above the 2860-2886 live mark-3 range.
SHARDS=6

run_arm() { # $1=label $2=bin $3=profile-src $4=port-base
  local label="$1" bin="$2" psrc="$3" port_base="$4"

  # Write a filtered URL list for this arm (head -N, no comments/blanks)
  local url_file="/tmp/cmp-$label-urls.txt"
  grep -vE '^\s*#|^\s*$' "$LIST" | head -n "$N" > "$url_file"

  # Light-baseline arm: force prefers-color-scheme:light so OS-dark doesn't make
  # sites auto-serve their own dark theme. 1 = light per content-override pref.
  local extra_prefs=""
  [ "$label" = light ] && extra_prefs='user_pref("layout.css.prefers-color-scheme.content-override",1);'

  # DR sentinel fires on shard 0's port after browser startup — once per arm,
  # not per shard, so one bad shard doesn't mask a whole-arm control failure.
  local sentinel=0
  [ "$label" = dr ] && sentinel=1

  DR_SENTINEL="$sentinel" EXTRA_PREFS="$extra_prefs" \
    "$REPO/tools/test-driver/render-arm.sh" "$label" "$bin" "$psrc" "$url_file" "$OUT" "$SHARDS" "$port_base"
}

# All three arms run concurrently (distinct port ranges, shared outdir, distinct prefixes).
echo "=== rendering gjoa + dark-reader + light-baseline arms concurrently ==="
run_arm gjoa  "$GBIN" "$GPROF_SRC" 2887 &
GPID=$!
run_arm dr    "$FF"   "$DPROF_SRC" 2899 &
DPID=$!
run_arm light "$FF"   "$LPROF_SRC" 2911 &
LPID=$!
wait "$GPID" "$DPID" "$LPID"

echo "triples rendered (sites with all 3 gjoa/dr/light tops):"
cnt=0; for f in "$OUT"/gjoa-*-1top.png; do [ -f "$f" ] || continue; s="${f##*/gjoa-}"; s="${s%-1top.png}"; [ -f "$OUT/dr-$s-1top.png" ] && [ -f "$OUT/light-$s-1top.png" ] && cnt=$((cnt+1)); done
echo "$cnt"
