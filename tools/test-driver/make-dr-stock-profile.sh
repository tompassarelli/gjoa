#!/usr/bin/env bash
# Build the STOCK Dark Reader control profile source from a hash-pinned XPI.
# This is the fair
# control for gjoa-vs-DR comparisons — a personal profile carries per-site
# toggles/whitelist mode and benchmarks against someone's site list instead
# of the product (2026-07-11 lesson).
set -euo pipefail
SRC="${1:-/tmp/dr-stock-profile-src}"
# Dark Reader 4.9.125, inspected from its manifest on 2026-07-26.
# This is an artifact pin, deliberately not AMO's moving /latest endpoint.
VERSION="4.9.125"
SHA256="21a9a18bc873e09b9b10f841a559807ce9e90738674c7eddb9f639c0663eaf28"
XPI="${DARKREADER_XPI:-$HOME/.mozilla/firefox/tom/extensions/addon@darkreader.org.xpi}"

[ -f "$XPI" ] || { echo "missing pinned Dark Reader $VERSION XPI: $XPI" >&2; exit 1; }
actual="$(sha256sum "$XPI" | awk '{print $1}')"
[ "$actual" = "$SHA256" ] || { echo "Dark Reader XPI hash mismatch: expected $SHA256, got $actual" >&2; exit 1; }

rm -rf "$SRC" && mkdir -p "$SRC/extensions"
install -m 0644 "$XPI" "$SRC/extensions/addon@darkreader.org.xpi"
printf 'user_pref("extensions.autoDisableScopes",0);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("network.trr.mode",5);\nuser_pref("datareporting.policy.firstRunURL","");\nuser_pref("browser.startup.homepage_override.mstone","ignore");\n' > "$SRC/user.js"
echo "stock DR $VERSION profile source at $SRC ($(du -h "$SRC/extensions/addon@darkreader.org.xpi" | cut -f1) xpi, sha256=$SHA256)"
echo "verify with: dr-compare.sh arm boot + dr-sentinel.py --port <p>  (target example.com)"
