# scriptlet-resources.json — provenance & integrity

`scriptlet-resources.json` is a vendored, uBO-derived library of scriptlet /
redirect resources (162 entries: 52 `fn/javascript` + 110
`application/javascript`). Each entry's `content` is **base64-encoded
JavaScript** that the RS client hands to
`nsIContentClassifierService.setScriptletResources(json)`; adblock-rust then
expands `+js(...)` cosmetic rules into scriptlets that are **executed in a
content sandbox via `evalInSandbox`**. Because this bundle is *executable code on
the privileged side of the blocker*, its provenance and integrity matter — a
swapped or tampered bundle would inject attacker-controlled JS into pages.

This file records where the bundle came from and how to verify the committed copy
has not changed. It deliberately does **not** alter the shipped JSON.

## Source

- **Upstream project:** uBlock Origin (uBO)
- **Repository:** https://github.com/uBlockOrigin/uBlock
- **Harvested from commit/tag:** **UNKNOWN** — the bundle was committed to gjoa in
  `710615f` (2026-06-18, "feat(adblock): list-driven scriptlet engine — true
  uBlock +js() parity") as "harvested from uBlock Origin" without recording the
  source revision. This **MUST be pinned at the next refresh**: record the exact
  uBO commit SHA (or release tag) the bundle is regenerated from, so the JS we
  ship to `evalInSandbox` is reproducible from a known upstream point.

## Schema

- **adblock-rust schema version:** `0.12.1`
  (matches `adblock = { version = "0.12.1", ... }` in
  `patches/0008-content-classifier-cosmetic-filtering.patch`; the resource shape
  — `{ name, aliases, kind: { mime }, content (base64) }` — is what
  `Engine::use_resources` deserializes).

## Integrity

- **Committed SHA-256:**
  `156b8d4c9cf833c141687ba33139fa98e8777c0bc95fee3ec05449760fb60e0a`
- **File:** `scriptlet-resources.json` (this directory)

### 2026-07-19 remediation — one entry removed (live credential)

A security audit (thread `019f79cd-a853` / S1 `019f79f3-0a1f`) found the entry
formerly named `async-sugarcoat-8a459c41783885dc83d30f5b7da2359091f4e607.js`
(`application/javascript`, ~71KB decoded) was **not** a genuine uBO scriptlet:
its decoded body was a large minified third-party analytics/marketing bundle
unrelated to uBO's `+js()` scriptlet catalog, and it carried a live
GCP-shaped API key consumed as a URL query parameter in an executable request
to a Google endpoint. It has been **removed outright** (not redacted in
place, since it was not legitimate vendored content to begin with) and the
committed hash above updated accordingly. Required upstream remediation
(credential rotation/revocation) is out of this repo's control and is tracked
on the security thread, not here. A sibling entry with the same
`async-sugarcoat-<sha1>.js` naming (`04394153a7ce417b88e3fe1790a4e6a269bfebe5`)
is similarly non-uBO-shaped but carries no detected credential; it was left
in place as out of scope for this remediation and is flagged here as a
provenance debt for a follow-up audit.

Verify the committed JSON still matches the recorded hash with:

```sh
tools/prep/verify-scriptlet-resources.sh
```

(wired into `bun run preflight`). The hash above is the single source of truth —
if the bundle is legitimately refreshed, regenerate it from a **pinned** uBO
commit, update both the "Harvested from commit/tag" line and this SHA-256, and
re-run the verifier.
