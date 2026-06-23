#!/usr/bin/env bash
# Tiered dark-mode visual-test driver for gjoa.
#
#   dm:check (default / lightweight): render each manifest target in ENGINE mode
#     at the default darkness (bgLightness 16), measure mean luminance + the bg
#     pixel, and ASSERT the result is in the dark band. PASS/FAIL table; nonzero
#     exit if any assert fails. Target wall-time < ~2 min.
#
#   dm:check --deep (comprehensive): sweep {modes} x {bgLightness} x {window
#     sizes} over the same targets, capture + measure each, and write a results
#     matrix (+ thumbnails). The "flip a switch for deeper coverage" tier.
#
# Rendering needs the mach devShell so the binary finds its runtime libs:
#   nix develop .#mach -c bash tools/dm-driver/dm-check.sh
#   nix develop .#mach -c bash tools/dm-driver/dm-check.sh --deep
# (the `dm:check` / `dm:check:deep` package.json scripts wrap this.)
#
# `gjoa`'s `-screenshot` renders a page then EXITS — no long-lived browser, no
# teardown problem. Paint-time inversion shows even before page JS runs, so this
# captures the engine dark band reliably for both local and remote targets.
#
# Image analysis (magick) runs in the default shell; only the render step needs
# the devShell. The script auto-detects whether it is inside the devShell.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${DM_BIN:-$REPO/engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa}"
MANIFEST="${DM_MANIFEST:-$REPO/tools/dm-driver/manifest.json}"
OUTDIR="${DM_OUTDIR:-/tmp/dm-check}"
DEEP=0
[ "${1:-}" = "--deep" ] && DEEP=1

if [ ! -x "$BIN" ]; then
  echo "✗ gjoa binary not found at $BIN" >&2
  exit 3
fi
if [ ! -f "$MANIFEST" ]; then
  echo "✗ manifest not found at $MANIFEST" >&2
  exit 3
fi
command -v magick >/dev/null 2>&1 || { echo "✗ magick not on PATH" >&2; exit 3; }

mkdir -p "$OUTDIR"

# --- mode -> prefs (mirrors src/gjoa/chrome/bjs/dark-mode/index.bjs apply-mode!) ---
# Emits the user.js lines for a given mode. Engine forces light + invert so the
# engine darkens everything to the bgLightness floor (Dark-Reader-style).
mode_prefs() {
  case "$1" in
    engine) echo 'user_pref("layout.css.prefers-color-scheme.content-override", 1);
user_pref("gjoa.darkmode.invert.enabled", true);' ;;
    system|hybrid|auto) echo 'user_pref("layout.css.prefers-color-scheme.content-override", 0);
user_pref("gjoa.darkmode.invert.enabled", false);' ;;
    filter) echo 'user_pref("layout.css.prefers-color-scheme.content-override", 0);
user_pref("gjoa.darkmode.invert.enabled", false);' ;;
    off) echo 'user_pref("layout.css.prefers-color-scheme.content-override", 2);
user_pref("gjoa.darkmode.invert.enabled", false);' ;;
    *) echo 'user_pref("layout.css.prefers-color-scheme.content-override", 1);
user_pref("gjoa.darkmode.invert.enabled", true);' ;;
  esac
}

# Write a user.js for a (mode, bgLightness) combo into profile dir $1.
write_prefs() {
  local prof="$1" mode="$2" bg="$3"
  {
    echo 'user_pref("toolkit.startup.max_resumed_crashes", -1);'
    echo 'user_pref("browser.shell.checkDefaultBrowser", false);'
    echo 'user_pref("gjoa.darkmode.enabled", true);'
    echo "user_pref(\"gjoa.darkmode.mode\", \"$mode\");"
    echo "user_pref(\"gjoa.darkmode.invert.bgLightness\", $bg);"
    echo 'user_pref("gjoa.darkmode.invert.fgLightness", 92);'
    mode_prefs "$mode"
  } > "$prof/user.js"
}

