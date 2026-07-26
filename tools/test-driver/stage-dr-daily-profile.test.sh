#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d /tmp/stage-dr-profile-test.XXXXXX)"
trap 'rm -rf "${work:?}"' EXIT
src="$work/source"; staged="$work/staged"; backups="$work/backups"
mkdir -p "$src" "$staged"
printf secret > "$src/logins.json"; printf key > "$src/key4.db"; printf cookie > "$src/cookies.sqlite"
printf legacy > "$src/logins-backup.json"; printf db > "$src/logins.db"
mkdir -p "$src/browser-extension-data/x/storage"; printf extension-secret > "$src/browser-extension-data/x/storage.js"
mkdir -p "$src/storage/default"; printf site-secret > "$src/storage/default/data"
printf pref > "$src/prefs.js"; printf old > "$staged/old"
xpi="$HOME/.mozilla/firefox/tom/extensions/addon@darkreader.org.xpi"
test "$(sha256sum "$xpi" | awk '{print $1}')" = "21a9a18bc873e09b9b10f841a559807ce9e90738674c7eddb9f639c0663eaf28"
"$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$staged" "$backups" "$xpi"
test -f "$staged/user.js"
test ! -e "$staged/prefs.js"
test ! -e "$staged/logins.json"; test ! -e "$staged/key4.db"; test ! -e "$staged/cookies.sqlite"
test ! -e "$staged/logins-backup.json"; test ! -e "$staged/logins.db"
test ! -e "$staged/browser-extension-data"; test ! -e "$staged/storage"
test -f "$staged/extensions/addon@darkreader.org.xpi"
"$repo/tools/test-driver/stage-dr-daily-profile.sh" rollback "$staged" "$backups"
test -f "$staged/old"
# Rollback must use this invocation's provenance, not a newer matching basename.
mkdir -p "$backups/$(basename "$staged").99999999T999999Z"; printf wrong > "$backups/$(basename "$staged").99999999T999999Z/old"
if "$repo/tools/test-driver/stage-dr-daily-profile.sh" rollback "$staged" "$backups"; then
  echo "rollback accepted an unbound newest backup" >&2; exit 1
fi
test -f "$staged/old"
for bad in "/tmp/../home/tom/.mozilla/firefox/tom" "$HOME/.cache/../../.mozilla/firefox/tom"; do
  if "$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$bad" "$backups" "$xpi"; then
    echo "traversal destination unexpectedly accepted: $bad" >&2; exit 1
  fi
done
mkdir -p "$work/outside"; ln -s "$work/outside" "$work/escape"
if "$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$work/escape/staged" "$backups" "$xpi"; then
  echo "symlink destination unexpectedly accepted" >&2; exit 1
fi
if "$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$work/another" "$work/escape/backups" "$xpi"; then
  echo "symlink backup root unexpectedly accepted" >&2; exit 1
fi
printf tampered > "$work/not-darkreader.xpi"
if "$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$work/rejected" "$backups" "$work/not-darkreader.xpi"; then
  echo "tampered XPI unexpectedly staged" >&2; exit 1
fi
test ! -e "$work/rejected"
grep -Fq "layout.css.prefers-color-scheme.content-override" "$repo/tools/test-driver/qualify-dark-exit.py"
grep -Fq "finally { restore(oldScheme); restore(oldDark); }" "$repo/tools/test-driver/qualify-dark-exit.py"
echo "stage-dr-daily-profile synthetic safety + rollback: PASS"
