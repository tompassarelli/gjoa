#!/usr/bin/env bash
# Control-arm renderer for the dark-mode corpus TAIL (redirect/SPA/logged-in sites
# the one-shot dr-compare.sh could not pair). The gjoa arm already rendered these;
# this fills the dr (Dark Reader) + light (no-DR baseline) legs into the SAME outdir.
#
# Why a dedicated runner: the logged-in FF control profiles hit anti-bot/account
# flows on social sites (instagram/facebook: AWS WAF challenge NULLs the browsing
# context) that WEDGE the marionette session and, in a single sequential render,
# poison every site after the crasher -> zero pairs. render-darkmode-arm.py exits
# 42 naming the crasher; here we blacklist it, reboot the browser, and resume.
# Idempotent (skips already-rendered slugs) so reboot-resume is cheap.
#
# Usage: dr-compare-remainder.sh [site-list] [outdir]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LIST="${1:-/tmp/dr-remainder.txt}"
OUT="${2:-/tmp/dr-compare-remainder}"
FF=/run/current-system/sw/bin/firefox
DPROF="$HOME/.mozilla/firefox/tom"                 # Dark Reader ACTIVE control
LPROF="$HOME/.mozilla/firefox/bgtdfn4f.default"    # no-DR light baseline
RSX=(--exclude='cache2/' --exclude='startupCache/' --exclude='*.lock' --exclude='lock' --exclude='.parentlock' --exclude='storage/default/*/cache/' --exclude='cache/')
mkdir -p "$OUT"
URLS=$(grep -vE '^\s*#|^\s*$' "$LIST" | paste -sd,)
MAXBOOT=12   # generous: one boot per crasher + the good pass, per arm
# Seed the blacklist with slugs already KNOWN to be exclusions, so a resume run
# neither re-navigates them nor pays a reboot to rediscover a wedge:
#   reactjs_org_  = brand moved to react.dev (registrable-domain rename, true drop)
#   instagram_com_ / facebook_com_ = logged-in AWS WAF challenge NULLs the browsing
#     context and wedges the session (verified). Override via PRESKIP env.
PRESKIP="${PRESKIP:-reactjs_org_,instagram_com_,facebook_com_}"

# arm LABEL PROFILE-SRC PORT [extra-pref-line]
arm() {
  local label="$1" psrc="$2" port="$3" extra="${4:-}"
  local dst="/tmp/cmp3-$label"
  local crf="/tmp/dr-arm-crasher-$label"; : > "$crf"
  local skip="$PRESKIP"
  for ((boot=1; boot<=MAXBOOT; boot++)); do
    rm -rf "$dst"; mkdir -p "$dst"
    rsync -a "${RSX[@]}" "$psrc/" "$dst/" 2>/dev/null
    # marionette + disable the FxA/Sync churn (harmless NS_ERROR_UNKNOWN_HOST spam
    # from the logged-in profile) + TRR off (native resolver; a remote doh-rollout
    # refresh once broke every arm lookup) + no crash-restore.
    printf 'user_pref("marionette.port",%s);\nuser_pref("marionette.enabled",true);\nuser_pref("browser.sessionstore.resume_from_crash",false);\nuser_pref("extensions.autoDisableScopes",0);\nuser_pref("network.trr.mode",5);\nuser_pref("doh-rollout.disable-heuristics",true);\nuser_pref("identity.fxaccounts.enabled",false);\nuser_pref("services.sync.enabled",false);\n' "$port" >> "$dst/user.js"
    [ -n "$extra" ] && printf '%s\n' "$extra" >> "$dst/user.js"
    env MOZ_HEADLESS=1 timeout 1600 "$FF" -no-remote -profile "$dst" -marionette -remote-allow-system-access about:blank >"/tmp/cmp3-$label.log" 2>&1 &
    local pid=$!
    sleep 14
    : > "$crf"
    timeout 1500 python3 "$REPO/tools/test-driver/render-darkmode-arm.py" \
      --port "$port" --prefix "$label" --outdir "$OUT" --urls "$URLS" --settle 18 \
      --skip "$skip" --crasher-file "$crf" 2>>"/tmp/cmp3-$label.render.log"
    local rc=$?
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    if [ "$rc" -eq 42 ]; then
      local c; c="$(cat "$crf" 2>/dev/null)"
      echo "[$label] boot $boot: WEDGE on '$c' -> blacklist + reboot" >&2
      [ -n "$c" ] && skip="${skip:+$skip,}$c"
      continue
    fi
    echo "[$label] boot $boot: renderer exit $rc (done)" >&2
    break
  done
  echo "[$label] blacklisted: ${skip:-<none>}" >&2
}

echo "=== rendering dr + light control arms for the tail (crash-isolated) ==="
arm dr    "$DPROF" 2940 &
DP=$!
arm light "$LPROF" 2941 'user_pref("layout.css.prefers-color-scheme.content-override",1);' &
LP=$!
wait "$DP" "$LP"

echo "=== result ==="
echo "dr:    $(ls "$OUT"/dr-*-1top.png 2>/dev/null | wc -l)"
echo "light: $(ls "$OUT"/light-*-1top.png 2>/dev/null | wc -l)"
echo "triples (gjoa+dr+light all present):"
cnt=0; for f in "$OUT"/gjoa-*-1top.png; do [ -f "$f" ] || continue; s="${f##*/gjoa-}"; s="${s%-1top.png}"; [ -f "$OUT/dr-$s-1top.png" ] && [ -f "$OUT/light-$s-1top.png" ] && cnt=$((cnt+1)); done
echo "$cnt"
