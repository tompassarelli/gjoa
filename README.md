<div align="center">

<img src="configs/branding/gjoa/content/about-logo.png" width="84" alt="gjoa" />

# gjoa

**gjoa is a Firefox fork where the power-user extension stack is native.** Ad/tracker blocking, forced dark mode, vertical/tree tabs, workspaces, vim navigation, session history, and egress auditing live in the browser chrome and engine — not in extensions, content scripts, or autoconfig hacks.

<img src="screenshots/gjoa-newtab.png" width="760" alt="gjoa — the new-tab navigator, vertical-tab sidebar, forced-dark" />

</div>

Built on Firefox 152, written in [Beagle](https://github.com/Autonymy/beagle) (a typed Clojure subset) compiled to chrome JS and a native loader baked into `omni.ja`. Native means near-free at runtime — no Dark Reader repaint, no content-script ad blocker, no per-page injection tax. That's the whole point.

Authoring in Beagle is a deliberate edge, not an aesthetic one: compile-time macros, **one** typed language across chrome / loader / tooling / tests / prefs, machine-checked effect discipline (a `BEAGLE_PURITY=error` check a TypeScript type system can't express), engine patches anchored by *declared structural dependencies* (a preflight gate fails the build when an upstream refactor moves a symbol a patch relies on, instead of letting it silently rot), and gjoa's own source queryable as a **call graph** — `who-calls` / `blast-radius` / `leverage`, CI-checked against the compiler. The honest case, including what *isn't* a win, is in [`docs/why-beagle.md`](docs/why-beagle.md).

> This README is the stable shape — durable claims about what the software does, with pointers to the living source of truth for anything the code keeps changing. Volatile detail (exact feature state, build outcomes, versions) lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`BUILD-LEDGER.md`](BUILD-LEDGER.md), [`gjoa.json`](gjoa.json), and the [releases](../../releases).

## What's different

Each is a capability in the build today, described by the mechanism that makes it work. Source for every subsystem is one directory under [`src/gjoa/chrome/bjs/`](src/gjoa/chrome/bjs/) (chrome modules) or [`src/gjoa/toolkit/`](src/gjoa/toolkit/) and [`patches/`](patches/) (engine).

- **Native ad / tracker blocking** — FF152 ships Brave's `adblock-rust` in-tree but only for tracker *annotation*; gjoa drives it as a full content blocker across three layers: **network** (requests killed before they leave the browser), **cosmetic** (element-hiding as a single `USER_SHEET`), and **scriptlets** (sandboxed, curated-only by default — list-driven `+js()` expansion stays off). No extension, no content-script blocker. The exact filter lists are a default pref, not baked into prose — see `list_names` in [`src/gjoa/defaults/pref/adblock-prefs.bjs`](src/gjoa/defaults/pref/adblock-prefs.bjs). Chrome half in [`blocking/`](src/gjoa/chrome/bjs/blocking/); engine half in [`src/gjoa/toolkit/components/content-classifier/`](src/gjoa/toolkit/components/content-classifier/) (overlay + `patches/0008`).

- **Engine-level dark mode** — respects each site rather than inverting blindly: pages with native dark CSS keep it, themeless pages are darkened by the engine pre-paint (no white flash), with a curated registry + per-site overrides for the rest. Driven by Gecko-native levers (a content `prefers-color-scheme` override pref and an engine luminance-inversion flag read by `nsPresContext`), plus a chrome-CSS invert fallback — no content-script darkening on the core path. — [`dark-mode/`](src/gjoa/chrome/bjs/dark-mode/) + the engine patches whose names start `dark-mode-` in [`patches/`](patches/).

- **Tree-style tabs + a vim keymap** — a vertical, keyboard-driven tab tree (nesting, folder groups, collapse, multi-select) driven by a modal vim layer: motion, indent/swap, leader chords, `/` filter, and a `:` ex-command set with picker + help overlay. A chrome bundle over `gBrowser`; tree structure is per-tab metadata. The authoritative ex-command and leader-binding tables are data in [`tabs/vim.bjs`](src/gjoa/chrome/bjs/tabs/vim.bjs); the subsystem is [`tabs/`](src/gjoa/chrome/bjs/tabs/).

- **Workspaces** — tabs partitioned into named spaces; switching shows only that space's tabs, and the selected tab stays inside it (survives session restore). On the niri compositor, focusing an OS workspace switches gjoa to the same-named space (one-way OS→gjoa). — [`spaces/`](src/gjoa/chrome/bjs/spaces/).

- **Sidebar drawer + floating urlbar** — the tab sidebar is a drawer (expand/collapse, compact, drag-resize, hover-reveal); a floating urlbar on the focus-urlbar shortcut. — [`drawer/`](src/gjoa/chrome/bjs/drawer/).

- **Searchable session history** — workspace changes auto-save to a searchable timeline (`:checkpoint`, `:history`, `:restore`), backed by an append-only SQLite log with WAL crash-safety and an FTS5 full-text index over tab URLs and titles (search degrades to substring when FTS5 is unavailable). — [`tabs/history.bjs`](src/gjoa/chrome/bjs/tabs/history.bjs) + `patches/0007` (FTS5).

- **`about:gjoa` — one settings home** — gjoa's settings live in a single branded page (content blocking, dark mode, curated privacy profiles, and a reversible-features dashboard), not scattered through `about:config`. The page is data-driven from a registry, kept in sync with the loader's presets by a preflight gate. Firefox Settings carries a pointer to it — with zero patching of Firefox's preferences code. Registry: [`src/gjoa/browser/components/gjoa/content/settings/registry.json`](src/gjoa/browser/components/gjoa/content/settings/registry.json).

- **`about:sovereignty` — egress audit** — a source-derived list of every point the build contacts the network without user action, generated by a static AST audit of all authored chrome and tied to the running build's commit + patch hash (the page flags a mismatch rather than implying a match it can't prove). Regenerate with `bun run sovereignty:egress`. — tool in [`tools/sovereignty/`](tools/sovereignty/), page in [`src/gjoa/browser/components/gjoa/content/sovereignty/`](src/gjoa/browser/components/gjoa/content/sovereignty/).

