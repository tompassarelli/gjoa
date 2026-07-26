#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d /tmp/stage-dr-profile-test.XXXXXX)"
trap 'rm -rf "${work:?}"' EXIT
src="$work/source"; staged="$work/staged"; backups="$work/backups"
mkdir -p "$src" "$staged"
printf secret > "$src/logins.json"; printf key > "$src/key4.db"; printf cookie > "$src/cookies.sqlite"
printf pref > "$src/prefs.js"; printf old > "$staged/old"
xpi="$HOME/.mozilla/firefox/tom/extensions/addon@darkreader.org.xpi"
"$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$staged" "$backups" "$xpi"
test -f "$staged/prefs.js"
test ! -e "$staged/logins.json"; test ! -e "$staged/key4.db"; test ! -e "$staged/cookies.sqlite"
test -f "$staged/extensions/addon@darkreader.org.xpi"
"$repo/tools/test-driver/stage-dr-daily-profile.sh" rollback "$staged" "$backups"
test -f "$staged/old"
printf tampered > "$work/not-darkreader.xpi"
if "$repo/tools/test-driver/stage-dr-daily-profile.sh" stage "$src" "$work/rejected" "$backups" "$work/not-darkreader.xpi"; then
  echo "tampered XPI unexpectedly staged" >&2; exit 1
fi
test ! -e "$work/rejected"
echo "stage-dr-daily-profile synthetic safety + rollback: PASS"
