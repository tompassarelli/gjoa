# Gjoa chrome loader

How chrome JS/CSS gets into Gjoa at startup. Replaces fx-autoconfig.

## Architecture

`browser/components/gjoa/GjoaLoader.sys.mjs` — sys-mjs module baked
into Firefox's resource:// namespace via standard EXTRA_JS_MODULES +
jar.mn registration. Gets imported from `BrowserGlue._init()` (one-line
patch) at app-startup. Registers a `chrome-document-loaded` observer
that fires for each chrome window opened (`chrome://browser/content/browser.xhtml`).

When the observer fires, it:

1. Checks for `<install_root>/gjoa-dev/` (a "dev mode" override directory)
2. If present: reads `.uc.js` and `.uc.css` files from `gjoa-dev/{JS,CSS}/`
   and loads them into the chrome window
3. If absent: production mode — currently no-op (the production-mode
   path will load from `chrome://gjoa/content/scripts/` baked into
   omni.ja in a later batch)

Stylesheets are registered globally via `nsIStyleSheetService` once;
scripts are evaluated per-window via `Services.scriptloader.loadSubScriptWithOptions`.

## Why this replaces fx-autoconfig

fx-autoconfig was the right answer when palefox was a userscript bundle
running INSIDE someone else's Firefox install. It hijacked the autoconfig
pref system to bolt on a loader without touching the binary. Costs:

- Profile-side `chrome/JS/` directory was user-writable → security hole that
  the v0.43.0 hash-pinned bootstrap had to close.
- Banner: "Browser is being modified with custom autoconfig scripting" —
  designed for scary external mods, wrong tone for first-party chrome.
- Required `defaults/pref/config-prefs.js` + `program/config.js` shipped
  alongside the binary — extra install machinery, awkward to bundle.

For Gjoa (a fork we own end-to-end), fx-autoconfig is the wrong
substrate. The native loader uses Firefox's standard chrome-registration
machinery, lives in install-root-owned omni.ja, has no profile chrome
dir, and produces no warning banner.

## Security model

### Production (no `<install_root>/gjoa-dev/` directory)

Scripts and styles eventually load from omni.ja via `chrome://gjoa/content/...`
URLs (production-mode path TBD — see TODOs). Same trust boundary as
Firefox itself: if you trust the install (downloaded from gjoa-browser.app
or built locally), you trust the chrome JS. No user-writable script
directory exists; no hash-pinning needed because there's nothing for
local-mode malware to tamper with.

### Dev mode (`<install_root>/gjoa-dev/` exists)

The loader reads `.uc.js` and `.uc.css` files from `<install_root>/gjoa-dev/`
directly at startup. This is the sub-second iteration path:

```
edit src/gjoa/chrome/src/foo.ts
→ bun run chrome:dist     # ~1 sec, produces dist/chrome/{JS,CSS}/
→ restart gjoa           # ~3 sec, loader reads new files
```

`bun run chrome:install` makes `<install_root>/gjoa-dev/` a symlink to
`dist/chrome/`, so re-bundling is enough — no separate install step.

**Trust boundary:** anyone who can write to the install root (`<install_root>`,
typically `engine/obj-*/dist/bin/` for dev or `/usr/lib/gjoa/` for prod)
can inject arbitrary chrome JS by dropping it into `gjoa-dev/JS/`. This
is the same trust boundary as "anyone who can write to the install root
can replace the Gjoa binary itself" — no new attack surface.

In a typical setup:

| Install location | Who can write gjoa-dev/ | Who can activate dev mode |
|---|---|---|
| `~/code/gjoa/engine/obj-*/dist/bin/` (dev build) | the dev | the dev (intentional) |
| `/usr/lib/gjoa/` (system install) | root | root |
| `~/.local/lib/gjoa/` (per-user install) | the user | the user |

End users on a system install **cannot** accidentally activate dev mode
without escalation. End users on a per-user install can — same as they
can edit `~/.local/lib/gjoa/` files in general (which can already
modify the binary itself).

### Hardening for release builds

Currently the dev-mode code path is always present. For shipped release
binaries, defense-in-depth says compile it out entirely — no `gjoa-dev/`
check, no script-from-disk loading, even if someone created the directory.

Open issue: add `MOZ_GJOA_DEV_LOADER` preprocessor define + `#ifdef`
around `devModeDir()` and the dev-mode branch of `loadIntoChromeWindow()`.
Release builds compile with `MOZ_GJOA_DEV_LOADER=0`, dev builds default
to `=1`. Linear: TBD.

### What's NOT a concern

- **The two `mach`-applied patches** (`browser/components/moz.build` +
  `BrowserGlue.sys.mjs`) — they're patches we apply to mozilla source via
  `tools/prep/patches.ts`. Re-applied on every `bun run import`. Auditable
  in `patches/`.
- **Firefox built-in autoconfig pref** (`general.config.filename`) — we no
  longer set it. Gjoa doesn't ship `defaults/pref/config-prefs.js` with
  autoconfig overrides. The pref is not the loader's mechanism anymore.
- **Hash-pinning of chrome scripts** — unnecessary for the same reason
  hash-pinning of native browser code (`libxul.so` etc.) is unnecessary:
  install-root files are owned by whoever owns the install. If install
  root is compromised, the binary is compromised; chrome JS is the same
  level of trust.

## TODOs

- [ ] Production path: enumerate `chrome://gjoa/content/scripts/` and load
      from there in non-dev-mode. Requires baking bundles into omni.ja via
      jar.mn. Until then, production builds have no chrome JS.
- [ ] `MOZ_GJOA_DEV_LOADER` preprocessor define for release-build hardening.
- [ ] Hot-reload (no restart): once the loader knows how to load scripts,
      teach it to *re-load* via `chrome-document-loaded` re-fire on a
      profile-internal trigger (e.g. an env-var-set keyboard shortcut that
      closes/re-opens the chrome window).

## Files

```
src/gjoa/browser/components/gjoa/
├── GjoaLoader.sys.mjs   the loader itself
├── jar.mn                chrome registration (chrome://gjoa/content/)
└── moz.build             EXTRA_JS_MODULES.gjoa registration

patches/
├── 0001-browser-components-mozbuild-include-gjoa.patch
└── 0002-browser-glue-import-gjoa-loader.patch

tools/chrome-bundle/
├── build.ts              bundles src/gjoa/chrome/src/* → dist/chrome/JS/*.uc.js
├── dist.ts               build + stage CSS into dist/chrome/
└── install.ts            symlink dist/chrome → <install>/gjoa-dev/
```
