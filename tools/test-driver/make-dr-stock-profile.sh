#!/usr/bin/env bash
# Build the STOCK Dark Reader control profile source from a hash-pinned XPI.
set -euo pipefail
SRC="${1:-/tmp/dr-stock-profile-src}"
VERSION="4.9.125"
SHA256="21a9a18bc873e09b9b10f841a559807ce9e90738674c7eddb9f639c0663eaf28"
XPI="${DARKREADER_XPI:-$HOME/.mozilla/firefox/tom/extensions/addon@darkreader.org.xpi}"
die() { echo "$*" >&2; exit 64; }
reject_unresolved_components() {
  local supplied="$1" part probe="/" IFS
  case "$supplied" in /*) ;; *) die "destination must be absolute: $supplied" ;; esac
  IFS=/ read -r -a parts <<< "${supplied#/}"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    [ "$part" != . ] && [ "$part" != .. ] || die "traversal destination rejected: $supplied"
    probe="$probe$part"; [ ! -L "$probe" ] || die "symlink destination rejected: $supplied"; probe="$probe/"
  done
}
safe_destination() {
  local lexical parent resolved
  reject_unresolved_components "$1"
  lexical="$(realpath -m -- "$1")" || die "invalid destination: $1"; parent="$(dirname "$lexical")"
  [ -d "$parent" ] || die "parent does not exist: $parent"; resolved="$(realpath -e -- "$parent")" || die "cannot resolve parent: $parent"
  [ "$parent" = "$resolved" ] || die "symlink destination rejected: $1"
  case "$lexical" in /tmp/*|"$HOME"/.cache/*) printf '%s\n' "$lexical" ;; *) die "destination must be under /tmp or ~/.cache: $1" ;; esac
}
SRC="$(safe_destination "$SRC")" || exit $?
[ -f "$XPI" ] || { echo "missing pinned Dark Reader $VERSION XPI: $XPI" >&2; exit 1; }
actual="$(sha256sum "$XPI" | awk '{print $1}')"
[ "$actual" = "$SHA256" ] || { echo "Dark Reader XPI hash mismatch: expected $SHA256, got $actual" >&2; exit 1; }
rm -rf "$SRC" && mkdir -p "$SRC/extensions"
install -m 0644 "$XPI" "$SRC/extensions/addon@darkreader.org.xpi"
printf 'user_pref("extensions.autoDisableScopes",0);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("network.trr.mode",5);\nuser_pref("datareporting.policy.firstRunURL","");\nuser_pref("browser.startup.homepage_override.mstone","ignore");\n' > "$SRC/user.js"
echo "stock DR $VERSION profile source at $SRC ($(du -h "$SRC/extensions/addon@darkreader.org.xpi" | cut -f1) xpi, sha256=$SHA256)"
echo "verify with: dr-compare.sh arm boot + dr-sentinel.py --port <p>  (target example.com)"