- **Reversible by design** — every feature gjoa disables stays *present* and flippable — capabilities are parked behind a knob, never deleted. The reversible set, and the honest cost of re-enabling each (the network endpoint it re-contacts, not an invented perf number), is the reversible-features section of the settings registry.

- **Custom new-tab / home** — new tabs, home, and home-based startup land on a minimal forced-dark navigator page (the screenshot above). — [`src/gjoa/browser/components/gjoa/content/newtab/`](src/gjoa/browser/components/gjoa/content/newtab/) + `patches/0011` (redirector).

- **Security freshness gate** — gjoa refuses to keep running a dangerously stale build: it probes Mozilla's published `firefox_versions.json` on startup + hourly; a full major behind latest stable quits, a point-release behind warns. Fails open offline; an env override exists for one-off emergencies. — [`security/`](src/gjoa/chrome/bjs/security/).

## Performance

The release build is `-O3` + full LTO + `-march=native` (tuned to the building machine's CPU — **not** portable to a different chip). Honest framing: stock Firefox already ships PGO+LTO, so the gjoa-vs-stock delta from compiler flags alone is modest. The real win is the absence of the **extension tax** — native dark mode and native blocking do for free what Dark Reader and a content-script blocker do at real per-page cost. Against the Firefox-plus-extensions setup people actually run, gjoa is dramatically lighter. Benchmark harnesses live in [`tools/bench/`](tools/bench/) (`bun run bench`); run them on your own hardware rather than trusting a number copied into a README.

## Build

```sh
bun run init                    # download mozilla-central + apply overlays
nix build .#gjoa --impure       # personal build — LTO + -march=native (THIS CPU only)
nix build .#gjoa-dev --impure   # dev variant — fast, no LTO, CPU-portable
./result/bin/gjoa
```

Two flavors, and the only difference is CPU portability:

- **Your own machine → `.#gjoa`.** Compiled `-march=native` (for the CPU it's built on) — fastest, but it can crash (SIGILL) on hardware that lacks those instructions, so it's a *local* build, not for arbitrary machines.
- **Sharing with anyone else → a portable build.** The **release artifacts** ([`.github/workflows/`](.github/workflows/) builds them per platform on every tag, none `-march=native`), or `nix bundle .#gjoa-dev --impure` for a single relocatable Linux executable that runs on any glibc distro with no Nix on the target. These are the builds to hand out.

The build variants and their exact flags are defined in [`flake.nix`](flake.nix); CI clones the [Beagle](https://github.com/Autonymy/beagle) compiler as a sibling checkout before building.

## Dev loop

Source-tree changes (`.sys.mjs`, branding, configure flags) need a build, but chrome JS/CSS iterates in ~1s without one:

```sh
nix develop .#mach          # shell with mach + toolchain
cd engine && ./mach build   # one-time, ~30-60 min cold
# edit src/gjoa/chrome/bjs/*.bjs (or chrome/css/*.css) ...
gjoa sync                   # compile + deploy the .bjs chrome into the mach install (~1s)
gjoa dev                    # restart the binary
```

Cheatsheet: [`docs/daily-loop.md`](docs/daily-loop.md) · full map + rebuild ladder: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests

```sh
bun test                  # unit tests (happy-dom)
bun run test:integration  # headless Marionette tests against a gjoa binary
bun run preflight         # pre-build gates (patches, chrome alignment, beagle pin, nix eval)
```

`bun run preflight` runs the lettered gate set that catches patch / jar / eval / surface-contract breakage before a multi-hour compile; the gates and their jurisdiction are documented in [`CLAUDE.md`](CLAUDE.md) and implemented in `tools/scripts/preflight.bjs`. `package.json` scripts are the live index of every subsystem-scoped test target (`test:adblock`, `test:darkmode`, `test:tabs`, …).

## Layout

```
gjoa.json            project config — version of record, branding, URLs
flake.nix            Nix build (dev + release variants)
src/gjoa/            source overlays — chrome UI (.bjs/.css), engine actors, prefs, branding, loader
patches/             surgical patches against stock Firefox source (the engine half)
tools/               Firefox-source prep, release tooling, test harness, audits (Beagle on Bun)
.github/workflows/   cross-platform CI (Linux + macOS + Windows builds)
configs/            branding assets + pinned source/compiler refs
docs/               deep-dive documentation
BUILD-LEDGER.md      every build's outcome + postmortems
```

## License

[MPL-2.0](LICENSE) — same as Firefox.
