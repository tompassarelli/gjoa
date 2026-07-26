#!/usr/bin/env bash
# Launch a REAL-GUI gjoa (stealth: routed to hidden niri "render" workspace via
# app-id gjoa-render) with the dev chrome loader (current source), vertical
# revamp mode expanded, drive urlbar-teardown-capture.py, tear down.
set -u
ROOT="/home/tom/code/gjoa"
BIN="$ROOT/engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"
PROBE="$ROOT/tools/test-driver/urlbar-teardown-capture.py"
PORT="${PORT:-3086}"
OUTDIR="${OUTDIR:-/tmp/urlbar-td}"
[ -x "$BIN" ] || { echo "no dev binary at $BIN"; exit 1; }

NIXBIN="$ROOT/result/bin/gjoa"
if [ -r "$NIXBIN" ]; then
  LIBS=$(grep -oP "'/nix/store/[^']*'" "$NIXBIN" | tr -d "'" | sort -u | tr '\n' ':')
  export LD_LIBRARY_PATH="${LIBS%:}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

arm_render_ws() {
  command -v niri >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  local ws; ws=$(niri msg --json workspaces 2>/dev/null) || return 0
  printf '%s' "$ws" | jq -e 'any(.[]; .name == "render")' >/dev/null && return 0
  local idx
  idx=$(printf '%s' "$ws" | jq -r '
    (first(.[] | select(.is_focused)) | .output) as $out
    | [.[] | select(.output == $out and .active_window_id == null and .name == null)]
    | (max_by(.idx) | .idx) // empty')
  [ -n "$idx" ] && niri msg action set-workspace-name --workspace "$idx" render
}
disarm_render_ws() {
  command -v niri >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  for _ in 1 2 3 4 5; do
    niri msg --json windows 2>/dev/null | jq -e 'any(.[]; .app_id == "gjoa-render")' >/dev/null || break
    sleep 1
  done
  niri msg --json workspaces 2>/dev/null \
    | jq -e 'any(.[]; .name == "render" and .active_window_id == null)' >/dev/null \
    && niri msg action unset-workspace-name render
}

prof=$(mktemp -d /tmp/gjoa-urlbar-td.XXXXXX)
cat > "$prof/user.js" <<EOF
user_pref("marionette.enabled", true);
user_pref("marionette.port", $PORT);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 1);
user_pref("browser.startup.homepage", "about:blank");
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("sidebar.revamp", true);
user_pref("sidebar.verticalTabs", true);
user_pref("gjoa.layout.dynamicOrientation", false);
user_pref("gjoa.niri.enabled", false);
user_pref("sidebar.visibility", "always-show");
user_pref("sidebar.main.tools", "history,bookmarks");
EOF

for pid in $(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do kill -9 "$pid" 2>/dev/null; done

arm_render_ws
env GJOA_ALLOW_INSECURE=1 GJOA_DEV_LOADER=1 MOZ_APP_REMOTINGNAME=gjoa-render \
  "$BIN" -no-remote -profile "$prof" -marionette -remote-allow-system-access about:blank \
  > "$prof/gjoa.log" 2>&1 &
gpid=$!
up=
for _ in $(seq 1 100); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " && { up=1; break; }
  kill -0 "$gpid" 2>/dev/null || { echo "gjoa died — log tail:"; tail -25 "$prof/gjoa.log"; disarm_render_ws; exit 3; }
  sleep 0.5
done
[ -n "$up" ] || { echo "marionette never up"; tail -25 "$prof/gjoa.log"; kill -9 "$gpid" 2>/dev/null; disarm_render_ws; exit 3; }
sleep 2

python3 "$PROBE" --port "$PORT" --settle-ms 5000 --outdir "$OUTDIR"
rc=$?
kill "$gpid" 2>/dev/null; sleep 1; kill -9 "$gpid" 2>/dev/null
disarm_render_ws
rm -rf "$prof"
echo "screenshots -> $OUTDIR"
exit $rc
