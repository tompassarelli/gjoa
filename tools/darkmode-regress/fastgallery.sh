#!/usr/bin/env bash
# FAST parallel dark-mode gallery. Renders sites CONCURRENTLY (each its own
# marionette port + profile) with a short settle — the actor decides at
# DOMContentLoaded+2rAF (~1s), so 4s is plenty to validate a decision; 14s was
# pure waste. Runs headless + focus-safe via offscreen-gjoa.sh.
#
# Usage:  fastgallery.sh [mode] [settle_ms] [tag ...|all]
#   fastgallery.sh dark 4000 wikipedia cnn amazon     # iterate 3 sites
#   fastgallery.sh dark 6000 all                        # full corpus
cd /home/tom/code/gjoa
MODE="${1:-dark}"; SETTLE="${2:-4000}"; shift 2 2>/dev/null || shift $# 2>/dev/null
OUT=/tmp/gallery; mkdir -p "$OUT"
MAXPAR="${FASTGAL_PAR:-6}"

declare -A SITE=(
  [github]=https://github.com
  [hackernews]=https://news.ycombinator.com
  [wikipedia]=https://en.wikipedia.org/wiki/Firefox
  [stackoverflow]=https://stackoverflow.com
  [reddit]=https://www.reddit.com
  [youtube]=https://www.youtube.com
  [bbc]=https://www.bbc.com/news
  [cnn]=https://www.cnn.com
  [amazon]=https://www.amazon.com
  [mdn]=https://developer.mozilla.org/en-US/
  [nytimes]=https://www.nytimes.com
  [example]=https://example.com
)
ORDER=(github hackernews wikipedia stackoverflow reddit youtube bbc cnn amazon mdn nytimes example)

TAGS=("$@")
if [ "${#TAGS[@]}" -eq 0 ] || [ "${TAGS[0]}" = "all" ]; then TAGS=("${ORDER[@]}"); fi

render_one() {
  local idx="$1" tag="$2" url="${SITE[$2]}"
  local port=$((2840 + idx))
  local P; P=$(mktemp -d /tmp/fgal-XXXX)
  cat > "$P/user.js" <<EOF
user_pref("gjoa.darkmode.enabled", true);
user_pref("gjoa.darkmode.mode", "$MODE");
user_pref("gjoa.darkmode.force", false);
user_pref("gjoa.darkmode.normalize.enabled", true);
user_pref("marionette.port", $port);
user_pref("toolkit.startup.max_resumed_crashes", -1);
EOF
  GJOA_ALLOW_INSECURE=1 bash tools/test-driver/offscreen-gjoa.sh \
    -no-remote -profile "$P" -marionette --remote-allow-system-access about:blank \
    >/dev/null 2>&1 &
  local BPID=$!
  local i
  for i in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && { exec 3>&-; break; }; sleep 0.25; done
  python3 tools/test-driver/marionette_shot.py --port "$port" --url "$url" --settle-ms "$SETTLE" --out "$OUT/$tag.png" >/dev/null 2>&1
  kill "$BPID" 2>/dev/null; wait "$BPID" 2>/dev/null
  rm -rf "$P"
}

echo "=== fastgallery: mode=$MODE settle=${SETTLE}ms par=$MAXPAR sites=${#TAGS[@]} ==="
i=0
for tag in "${TAGS[@]}"; do
  [ -n "${SITE[$tag]}" ] || { echo "skip unknown: $tag"; continue; }
  render_one "$i" "$tag" &
  i=$((i+1))
  while [ "$(jobs -r | wc -l)" -ge "$MAXPAR" ]; do wait -n 2>/dev/null || sleep 0.2; done
done
wait

printf '%-14s %-6s %-7s %-7s %-6s %s\n' SITE COV MEDL* LEAK M VERDICT
for tag in "${TAGS[@]}"; do
  [ -f "$OUT/$tag.png" ] || { printf '%-14s  (no render)\n' "$tag"; continue; }
  bun tools/darkmode-regress/scorer.js "$OUT/$tag.png" 2>/dev/null \
    | sed 's/cov=//;s/medL\*=//;s/leak=//;s/M=//' \
    | awk -v t="$tag" '{printf "%-14s %-6s %-7s %-7s %-6s %s\n", t, $2, $3, $4, $5, $6}'
done
echo "=== thumbs: $OUT/*.png ==="
