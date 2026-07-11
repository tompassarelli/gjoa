#!/usr/bin/env bash
# Wave5 W-F transparent-root: boot the mach DEV binary headless with a real
# dark-mode profile + marionette on a caller-chosen port (>=3010) and the
# decision trace on (gjoa.darkmode.debug). Offscreen (never touches the user's
# Wayland session, never steals focus). Does NOT pkill any other instance — a
# fresh -no-remote profile lock keeps it independent of concurrent lanes.
#   usage: wave5-tr-launch.sh <port> <logfile>
set -uo pipefail
REPO="$HOME/code/gjoa"
BIN="$REPO/engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa"
NIXBIN="$REPO/result/bin/gjoa"
PROF_SRC="$HOME/.config/mozilla/gjoa/4859ptgk.default-default"
PORT="${1:?port}"; LOG="${2:?logfile}"
DST="/tmp/wf-prof-$PORT"; rm -rf "$DST"; mkdir -p "$DST"
rsync -a --exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' \
  --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' \
  --exclude='cache/' "$PROF_SRC/" "$DST/" 2>/dev/null
cat >> "$DST/user.js" <<EOF
user_pref("marionette.port",$PORT);
user_pref("marionette.enabled",true);
user_pref("browser.sessionstore.resume_from_crash",false);
user_pref("extensions.autoDisableScopes",0);
user_pref("gjoa.darkmode.enabled",true);
user_pref("gjoa.darkmode.mode","dark");
user_pref("gjoa.darkmode.debug",true);
user_pref("browser.dump.enabled",true);
EOF
# nix binary bakes chrome; dev obj binary needs the loose-chrome loader opt-in.
DEV=""; case "$BIN" in *obj-*) DEV="GJOA_DEV_LOADER=1";; esac
exec env -u WAYLAND_DISPLAY -u DISPLAY MOZ_ENABLE_WAYLAND=0 GDK_BACKEND=x11 \
  MOZ_HEADLESS=1 GJOA_ALLOW_INSECURE=1 $DEV \
  "$BIN" -headless -no-remote -profile "$DST" -marionette \
  -remote-allow-system-access about:blank >"$LOG" 2>&1
