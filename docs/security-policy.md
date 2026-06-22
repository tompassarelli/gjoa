# gjoa security policy

## Update cadence

| Trigger | SLA |
|---|---|
| Mozilla ships a patch release (e.g. 151.0.1 → 151.0.2) | 7 days |
| Mozilla ships a major release with MFSAs | 48 hours |
| Any in-the-wild CVE against our pin | same-day |
| Zero-day disclosed | immediate (security:bump + rebuild) |

## Tools

- `bun run security:check` (or `gjoa status`) — fresh probe of Mozilla
  product-details + MFSAs; classifies OK / STALE / CRITICAL.
- `bun run security:bump` — writes latest stable into `gjoa.json`.
- `bin/gjoa` launcher — refuses to launch a STALE/CRITICAL binary
  unless `GJOA_ALLOW_INSECURE=1` (one-off override).
- In-process gate (`src/gjoa/chrome/src/security/index.ts`) — runs at
  chrome-window load, re-checks every 60 min. Quits on major-behind
  or in-the-wild; warns on patch-behind.

## Sources of truth

- Mozilla product-details: https://product-details.mozilla.org/1.0/firefox_versions.json
- Mozilla known-vulns index: https://www.mozilla.org/security/known-vulnerabilities/firefox/

## Notes

The gate is fail-OPEN on network errors — losing internet shouldn't
block work. `gjoa status` shows when the probe last succeeded so you
can tell "verified safe" from "couldn't verify."

## Security-critical patch persistence

Some `patches/*.patch` are not feature work — they *are* a security
mitigation (e.g. a backported upstream fix, or a gjoa-specific hardening
of a Gecko sink). If such a patch silently stops applying on a Firefox
bump, the vulnerability it closed **re-opens** in the next build, with no
error to flag it. The persistence machinery (#120) makes that impossible
to ship by accident.

### Tag convention

A security-critical patch declares a `# security:` block in its header
(alongside the existing `# gjoa-patch:` block):

```
# security:
#   id: <finding-id>          # keys configs/security-mitigations.json + the findings ledger
#   refs:
#     - CVE-2025-XXXX
#     - MFSA-2025-NN
#   mitigates: <one line: what it blocks>
#   persist: true
```

`tools/prep/patch-header.bjs check` rejects a `# security:` block that
has no `id:` (it must be attributable to a finding).

### The four rules

1. **A security-tagged patch that fails to apply is a hard build-stop.**
   preflight **Gate S** treats a non-apply of (or a non-apply that blocks)
   a `security:`-tagged patch as a HARD fail — never the ordinary
   warn/drift of Gate A — and fails *closed* if any declared `depends-on`
   anchor no longer resolves. (Vacuously green today: zero patches carry
   a `security:` block; the gate arms automatically when one is added.)
2. **The regression is recorded as a finding.** The dropped mitigation is
   logged in the findings ledger (`private-docs/security-findings.edn`)
   with `:status "open"`, so `audit-ledger findings` re-surfaces it until
   the patch is regenerated.
3. **The build emits a disclosure artifact.** The import flow regenerates
   tracked `configs/security-patches.json` from the patch `# security:`
   headers (`bun run security:patch-disclosure`). It is *generated*, so it
   can't lie — a dropped or retitled security patch shows up as a diff in
   a tracked file. The current correct state is an empty list with a note.
4. **A version bump blocks on a stale security patch.** A Firefox bump
   that makes a `security:`-tagged patch no longer apply cannot proceed
   to a build until the patch is regenerated against the new source — Gate
   S is part of the mandatory pre-build `bun run preflight`.

Companion gate: **Gate R** ("security mitigations intact") guards the
*non-patch* mitigations (e.g. the cosmetic-selector validator, a default-off
scriptlet pref) via `configs/security-mitigations.json` — a per-mitigation
regression manifest of `mustMatch` source assertions plus, for the cosmetic
validator, an extracted-regex `mustReject`/`mustAccept` corpus. Together R
(code mitigations) and S (patch mitigations) make a shipped security fix
impossible to delete silently.