# Render one target. Args: out_png url_or_htmlfile is_local mode bg winsize timeout
# Retries up to RENDER_TRIES times when the PNG comes back empty — SPA sites
# (reddit) sometimes client-redirect right as the Screenshot actor fires
# ("Actor 'Screenshot' destroyed before query"), which is a timing race, not a
# real dark-mode failure.
RENDER_TRIES="${DM_RENDER_TRIES:-3}"
render() {
  local out="$1" target="$2" is_local="$3" mode="$4" bg="$5" win="$6" tmo="$7"
  local url="$target"
  if [ "$is_local" = "1" ]; then url="file://$target"; fi
  local rc=0 try sz
  for try in $(seq 1 "$RENDER_TRIES"); do
    local prof; prof=$(mktemp -d "$OUTDIR/prof.XXXXXX")
    write_prefs "$prof" "$mode" "$bg"
    timeout "$tmo" "$BIN" --headless -profile "$prof" \
      -screenshot "$out" --window-size="$win" "$url" \
      > "$out.log" 2>&1
    rc=$?
    rm -rf "$prof"
    sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$rc" -eq 0 ] && [ "$sz" -ge 1000 ]; then return 0; fi
    [ "$try" -lt "$RENDER_TRIES" ] && sleep 1
  done
  return "${rc:-1}"
}

# Measure: prints "meanLum|bgPixel" for a png.
#
# NOTE on luminance: ImageMagick 7's `-colorspace Gray` / `-grayscale` convert
# through LINEAR light, which massively inflates the mean for dark images (a
# #0d0d0d page reads ~0.53 instead of ~0.05) — that made the naive
# `-colorspace Gray -format '%[fx:mean]'` recipe (used by the older dm-shoot.sh)
# unusable as a "is it dark?" gate. We instead read the per-channel sRGB means
# directly (no linearization) and combine with Rec.709 weights, which gives the
# honest perceptual brightness (0..1) — #0d0d0d -> ~0.05.
measure() {
  local png="$1" sx="$2"
  local r g b bg
  r=$(magick "$png" -channel R -separate -format '%[fx:mean]\n' info: 2>/dev/null | head -1)
  g=$(magick "$png" -channel G -separate -format '%[fx:mean]\n' info: 2>/dev/null | head -1)
  b=$(magick "$png" -channel B -separate -format '%[fx:mean]\n' info: 2>/dev/null | head -1)
  local mean
  mean=$(python3 -c "print('%.4f' % (0.2126*float('$r') + 0.7152*float('$g') + 0.0722*float('$b')))" 2>/dev/null)
  bg=$(magick "$png" -format "%[pixel:p{$sx}]" info: 2>/dev/null)
  echo "$mean|$bg"
}

# Convert an sRGB "srgb(r,g,b)" or "#rrggbb" magick pixel into #rrggbb hex.
pixel_to_hex() {
  python3 - "$1" <<'PY'
import sys, re
s = sys.argv[1].strip()
m = re.match(r'#([0-9a-fA-F]{6})', s)
if m:
    print('#' + m.group(1).lower()); sys.exit(0)
nums = re.findall(r'[\d.]+', s)
if len(nums) >= 3:
    def c(x):
        x = float(x)
        if x <= 1.0 and '.' in str(x): x *= 255  # fractional channel
        return max(0, min(255, int(round(x))))
    r, g, b = c(nums[0]), c(nums[1]), c(nums[2])
    print('#%02x%02x%02x' % (r, g, b))
else:
    print(s)
PY
}

# Per-channel max distance between two #rrggbb hexes, normalized 0..1.
hex_dist() {
  python3 - "$1" "$2" <<'PY'
import sys
def rgb(h):
    h = h.lstrip('#'); return [int(h[i:i+2], 16) for i in (0, 2, 4)]
a, b = rgb(sys.argv[1]), rgb(sys.argv[2])
print('%.4f' % (max(abs(x-y) for x, y in zip(a, b)) / 255.0))
PY
}

