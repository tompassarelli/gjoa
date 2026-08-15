# tools/prep — Firefox source preparation pipeline

This Beagle/Bun pipeline downloads mozilla-central, overlays Gjoa's
customizations, and produces a tree at `engine/` that
`nix build .#gjoa --impure` can compile. `branding.bjs` enforces that no
`zen-browser.app` URL enters the generated branding tree.

## Commands

| Command | What it does |
| --- | --- |
| `bun run download` | Fetch firefox-VERSION.source.tar.xz from archive.mozilla.org, verify SHA256 against the published SHA256SUMS, extract to `engine/`. Cached at `~/.cache/gjoa/sources/`. |
| `bun run import` | Three phases: (1) overlay `src/gjoa/` files onto `engine/`, (2) apply patches from `patches/` via `git apply`, (3) generate `engine/browser/branding/gjoa/` from mozilla's `unofficial` template + `gjoa.json`. |
| `bun run init` | Both of the above, in order. Cold-start command. |
| `bun run clean` | Remove `engine/`. Forces full re-download next time. |

## Files

| File | Responsibility |
| --- | --- |
| `cli.bjs` | Command dispatch. |
| `config.bjs` | Loads and validates `gjoa.json`. |
| `paths.bjs` | Filesystem constants (`REPO-ROOT`, `ENGINE-DIR`, etc.). |
| `log.bjs` | Prefixed logger. |
| `download.bjs` | Tarball download, SHA-256 verification, and extraction. |
| `import.bjs` | Orchestrates overlays, patches, and branding. |
| `overlay.bjs` | Copies `src/gjoa/` into `engine/`. |
| `patches.bjs` | Applies each `patches/*.patch` and records its content identity. |
| `branding.bjs` | Clones `engine/browser/branding/unofficial` into `…/gjoa`, substitutes configured brand strings and URLs, and installs Gjoa icons. |

## Branding strategy

We derive our branding tree from mozilla-central's `unofficial` branding
(which ships with empty welcome URLs and Nightly placeholder names),
then string-substitute brand names + URLs based on `gjoa.json`. This
avoids needing to maintain our own branding template — whenever we bump
the Firefox version, we automatically pick up any structural changes to
mozilla's branding format.

The substitutions live in `branding.bjs`. If you add a new brand string
or URL that mozilla's template uses, add it both to `gjoa.json`
(so it is configurable) and to the substitution table in `branding.bjs`.

The `branding!` postcondition rejects any generated tree containing
`zen-browser.app`; a rejection requires updating the substitution table.

## Adding a new patch

Drop a `*.patch` file into `patches/`. Filenames are applied in
alphabetical order (prefix with `0010-`, `0020-` etc. if order matters).
Re-run `bun run import`. The tool records each applied patch in
`engine/.gjoa-applied-patches` as `<name>\t<sha256-of-patch-file>`, and a
patch is skipped on re-run only when its name is recorded and the recorded
hash matches the patch file's current content. Different bytes require a new
application even when the filename is unchanged.

## Adding a new source overlay

Drop the file into `src/gjoa/<path-mirroring-engine>/`. e.g.
`src/gjoa/browser/components/sidebar/foo.mjs` overlays
`engine/browser/components/sidebar/foo.mjs`. Re-run `bun run import`.

## Why Bun

Beagle compiles the `.bjs` tools to JavaScript, and Bun executes the emitted
programs. The pipeline uses Bun's `fetch`, `Bun.CryptoHasher`, and process APIs
without adding a second JavaScript runtime or hashing library.
