#!/usr/bin/env bash
# Build the STOCK Dark Reader control profile source: fresh profile + latest
# AMO Dark Reader XPI, default settings (darken everything). This is the fair
# control for gjoa-vs-DR comparisons — a personal profile carries per-site
# toggles/whitelist mode and benchmarks against someone's site list instead
# of the product (2026-07-11 lesson).
set -euo pipefail
SRC="${1:-/tmp/dr-stock-profile-src}"
rm -rf "$SRC" && mkdir -p "$SRC/extensions"
curl -sL -o "$SRC/extensions/addon@darkreader.org.xpi" \
  'https://addons.mozilla.org/firefox/downloads/latest/darkreader/latest.xpi'
printf 'user_pref("extensions.autoDisableScopes",0);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("network.trr.mode",5);\nuser_pref("datareporting.policy.firstRunURL","");\nuser_pref("browser.startup.homepage_override.mstone","ignore");\n' > "$SRC/user.js"
echo "stock DR profile source at $SRC ($(du -h "$SRC/extensions/addon@darkreader.org.xpi" | cut -f1) xpi)"
echo "verify with: dr-compare.sh arm boot + dr-sentinel.py --port <p>  (target example.com)"
