# gjoa daily-loop cheatsheet

One-screen reference for the commands you run all the time. For
architecture, decision trees, and "why does it work this way", see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Launch the browser

| Command | Binary | Mode |
|---|---|---|
| `gjoa` | nix (packaged) | detached — closes the terminal |
| `gjoa -f` | nix | foreground — shows stdout/stderr |
| `gjoa hotreload` | mach (dev build) | detached |
| `gjoa hotreload -f` | mach | foreground |

## Where am I?

```
gjoa status
```

Versions vs Mozilla/nixpkgs/Zen/LibreWolf, CVE count against your pin,
build state, and the next recommended command. Fresh pulls, ~1–2 sec,
no cache.

## I edited chrome Beagle or CSS (Lane 1, sub-second)

```
gjoa sync          # compile src/gjoa/chrome/bjs/**/*.bjs → dist/chrome/JS/
                   # stage src/gjoa/chrome/css/*.uc.css → dist/chrome/CSS/
                   # then symlink dist/chrome/ into <mach-install>/gjoa-dev/
gjoa hotreload     # restart the mach binary to pick up the new bundles
```

For continuous bundle-on-save:

```
gjoa watch         # rebundles on file change; restart browser to see
```

## I edited a Firefox `.sys.mjs` overlay / patch / branding string (Lane 2, ~30 sec)

```
gjoa import        # copies src/gjoa/ → engine/, applies patches, bakes branding
gjoa build faster  # mach re-zips omni.ja (no C++ compile)
gjoa hotreload
```

`gjoa build faster` requires `engine/obj-*/` to already exist (one
prior `gjoa build` cold-built it). If it doesn't, run a full `gjoa build` first.

## I want to run the tests

```
bun test                            # unit tests (happy-dom, ~300ms)
gjoa test:integration               # Marionette tests against the mach binary
gjoa test:integration:nix           # same suite against result/bin/gjoa
                                    # (use this to confirm a fresh nix build is healthy)
```

## I want to rebuild from scratch (Lane 3)

Run `bun run import` and `bun run preflight` first so the engine and patch surface
are current before the compile.

```
gjoa import                                 # ensure engine/ is fresh
nix build .#gjoa --impure --cores 8 -j 1   # ~30-60 min cold
gjoa test:integration:nix                  # confirm sidebar + chrome bundles load
```

A local `nix build` is a **dev verification** — it is NOT the release artifact.
Cutting a release is a different path entirely (below).

## I want to cut a release — push a tag, let CI build (NEVER a local build)

DECISION: am I **verifying a change** (Lane ladder above, stays on my machine) or
**cutting a release**? A release is **GitHub-CI-built** — the canonical,
reproducible, multi-platform artifact. Do **not** run a 2-3 h local `nix build` to
"make the release": it's Linux-only, not canonical, and a stale local engine can
silently drop modules a fresh CI checkout bakes correctly.

1. write `.github/release-notes/vX.Y.Z.md`. Seed the factual sections with
   `bun run release:notes vPREVIOUS HEAD`, then add a short user-facing summary
   and highlights. The tag gate refuses a release without this file.
2. land the work from its lane: `safe-push --to main`
   (CI checks out fresh and runs `import` from scratch — none of the stale-engine
   skip-traps a local build hits; the binary is built from the landed commit.)
3. create an annotated tag on that commit:
   `git tag -a vX.Y.Z -m "gjoa vX.Y.Z" <commit>`
4. publish the tag separately: `safe-push --tag vX.Y.Z`
5. CI `release.yml` fans out to `build-{linux,macos,windows}.yml` on **free
   GitHub-hosted runners** by default (`ubuntu-24.04` / `macos-26`, Windows
   cross-compiled on Linux; `-j2`, ~1-2 h each) → assembles a **DRAFT** GitHub
   release with all six binaries and the versioned authored notes. (Blacksmith is a faster **paid** runner —
   opt-in per job via `fast: true`; it costs credits, so it is NOT the default.)
6. review the draft + notes → **Publish**. CI never
   auto-publishes — a human clicks Publish.

Watch it: `gh run watch` · `gh run list --workflow=release.yml`.

## I want to bump the Firefox version

That's a Lane 3 change to `gjoa.json`:

```
bun run security:bump        # writes the latest stable to gjoa.json
bun run import               # re-extracts the new tarball, applies patches
# if any patch fails to apply → regen via `git diff` inside engine/
# update its baseline-firefox header to the new version
bun run preflight          # validate the imported source before building
```

## I broke something and want to start over

Mach state confused:

```
gjoa clean        # mach clobber — wipes engine/obj-*/
```

Engine state confused (overlays mid-apply or patches half-applied):

```
bun run clean     # removes engine/
bun run init      # downloads + re-imports from scratch (~10 min)
```

## Glossary, in one line each

- **Lane 1** = chrome Beagle/CSS, no rebuild, seconds.
- **Lane 2** = `.sys.mjs` / patch / branding, `mach build faster`, ~30 s.
- **Lane 3** = C++/Rust / version bump / configure flags, full rebuild, 30–60 min.
- **mach** = Mozilla's build tool, lives at `engine/mach`. Used for Lane 2/3 iteration.
- **nix build** = hermetic packaged build via `flake.nix`. Used for distribution.
- **omni.ja** = the zip inside the binary holding all chrome JS/CSS. Re-zipped by `mach build faster`.
- **`gjoa-dev/`** = symlink to `dist/chrome/` next to the mach binary. Lets you iterate on chrome bundles without re-zipping.