# --- parse manifest into shell-friendly TSV lines via python3 ---
# Each target line: id<TAB>kind<TAB>payload<TAB>meanLumMax<TAB>bgHex<TAB>bgTol<TAB>bgXY
read_manifest() {
  python3 - "$MANIFEST" "$OUTDIR" <<'PY'
import sys, json, os
mf, outdir = sys.argv[1], sys.argv[2]
m = json.load(open(mf))
d = m.get("defaults", {})
defWin = d.get("windowSize", "1280,800")
defTmo = d.get("timeoutSec", 90)
defMean = d.get("meanLumMax", 0.35)
defXY = d.get("bgSampleXY", "20,20")
# Globals line first.
print("\t".join(["#G", defWin, str(defTmo), str(defMean), defXY]))
# Deep axes line.
dp = m.get("deep", {})
print("\t".join(["#D",
                 ",".join(dp.get("modes", ["engine"])),
                 ",".join(str(x) for x in dp.get("bgLightness", [16])),
                 ";".join(dp.get("windowSizes", [defWin]))]))
for t in m.get("targets", []):
    tid = t["id"]
    kind = t.get("kind", "url")
    if kind == "local":
        path = os.path.join(outdir, f"{tid}.html")
        open(path, "w").write(t["html"])
        payload = path
    else:
        payload = t["url"]
    print("\t".join([
        tid, kind, payload,
        str(t.get("meanLumMax", defMean)),
        t.get("bgHex", ""),
        str(t.get("bgTolerance", "")),
        t.get("bgSampleXY", defXY),
    ]))
PY
}

MAP=$(read_manifest)
GLINE=$(echo "$MAP" | grep -m1 '^#G')
DLINE=$(echo "$MAP" | grep -m1 '^#D')
IFS=$'\t' read -r _ DEF_WIN DEF_TMO DEF_MEAN DEF_XY <<< "$GLINE"
IFS=$'\t' read -r _ D_MODES D_BGS D_WINS <<< "$DLINE"
TARGETS=$(echo "$MAP" | grep -v '^#')

fail_count=0
total=0

# pretty PASS/FAIL coloring (skip if not a tty / NO_COLOR)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; Z=$'\e[0m'
else
  G=""; R=""; Y=""; Z=""
fi

# ---------------- lightweight tier ----------------
run_check() {
  printf '%s\n' "=== dm:check — engine mode, bgLightness 16, ${DEF_WIN} ==="
  printf '%-12s %-9s %-9s %-9s %-7s %s\n' TARGET MEAN MAXMEAN BG-PIXEL BG-OK RESULT
  printf '%s\n' "------------------------------------------------------------------------"
  while IFS=$'\t' read -r tid kind payload meanMax bgHex bgTol bgXY; do
    [ -z "$tid" ] && continue
    total=$((total+1))
    local is_local=0; [ "$kind" = "local" ] && is_local=1
    local out="$OUTDIR/check-$tid.png"
    render "$out" "$payload" "$is_local" engine 16 "$DEF_WIN" "$DEF_TMO"
    local rc=$? sz; sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$rc" -ne 0 ] || [ "$sz" -lt 1000 ]; then
      printf '%-12s %-9s %-9s %-9s %-7s %s\n' "$tid" "-" "$meanMax" "-" "-" "${R}FAIL(render rc=$rc sz=$sz)${Z}"
      fail_count=$((fail_count+1)); continue
    fi
    local res; res=$(measure "$out" "$bgXY")
    local mean="${res%%|*}" bgpx="${res#*|}"
    local bghex; bghex=$(pixel_to_hex "$bgpx")
    local meanOk bgOk="-" pass=1
    meanOk=$(python3 -c "print(1 if float('$mean') <= float('$meanMax') else 0)")
    [ "$meanOk" = "0" ] && pass=0
    if [ -n "$bgHex" ] && [ -n "$bgTol" ]; then
      local dist; dist=$(hex_dist "$bghex" "$bgHex")
      bgOk=$(python3 -c "print('yes' if float('$dist') <= float('$bgTol') else 'no')")
      [ "$bgOk" = "no" ] && pass=0
    fi
    local verdict
    if [ "$pass" = "1" ]; then verdict="${G}PASS${Z}"; else verdict="${R}FAIL${Z}"; fail_count=$((fail_count+1)); fi
    printf '%-12s %-9.4f %-9s %-9s %-7s %s\n' "$tid" "$mean" "$meanMax" "$bghex" "$bgOk" "$verdict"
  done <<< "$TARGETS"
  printf '%s\n' "------------------------------------------------------------------------"
  if [ "$fail_count" -eq 0 ]; then
    printf '%s%d/%d PASS%s — all targets in dark band. shots: %s\n' "$G" "$((total-fail_count))" "$total" "$Z" "$OUTDIR"
  else
    printf '%s%d/%d FAILED%s. shots: %s\n' "$R" "$fail_count" "$total" "$Z" "$OUTDIR"
  fi
}

