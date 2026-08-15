# nix dev options

Short reference: when to use mach vs nix, and the impurity tradeoffs.

## TL;DR

- **Daily dev = mach.** Run `direnv allow` once at the repository root; `.envrc` activates `.#mach`. Then use `cd engine && ./mach build [faster]`. The writable install lives at `engine/obj-*/dist/bin/`, and chrome JS hot-reloads via `gjoa-dev/`.
- **Nix = distribution only.** `nix build .#gjoa --impure`. Read-only install at `/nix/store/...`. Sealed `omni.ja`. No iteration.
- **If chrome JS/CSS/layout is broken: use mach.** Nix gives you an immutable binary that requires another nix build for every change.

## What triggers a nix rebuild

| Change | Triggers full nix? |
|---|---|
| `src/gjoa/chrome/bjs/**/*.bjs` (Beagle chrome modules) | No — Lane 1 via `gjoa sync` |
| `src/gjoa/chrome/css/*.uc.css` | No — Lane 1 via `gjoa sync` |
| `src/gjoa/browser/**/*.sys.mjs` overlay | Yes (source tree → engine/) |
| `patches/*.patch` | Yes |
| `gjoa.json` version pin | Yes (fresh tarball + full build) |
| `flake.nix` | Yes |

Mach handles all of the above incrementally once the objdir exists.

## Impurity options (ranked)

1. **`--impure` flag (already used)** — reads env vars and paths outside
   the flake. Required so engine/ can live outside the flake source.
   Keep.
2. **`__noChroot = true`** — disables sandbox for the derivation, lets
   sccache write to a persistent host path. Requires
   `sandbox = relaxed` in nix.conf at the daemon level. Not currently
   wired.
3. **`__impure = true`** — full impurity, no input hashing. Don't use;
   no win over `__noChroot` and breaks output-path stability.
4. **`sandbox = false` globally** — system-wide. Too broad.
5. **Direct mach in dev shell** — the recommended daily path. Skip nix
   entirely for development.
6. **`programs.ccache` NixOS module** — alternative to sccache, system-
   wide. Worth it only if you build many nix C/C++ projects.

Mach iteration via `gjoa sync` remains the fast path regardless of Nix cache
configuration.
