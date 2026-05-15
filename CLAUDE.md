# CLAUDE.md — gjoa project guide

This file is loaded into Claude's context for every conversation in
this repo. Keep it short, current, and oriented toward "what would
help me NOT make the same mistake twice."

---

## GJOA DEVELOPMENT PROTOCOL — read this first, every session

Firefox rebuilds are expensive (30-60 min cold; 30 sec for omni.ja-only).
The build is too expensive to be part of the thinking loop. Do not use
full rebuilds as a normal feedback loop.

### Classify EVERY change before acting

Before making any change, declare which lane it belongs to:

**Lane 1 — Hot iteration** (no rebuild)
- chrome JS behavior, tab tree logic, command palette
- CSS/layout, prefs, autoconfig/bootstrap loading
- Anything testable via Browser Toolbox or by editing the running profile's chrome/

**Lane 2 — Restart iteration** (`mach build faster` ~30 sec, omni.ja re-zip)
- chrome JS files in src/gjoa/ (after `bun run import`)
- branding text strings (about-logo, brand.ftl, firefox-branding.js)
- about: page logos in omni.ja

**Lane 3 — Full rebuild** (`mach build` 30-60 min, or `nix build .#gjoa` 30-45 min)
- C++/Rust source changes
- New configure flags, mozconfig changes
- Desktop integration icons (default*.png in install tree)
- Binary name, distribution-id
- New patches/ files

### Hard rules

1. **Never run `mach build`, `nix build`, or any full rebuild without an explicit user prompt of the form "run the full rebuild now" or equivalent.** `mach build faster` is fine to run freely.

2. **Do not rebuild to verify.** Verify by reading files, tracing load paths, and checking whether the changed asset is consumed at runtime, package time, or build time. If unsure which lane a change belongs to: investigate first, do not rebuild to find out.

3. **Maintain a rebuild queue.** Track Lane 3 changes in a list. Don't trigger a build per item — batch them. Surface the queue to the user when proposing the next rebuild.

4. **Audit-before-modify on big tasks.** For port/migration work, start with: "Do not modify files. Do not run builds. Produce: (1) files that can be mechanically renamed without rebuild concern, (2) Lane 1+2 candidates, (3) Lane 3 candidates, (4) unknowns needing investigation, (5) proposed first batch."

### Rebuild queue

Pending Lane 3 changes get tracked here (or in TaskCreate). Empty when no work is pending. User reviews and approves before any rebuild runs.

```
LANE 2 — bun run import; and gj build faster (~30s, omni.ja re-zip)
─────────────────────────────────────────────────────────────────────
3. patches/0003-default-bookmarks-toolbar-never.patch — default
   browser.toolbars.bookmarks.visibility to "never" instead of
   Firefox's "newtab" default. Touches browser/app/profile/firefox.js
   (omni.ja).
4. patches/0004-default-menubar-visible.patch — flip menu bar
   autohide from "true" to "false" so File/Edit/View/… are visible
   by default. Touches browser/base/content/navigator-toolbox.inc.xhtml
   (omni.ja).
5. patches/0005-strip-default-toolbar-buttons.patch — remove
   fxa-toolbar-menu-button, firefox-view-button, alltabs-button from
   default placements. Touches
   browser/components/customizableui/CustomizableUI.sys.mjs (omni.ja).
6. patches/0006-migrate-existing-profiles-strip-buttons-and-menubar.patch
   — bumps CustomizableUI kVersion 23 → 24; new migration block
   strips the three buttons from saved profile placements and clears
   the persisted menubar `autohide` attribute from xulStore. Carries
   patches 0004/0005 forward into pre-existing profiles (not just
   fresh ones).

LANE 3 — nix build .#gjoa --impure   (or full mach build for #2)
─────────────────────────────────────────────────────────────────────
1. flake.nix — unpackPhase: `rm -f source/mozconfig` before mach
   configure (removes --without-wasm-sandboxed-libraries / --with-wasi-sysroot
   conflict that blocks nix builds). nix-only; mach loop already works.
2. assets/gjoa.svg — switch icon from Lucide outline to sailboat
   emoji (⛵). Requires `bun run icons && bun run import` to push new
   PNGs into engine/.../branding/gjoa/; full build to bake them into
   default<N>.png install-tree icons.
```

When the user says "kick off the build" / "run the full rebuild now" / equivalent: flush the queue into one rebuild covering all queued changes.

---

## What this is