# ---------------- deep tier ----------------
run_deep() {
  local matrix="$OUTDIR/deep-matrix.tsv"
  local thumbs="$OUTDIR/thumbs"; mkdir -p "$thumbs"
  : > "$matrix"
  echo -e "target\tmode\tbg\twindow\tmeanLum\tbgPixel\tmeanMax\tresult" >> "$matrix"
  printf '%s\n' "=== dm:check --deep — modes x bgLightness x window x targets ==="
  printf '%-12s %-7s %-3s %-9s %-9s %-9s %s\n' TARGET MODE BG WINDOW MEAN BG-PIXEL RESULT
  printf '%s\n' "------------------------------------------------------------------------------"
  IFS=',' read -ra MODES <<< "$D_MODES"
  IFS=',' read -ra BGS <<< "$D_BGS"
  IFS=';' read -ra WINS <<< "$D_WINS"
  while IFS=$'\t' read -r tid kind payload meanMax bgHex bgTol bgXY; do
    [ -z "$tid" ] && continue
    local is_local=0; [ "$kind" = "local" ] && is_local=1
    for mode in "${MODES[@]}"; do
      for bg in "${BGS[@]}"; do
        for win in "${WINS[@]}"; do
          total=$((total+1))
          local wt="${win/,/x}"
          local out="$thumbs/$tid--$mode--bg$bg--$wt.png"
          render "$out" "$payload" "$is_local" "$mode" "$bg" "$win" "$DEF_TMO"
          local rc=$? sz; sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
          if [ "$rc" -ne 0 ] || [ "$sz" -lt 1000 ]; then
            printf '%-12s %-7s %-3s %-9s %-9s %-9s %s\n' "$tid" "$mode" "$bg" "$wt" "-" "-" "${R}ERR${Z}"
            echo -e "$tid\t$mode\t$bg\t$wt\t-\t-\t$meanMax\tERR(rc=$rc)" >> "$matrix"
            fail_count=$((fail_count+1)); continue
          fi
          local res; res=$(measure "$out" "$bgXY")
          local mean="${res%%|*}" bgpx="${res#*|}"
          local bghex; bghex=$(pixel_to_hex "$bgpx")
          # Only engine mode carries the hard dark-band assert; the others are
          # captured for visual review (system/auto on a light site stays light).
          local verdict
          if [ "$mode" = "engine" ]; then
            local ok; ok=$(python3 -c "print(1 if float('$mean') <= float('$meanMax') else 0)")
            if [ "$ok" = "1" ]; then verdict="${G}PASS${Z}"; else verdict="${R}FAIL${Z}"; fail_count=$((fail_count+1)); fi
          else
            verdict="${Y}capt${Z}"
          fi
          printf '%-12s %-7s %-3s %-9s %-9.4f %-9s %s\n' "$tid" "$mode" "$bg" "$wt" "$mean" "$bghex" "$verdict"
          echo -e "$tid\t$mode\t$bg\t$wt\t$mean\t$bghex\t$meanMax\t$(echo "$verdict" | sed 's/\x1b\[[0-9;]*m//g')" >> "$matrix"
        done
      done
    done
  done <<< "$TARGETS"
  printf '%s\n' "------------------------------------------------------------------------------"
  printf 'matrix: %s   thumbs: %s\n' "$matrix" "$thumbs"
  if [ "$fail_count" -eq 0 ]; then
    printf '%sengine-mode asserts: all PASS%s (non-engine rows are captures, not asserts)\n' "$G" "$Z"
  else
    printf '%s%d engine-mode assert(s) FAILED%s\n' "$R" "$fail_count" "$Z"
  fi
}

if [ "$DEEP" = "1" ]; then run_deep; else run_check; fi

[ "$fail_count" -eq 0 ] || exit 1
exit 0
