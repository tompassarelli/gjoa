#!/usr/bin/env bash
# Dark-mode visual verification — launch gjoa headless, render each fixture with
# the engine inversion + island/scrim active, and save a PNG. `-screenshot`
# renders and EXITS (no long-lived browser, no teardown problem). Run inside the
# mach devShell so the binary finds its runtime libs:
#   nix develop .#mach -c bash tools/test-driver/dm-shoot.sh
set -u
cd /home/tom/code/gjoa
BIN=engine/obj-x86_64-pc-linux-gnu/dist/bin/gjoa
OUT=/tmp/dm-shots
mkdir -p "$OUT"

pkill -9 -f contrast-fixture-server 2>/dev/null
sleep 1
bun tools/test-driver/contrast-fixture-server.mjs > /tmp/fix.log 2>&1 &
SRV=$!
sleep 3
echo "server http: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8976/mit-news 2>/dev/null)"

# Pure-engine path: actor OFF, engine global invert ON, force light so there IS
# something to invert. This exercises #57 island detection + #58 suppress-inversion
# + #59 scrim directly.
PREFS='user_pref("gjoa.darkmode.enabled", false);
user_pref("gjoa.darkmode.invert.enabled", true);
user_pref("layout.css.prefers-color-scheme.content-override", 1);
user_pref("gjoa.darkmode.scrim.alpha", 140);
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.shell.checkDefaultBrowser", false);'

shoot() {
  local name="$1"
  local prof; prof=$(mktemp -d)
  printf '%s\n' "$PREFS" > "$prof/user.js"
  timeout 90 "$BIN" --headless -profile "$prof" \
    -screenshot "$OUT/$name.png" --window-size=1280,1500 \
    "http://127.0.0.1:8976/$name" > "$OUT/$name.log" 2>&1
  local rc=$?
  local sz; sz=$(stat -c%s "$OUT/$name.png" 2>/dev/null || echo 0)
  echo "  $name: exit=$rc png_bytes=$sz"
  rm -rf "$prof"
}

echo "=== shooting fixtures (engine dark mode on) ==="
shoot mit-news
shoot wikipedia
shoot dark-text-hero
shoot hacker-news

kill "$SRV" 2>/dev/null
echo "=== done; PNGs in $OUT ==="
ls -la "$OUT"/*.png 2>/dev/null