Gjoa is a Firefox fork. Source overlays in `src/gjoa/`, branding
in `configs/branding/gjoa/`, build pipeline in `tools/prep/`,
NixOS build via `flake.nix` (uses nixpkgs's `buildMozillaMach`).

The fork was forked from [palefox v0.43.0](https://github.com/tompassarelli/palefox)
— a userscript bundle for Firefox. Gjoa inherits palefox's goals
(keyboard-first chrome, tree tabs, hash-pinned loader baked in) but
implements them as Firefox source-tree files instead of runtime-loaded
`.uc.js` userscripts.

The userscript-era palefox lives at [github.com/tompassarelli/palefox](https://github.com/tompassarelli/palefox)
and is no longer developed. Gjoa is the successor.

## Status

- ✅ Repo scaffold (gjoa.json, flake.nix, tools/prep, dir tree)
- ✅ Build pipeline owned end-to-end (no surfer dependency)
- ✅ First successful `nix build .#gjoa` — produces working binary
- ✅ **Native chrome loader** — `src/gjoa/browser/components/gjoa/GjoaLoader.sys.mjs`
     replaces fx-autoconfig. Production path loads chrome JS/CSS from
     omni.ja (`chrome://gjoa/content/`); dev path reads
     `<install_root>/gjoa-dev/{JS,CSS}/` directly for sub-second
     iteration. Wired via two patches: `0001-` (browser/components/moz.build
     include) + `0002-` (browser/glue import). Obsoletes the
     hash-pinned-loader item — omni.ja-baked scripts share Firefox's
     trust boundary; no user-writable script dir exists in production.
- ✅ **Chrome bundle pipeline** — `tools/chrome-bundle/build.ts` +
     `build.config.ts` compile `src/gjoa/chrome/src/{module}/index.ts`
     IIFE bundles into `dist/chrome/JS/<module>.uc.js`.
     `tools/chrome-bundle/install.ts` deploys them to `<install_root>/gjoa-dev/`.
     `bun run chrome:bundle` / `chrome:install` / `chrome:watch` /
     `chrome:dist` are the user-facing commands.
- ✅ **Ported palefox TypeScript modules** (src/gjoa/chrome/src/):
     - `drawer/` (8 modules: banner, compact, drag-overlay, layout,
       sidebar-button, timing, urlbar, index)
     - `firefox/` (Firefox-internals abstraction: dom, files, observers,
       prefs, tabs, window)
     - `platform/` (state primitives: cross-window-tabs, history,
       scheduler, tabs-reconciler, window, window-tabs, index)
     - `tabs/` (18 modules: state, rows, events, picker, content-focus,
       menu, helpers, history, drag, snapshot, layout, log, constants,
       types, **vim** (~88KB — vim keymap is part of tabs, not a
       separate module), index, plus two `.test.ts`). Wired into
       `tools/chrome-bundle/build.config.ts` as the `tabs/index.ts` entry
       — output `dist/chrome/JS/palefox-tabs.uc.js`.
     - `hello/` (smoke-test bundle confirming the loader works)
     - `types/chrome.d.ts` (Firefox chrome ambient types)
     - `test/harness.ts` (bun:test infra)
- ✅ **Palefox CSS lifted** — `src/gjoa/chrome/css/{palefox,palefox-tabs,palefox-which-key}.uc.css`.
     Names still `palefox-*` per a documented post-Batch-1 stretch
     decision; gjoa-rename is deferred until the port stabilizes.
- 🟡 **Runtime verification — not done** in this session. Files are in
     place, bundle config is wired, but neither (a) `bun run chrome:bundle`
     producing clean `dist/chrome/JS/*.uc.js` nor (b) the running gjoa
     binary actually loading them has been confirmed. First sanity check
     before adding more features.
- ⬜ **Prefs pipeline** — `prefs/gjoa/` directory exists but is empty;
     not yet wired into `tools/prep/` (the import phases don't currently
     apply anything from this dir). Either drop, or scaffold integration
     so default prefs can be shipped declaratively.
- ⬜ **Distribution + release pipeline** — `flake.nix` exposes
     `packages.gjoa-release` (PGO + LTO) but there's no signing,
     versioning workflow, update channel, or release-cut script. Open
     design question, not just impl.

## Repo layout

```
gjoa/
├── gjoa.json             config: name, version, branding, URLs
├── flake.nix              NixOS build (dev + release variants)
├── package.json           bun scripts wrapping tools/prep
├── tools/prep/            our Firefox-source preparation pipeline
│   ├── cli.ts             command dispatch
│   ├── download.ts        fetch mozilla-central tarball + verify SHA256
│   ├── import.ts          orchestrates overlay/patches/branding
│   ├── overlay.ts         copies src/gjoa/ → engine/
│   ├── patches.ts         applies patches/*.patch (idempotent)
│   ├── branding.ts        derives engine/.../gjoa/ from mozilla unofficial
│   └── README.md          how the pipeline works
├── configs/
│   └── branding/gjoa/    icons (PNGs at logo16.png ... logo512.png)
├── src/
│   └── gjoa/             source overlays (mirrors mozilla-central paths)
├── prefs/
│   └── gjoa/             default prefs (TODO; not yet wired)
├── docs/
│   └── build-and-dev-loop.md   deep dive on file types, mach, PGO/LTO
└── tests/                 regression tests
```

## Reference materials on disk

- `~/code/palefox/archive/` — the userscript-bundle palefox (v0.43.0).
  Source of truth for porting features to gjoa: vim keymap is in
  `chrome/JS/palefox-vim.uc.js`, tab sidebar in `palefox-tabs.uc.js`,
  CSS in `chrome/CSS/`. Loader architecture writeup at
  `archive/docs/dev/loader-pipeline.md`.
- `~/code/zen-browser/` — Zen Browser repo. Reference for how a similar
  fork organizes overlays. We do not depend on their tooling.
- `~/code/firefox/` — mozilla-central source. Reference for Firefox-internal
  types (XPCOM IDLs, JSWindowActor patterns, chrome manifests).

## Naming convention

Everything gjoa-prefixed where prefixes apply:

- CSS variables: `--gjoa-tab-bg`, `--gjoa-sidebar-width`
- Chrome JS files: `gjoa-tabs.uc.js`, `gjoa-vim.uc.js`
- Pref keys: `gjoa.tabs.tree.enabled`, `gjoa.vim.leader-key`
- about: pages: `about:gjoa`, `about:gjoa-config`
- Distribution ID: `org.gjoa` (set in flake.nix)

Long but unambiguous. No abbreviation.

## Workflow

**Two iteration modes:** `nix build` for cold-start / releases (slow,
reproducible). `mach build faster` for daily iteration (sub-30-sec
JS/CSS, few-min C++).

For the deep dive on file types (`.ja`/`.so`/`.cpp`/`.xhtml`), what
`mach build faster` actually does, what PGO/LTO buy you, and the full
dev loop, see [`docs/build-and-dev-loop.md`](docs/build-and-dev-loop.md).

### One-time setup (cold start)

```bash
bun run init                  # download + import (~10 min, ~700MB tarball)
nix build .#gjoa --impure    # ~30-45 min cold compile (dev variant)
./result/bin/gjoa
```

DO NOT run mach bootstrap on NixOS — it doesn't support NixOS as a
distro. nixpkgs's `buildMozillaMach` provides the toolchain instead.

### Daily dev loop (after cold start)

```bash
nix develop                          # enter shell with toolchain + env
# edit src/gjoa/foo.mjs ...
bun run import                       # re-applies overlays + branding
cd engine && ./mach build faster     # ~30 sec, re-zips omni.ja
$MOZ_OBJDIR/dist/bin/gjoa           # run rebuilt binary
```

For C++/Rust changes: `./mach build` (incremental, minutes).
For configure-flag changes: `./mach configure && ./mach build`.

### When to use `nix build .#gjoa` (rare)

- First time on this machine (or after `git clean -fdx`)
- Firefox version bump (gjoa.json change → fresh download → must rebuild from scratch)
- Touched flake.nix toolchain inputs

Otherwise stay in `mach build faster` land — 60-180x faster than
`nix build`.

### Two build variants

```bash
nix build .#gjoa          # DEV — no PGO, no LTO
nix build .#gjoa-release  # RELEASE — full PGO + LTO
```

Default `.#gjoa` is the dev variant. PGO (the 2-pass profile-collect
rebuild) doubles build time at a 5-15% runtime speed cost — invisible
during development. Use `-release` only for distribution artifacts.

### Runtime injection (no rebuild at all)

For exploratory UI work, the v0.43.0 fx-autoconfig pattern still works
inside the fork — drop a `.uc.js` into the running profile's `chrome/JS/`,
restart Firefox. Use this for prototyping; promote to `src/gjoa/`
when stable.

## Common pitfalls

- **`buildMozillaMach` has TWO arg lists.** `pgoSupport`/`ltoSupport`/
  `crashreporterSupport` go through `.override`, not the user args.
  See flake.nix's `mkGjoa` for the pattern.
- **Disk usage is heavy.** mozilla-central source is ~5GB, build outputs
  another ~5GB, downloaded toolchain ~2GB. Plan ~15GB before `bun run init`.
- **`engine/.git/` is intentional.** `tools/prep/patches.ts` initializes it
  so `git apply` works. mach detects it; flake.nix passes `pkgs.git` as a
  build input so the build doesn't fail looking for git.

## Anti-goals

- **Don't depend on surfer (or any external Firefox-fork tooling).** We
  vendored the build pipeline (`tools/prep/`) for a reason — it was the
  only way to keep Zen-isms out of our build. Don't add it back.
- **Don't pre-port palefox v0.43.0's full feature set.** Re-add features
  deliberately, prioritizing the ones that benefit most from being
  source-level (loader, vim keymap, tab tree).
- **Don't write quick-fix scripts that patch surfer's output post-import.**
  We're past that. Add to `tools/prep/branding.ts`'s substitution table
  instead, with a regression test.

## When extending gjoa

- **New gjoa source file:** drop into `src/gjoa/<area>/` mirroring
  the Firefox source-tree path it should overlay.
- **Mozilla source patch:** add as `patches/<NNNN>-name.patch`. Filename
  prefix controls apply order (alphabetical).
- **Default pref:** add to `prefs/gjoa/`. (Not yet wired into the
  pipeline — currently a stub.)
- **New brand string or URL:** add to `gjoa.json` AND to the substitution
  table in `tools/prep/branding.ts`. Add a check that it landed correctly
  in `tests/`.
