#!/usr/bin/env bash
# Build a reversible, credential-safe Dark Reader control profile from a daily profile.
set -euo pipefail

VERSION="4.9.125"
SHA256="21a9a18bc873e09b9b10f841a559807ce9e90738674c7eddb9f639c0663eaf28"
ADDON="addon@darkreader.org.xpi"

usage() {
  echo "usage: $0 stage SOURCE_PROFILE STAGING_PROFILE BACKUP_DIR [XPI] | rollback STAGING_PROFILE BACKUP_DIR" >&2
  exit 64
}

require_safe_destination() {
  case "$1" in /tmp/*|"$HOME"/.cache/*) ;; *) echo "destination must be under /tmp or ~/.cache: $1" >&2; exit 64;; esac
}

stage() {
  local source="$1" staging="$2" backup_root="$3" xpi="${4:-$HOME/.mozilla/firefox/tom/extensions/$ADDON}"
  [ -d "$source" ] || { echo "source profile missing: $source" >&2; exit 1; }
  [ -f "$xpi" ] || { echo "pinned XPI missing: $xpi" >&2; exit 1; }
  require_safe_destination "$staging"; require_safe_destination "$backup_root"
  local actual backup
  actual="$(sha256sum "$xpi" | awk '{print $1}')"
  [ "$actual" = "$SHA256" ] || { echo "XPI hash mismatch: expected $SHA256, got $actual" >&2; exit 1; }
  mkdir -p "$backup_root"
  backup="$backup_root/$(basename "$staging").$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -e "$staging" ]; then mv "$staging" "$backup"; echo "backup=$backup"; fi
  # Credential/session material is intentionally excluded: this profile is a
  # disposable render control, not a second copy of the owner's logged-in state.
  rsync -a --delete \
    --exclude='logins.json' --exclude='key4.db' --exclude='cookies.sqlite*' \
    --exclude='permissions.sqlite*' --exclude='storage/' --exclude='sessionstore*' \
    --exclude='signedInUser.json' --exclude='weave/' --exclude='cache2/' \
    --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' \
    "$source/" "$staging/"
  mkdir -p "$staging/extensions"
  install -m 0644 "$xpi" "$staging/extensions/$ADDON"
  printf 'user_pref("extensions.autoDisableScopes",0);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("network.trr.mode",5);\n' >> "$staging/user.js"
  for secret in logins.json key4.db cookies.sqlite permissions.sqlite storage sessionstore.jsonlz4 signedInUser.json weave; do
    [ ! -e "$staging/$secret" ] || { echo "credential safety failure: $staging/$secret" >&2; exit 1; }
  done
  echo "staged=$staging darkreader=$VERSION sha256=$SHA256"
}

rollback() {
  local staging="$1" backup_root="$2" candidate
  require_safe_destination "$staging"; require_safe_destination "$backup_root"
  candidate="$(find "$backup_root" -maxdepth 1 -mindepth 1 -type d -name "$(basename "$staging").*" -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
  [ -n "$candidate" ] || { echo "no backup for $staging in $backup_root" >&2; exit 1; }
  [ ! -e "$staging" ] || mv "$staging" "$staging.failed.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$candidate" "$staging"
  echo "rolled-back=$staging"
}

case "${1:-}" in
  stage) [ "$#" -ge 4 ] && stage "${2}" "${3}" "${4}" "${5:-}" || usage ;;
  rollback) [ "$#" = 3 ] && rollback "${2}" "${3}" || usage ;;
  *) usage ;;
esac
