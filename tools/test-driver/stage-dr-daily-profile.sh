#!/usr/bin/env bash
# Build a reversible, credential-safe Dark Reader control profile from a daily profile.
set -euo pipefail

VERSION="4.9.125"
SHA256="21a9a18bc873e09b9b10f841a559807ce9e90738674c7eddb9f639c0663eaf28"
ADDON="addon@darkreader.org.xpi"

usage() { echo "usage: $0 stage SOURCE_PROFILE STAGING_PROFILE BACKUP_DIR [XPI] | rollback STAGING_PROFILE BACKUP_DIR" >&2; exit 64; }
die() { echo "$*" >&2; exit 64; }
reject_unresolved_components() {
  local supplied="$1" part probe="/" IFS
  case "$supplied" in /*) ;; *) die "path must be absolute: $supplied" ;; esac
  IFS=/ read -r -a parts <<< "${supplied#/}"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    [ "$part" != . ] && [ "$part" != .. ] || die "traversal path rejected: $supplied"
    probe="$probe$part"
    [ ! -L "$probe" ] || die "symlink path rejected: $supplied"
    probe="$probe/"
  done
}

# A profile may only be staged in disposable roots.  realpath -m first removes
# lexical traversal; comparing it with the existing parent rejects symlink paths.
safe_new_path() {
  local supplied="$1" lexical parent resolved
  reject_unresolved_components "$supplied"
  lexical="$(realpath -m -- "$supplied")" || die "invalid path: $supplied"
  parent="$(dirname "$lexical")"
  [ -d "$parent" ] || die "parent does not exist: $parent"
  resolved="$(realpath -e -- "$parent")" || die "cannot resolve parent: $parent"
  [ "$parent" = "$resolved" ] || die "symlink path rejected: $supplied"
  case "$lexical" in /tmp/*|"$HOME"/.cache/*) printf '%s\n' "$lexical" ;; *) die "path must be under /tmp or ~/.cache: $supplied" ;; esac
}

safe_existing_path() {
  local supplied="$1" lexical resolved
  reject_unresolved_components "$supplied"
  [ -e "$supplied" ] || die "missing path: $supplied"
  lexical="$(realpath -m -- "$supplied")" || die "invalid path: $supplied"
  resolved="$(realpath -e -- "$supplied")" || die "cannot resolve path: $supplied"
  [ "$lexical" = "$resolved" ] || die "symlink or traversal path rejected: $supplied"
  printf '%s\n' "$resolved"
}

under() { case "$1" in "$2"/*) return 0 ;; *) return 1 ;; esac; }
provenance_file() { printf '%s/.stage-dr-%s.provenance\n' "$2" "$(printf %s "$1" | sha256sum | awk '{print $1}')"; }

stage() {
  local source staging backup_root xpi actual backup provenance token
  source="$(safe_existing_path "$1")" || exit $?; staging="$(safe_new_path "$2")" || exit $?; backup_root="$(safe_new_path "$3")" || exit $?
  xpi="${4:-$HOME/.mozilla/firefox/tom/extensions/$ADDON}"
  [ -d "$source" ] || die "source profile is not a directory: $source"
  xpi="$(safe_existing_path "$xpi")" || exit $?; [ -f "$xpi" ] || die "pinned XPI is not a file: $xpi"
  actual="$(sha256sum "$xpi" | awk '{print $1}')"
  [ "$actual" = "$SHA256" ] || { echo "XPI hash mismatch: expected $SHA256, got $actual" >&2; exit 1; }
  [ "$source" != "$staging" ] && [ "$source" != "$backup_root" ] && [ "$staging" != "$backup_root" ] || die "source, staging, and backup paths must differ"
  mkdir -p "$backup_root"
  provenance="$(provenance_file "$staging" "$backup_root")"
  [ ! -e "$provenance" ] || die "unconsumed rollback provenance exists: $provenance"
  backup=none
  if [ -e "$staging" ]; then
    backup="$(mktemp -d "$backup_root/.stage-dr-backup.XXXXXXXX")"
    mv "$staging" "$backup/profile"
  fi
  # Deliberately copy no source profile files.  The XPI and generated user.js
  # are the complete allowlist, so credential and extension/session stores have
  # no route into the disposable control profile.
  mkdir -p "$staging/extensions"
  install -m 0644 "$xpi" "$staging/extensions/$ADDON"
  printf 'user_pref("extensions.autoDisableScopes",0);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("network.trr.mode",5);\n' > "$staging/user.js"
  token="$(basename "$backup")"
  { printf 'staging=%s\nbackup=%s\ntoken=%s\n' "$staging" "$backup" "$token"; } > "$provenance"
  echo "staged=$staging darkreader=$VERSION sha256=$SHA256 backup=$backup"
}

rollback() {
  local staging backup_root provenance line saved_staging backup token
  staging="$(safe_new_path "$1")" || exit $?; backup_root="$(safe_new_path "$2")" || exit $?; provenance="$(provenance_file "$staging" "$backup_root")"
  [ -f "$provenance" ] || { echo "no invocation provenance for $staging" >&2; exit 1; }
  saved_staging="$(sed -n 's/^staging=//p' "$provenance")"; backup="$(sed -n 's/^backup=//p' "$provenance")"; token="$(sed -n 's/^token=//p' "$provenance")"
  [ "$saved_staging" = "$staging" ] && [ -n "$token" ] || die "invalid rollback provenance"
  if [ "$backup" != none ]; then
    under "$backup" "$backup_root" && [ "$(basename "$backup")" = "$token" ] && [ -d "$backup/profile" ] || die "backup provenance escaped root"
  fi
  [ ! -e "$staging" ] || mv "$staging" "$(mktemp -d "$backup_root/.stage-dr-failed.XXXXXXXX")/profile"
  if [ "$backup" != none ]; then mv "$backup/profile" "$staging"; rmdir "$backup"; fi
  rm -f "$provenance"
  echo "rolled-back=$staging"
}

case "${1:-}" in
  stage) [ "$#" -ge 4 ] && stage "${2}" "${3}" "${4}" "${5:-}" || usage ;;
  rollback) [ "$#" = 3 ] && rollback "${2}" "${3}" || usage ;;
  *) usage ;;
esac
