# SPIKE #113 — beagle as a pinned nix flake input

> **STATUS: SPIKE / DESIGN. Branch `spike/nix-flake-beagle`. NOT merged, NOT
> built.** This document is the feasibility verdict + migration plan + risk
> assessment for replacing the raco-link + `PLTCOLLECTS` beagle pin with a nix
> **flake input**. The companion `flake.beagle-input.draft.nix` is a WIP sketch
> of the input declaration + devshell wiring — illustration only.

---

## TL;DR verdict

**Feasible, with ONE upstream blocker on beagle.** beagle already ships a
consumable `flake.nix` (`packages.default`) whose lock pins to exactly the SHA
gjoa wants (`9d791ed…` = `configs/beagle.ref`). It installs `bin/beagle*`
(wrapped with racket+babashka on PATH) and copies the racket collection +
`lib/` runtime into `$out/lib/beagle/`. So a `beagle.url = "github:Autonymy/beagle?rev=<SHA>"`
flake input gives gjoa a hermetic, store-path beagle for **both** the nix build
and local direnv — no global `raco link`, no `PLTCOLLECTS` symlink, no
`node_modules/beagle` dance.

**The blocker:** beagle's current flake `installPhase` does NOT make the
installed `bin/beagle-build` resolve its own `#lang beagle/js` racket collection.
It copies the collection to `$out/lib/beagle/` and patches `BEAGLE_DIR`, but
`beagle-build` runs `racket "$src"` and relies on the collection being resolvable
*externally* (via `raco link` or `PLTCOLLECTS`) — and the flake's `wrapProgram`
only does `--prefix PATH`, never `--set PLTCOLLECTS`. So a bare flake-built
`beagle-build` would fail to read `#lang beagle/js` in a pure store. Closing this
is a **~5-line beagle flake change** (add `--set PLTCOLLECTS "$out/lib"` or
`--prefix PLTCOLLECTS` to the `wrapProgram` loop, with the collection laid out as
`$out/lib/beagle/`). Until beagle ships that, gjoa can still adopt the input and
set `PLTCOLLECTS` to the store path in its **own** devshell/flake — gjoa-side
unilateral, no beagle change strictly required (see "what gjoa can do today").

---

## Current pinning mechanism — the 6 consumption points

The pin (`configs/beagle.ref` = `9d791ed…`) is consumed in **six** distinct
places. Any migration must address every one:

| # | Consumer | What it needs | How it resolves today |
|---|----------|---------------|-----------------------|
| 1 | `.envrc` (local dev) | `beagle-build` CLI + racket `beagle` collection | symlinks `$BEAGLE_PIN_ROOT/beagle-lib` → `.beagle-pin-collects/beagle`, sets `PLTCOLLECTS=.beagle-pin-collects:` |
| 2 | `.envrc` (bun runtime) | `beagle/core.js` ($$bc value-semantics runtime) | symlinks `node_modules/beagle` → `$BEAGLE_PIN_ROOT/beagle-lib/lib/beagle` |
| 3 | `package.json` `tools:compile` | `bin/beagle-build` to bootstrap-compile `build-tools.bjs` | `bash "${BEAGLE_PIN_ROOT:-~/code/beagle-pin}/bin/beagle-build"` |
| 4 | `tools/build-tools.bjs` + `tools/prep/overlay.bjs` | `bin/beagle-build` + vendor `core.js` | reads `BEAGLE_PIN_ROOT` env (default `~/code/beagle-pin`) |
| 5 | CI (`build-*.yml`) | clone beagle @ pin, register collection, link runtime | `git clone tompassarelli/beagle` @ ref + `raco pkg install --link` + `ln -sfn … node_modules/beagle` |
| 6 | `nix build` (`flake.nix`) | beagle is **not currently an input** | the nix `buildMozillaMach` consumes pre-overlaid `engine/`; beagle-build runs OUTSIDE nix during `bun run import`, so the nix build path never sees beagle directly |

**Key structural fact:** beagle-build is invoked during `bun run import` (the
overlay step), which is a *prerequisite* run BEFORE `nix build`, not inside the
nix derivation. The nix derivation only ingests the already-compiled `engine/`.
So consumer #6 ("nix build uses beagle") is really about the **devshell**
providing `beagle-build` on PATH for `bun run import`, not about the
`buildMozillaMach` derivation taking a beagle input. This substantially shrinks
the migration: the nix-build derivation itself needs no change; the devshell does.

Enforcement: **Gate M** (preflight.bjs:410) hard-fails if `~/code/beagle-pin`
HEAD ≠ `configs/beagle.ref`. **Gate Q** (preflight.bjs:579) asserts the emitted
chrome's `$$bc` symbol references are a subset of the vendored `core.js` export
surface (the emit↔runtime contract).

---

## Feasibility detail — can the beagle flake expose what gjoa needs?

**(a) The racket compiler (`bin/beagle-build`, `beagle-check`, …):** YES, the
flake's `installPhase` copies all `bin/beagle*` and wraps them with
racket+babashka on PATH. **CAVEAT (the blocker):** `beagle-build` needs the
`beagle` racket collection resolvable; the flake copies it to `$out/lib/beagle/`
but does not wire `PLTCOLLECTS`, and `beagle-build` itself doesn't set it. The
collection is source-only (no precompiled `compiled/` bytecode) — racket will
JIT-compile the `.rkt` on first run, which works but is slower cold; acceptable.

**(b) The vendored `core.js` runtime:** YES. The flake copies `beagle-lib/lib` →
`$out/lib/beagle/lib`, so `core.js` lands at
`$out/lib/beagle/lib/beagle/core.js`. gjoa's `overlay.bjs` `vendor-core-js!`
reads `<root>/beagle-lib/lib/beagle/core.js` today; under the flake the path
shape differs (`$out/lib/beagle/lib/beagle/core.js`, no `beagle-lib/` segment),
so the `BEAGLE-CORE-SRC` resolver must branch on store-vs-worktree layout (or a
single `BEAGLE_CORE_JS` env var the devshell/CI both export).

**(c) Pin is the single source of truth:** YES. beagle's `flake.lock` already
locks `nixpkgs`-style inputs, and a gjoa `beagle` input pinned by `?rev=<SHA>`
records the SHA in gjoa's `flake.lock`. The SHA `9d791ed…` is the live `main`
HEAD on both `Autonymy/beagle` (canonical) and `tompassarelli/beagle` (CI's
fork) — they're in sync. So the flake input resolves cleanly.

---

## Migration plan (ordered)

### Phase 0 — upstream prerequisite (BLOCKED ON BEAGLE, or work around)
0a. **(beagle repo)** Make the flake-installed `beagle-build` self-resolve its
   collection: in the `wrapProgram` loop add
   `--set PLTCOLLECTS "$out/lib"` (collection laid out so `$out/lib/beagle`
   is the `beagle` collection). Verify `nix run .#default -- bin/beagle-build foo.bjs`
   compiles a `#lang beagle/js` file in a pure store with no `raco link`.
   *This is the one thing gjoa cannot do unilaterally if we want the
   beagle-provided CLIs to "just work".*
0b. **Workaround if 0a is not yet upstream:** gjoa sets `PLTCOLLECTS` to the
   beagle input's store-path collection in its OWN devshell + CI, pointing at
   `${beagle}/lib`. This keeps gjoa moving without a beagle change, at the cost
   of gjoa knowing beagle's internal `$out` layout (couples to it).

### Phase 1 — declare the flake input (gjoa, unilateral)
1. Add to `flake.nix` `inputs`:
   ```nix
   beagle.url = "github:Autonymy/beagle?rev=9d791ed57e84e8a1ebe48a5dda588f9842168e26";
   beagle.inputs.nixpkgs.follows = "nixpkgs";
   ```
   `nix flake lock` records the SHA in `flake.lock`. (See draft.)
2. Thread `beagle` through `outputs = { self, nixpkgs, flake-utils, beagle }:`
   and `let beaglePkg = beagle.packages.${system}.default;`.

### Phase 2 — devshells expose beagle on PATH (gjoa, unilateral)
3. Add `beaglePkg` to `devShells.default.packages` and `devShells.mach.packages`.
   This puts `beagle-build`, `beagle-check`, etc. on PATH for `bun run import`.
4. In the devshell `shellHook`, export the two env vars the tooling reads, now
   pointing at the **store path** instead of `~/code/beagle-pin`:
   - `export BEAGLE_PIN_ROOT="${beaglePkg}"` — **(see Phase 4: tooling resolver
     must learn the store layout, OR we keep `BEAGLE_PIN_ROOT` pointed at a
     worktree and only add a separate `BEAGLE_BUILD`/`BEAGLE_CORE_JS`)**.
   - If Phase-0a not landed: `export PLTCOLLECTS="${beaglePkg}/lib:"`.

### Phase 3 — `.envrc` drops the symlink dance (gjoa, unilateral)
5. Remove the `ln -sfn … .beagle-pin-collects/beagle`, `PLTCOLLECTS` export, and
   `ln -sfn … node_modules/beagle` block from `.envrc`. `use flake` (already the
   first line) now carries beagle via the devshell. Keep `MOZ_PARALLEL_BUILD`
   and the security-status print.
6. Delete `.beagle-pin-collects/` from the tree + `.gitignore`.

### Phase 4 — tooling resolvers learn store-path layout (gjoa, unilateral)
7. `tools/build-tools.bjs` + `tools/prep/overlay.bjs`: the `BEAGLE-BUILD` and
   `BEAGLE-CORE-SRC` resolvers assume `<root>/bin/beagle-build` and
   `<root>/beagle-lib/lib/beagle/core.js`. The flake store path is
   `<root>/bin/beagle-build` (same) but `<root>/lib/beagle/lib/beagle/core.js`
   (no `beagle-lib/`). Options:
   - **Preferred:** introduce explicit env vars `BEAGLE_BUILD` (path to the CLI)
     and `BEAGLE_CORE_JS` (path to core.js), exported by both devshell and CI,
     defaulted in the resolver to the old worktree layout for back-compat. The
     tooling stops hardcoding the directory shape.
   - Minimal: keep `BEAGLE_PIN_ROOT` but make the resolver try both
     `<root>/beagle-lib/lib/beagle/core.js` (worktree) and
     `<root>/lib/beagle/lib/beagle/core.js` (store), first-existing wins.
8. `package.json` `tools:compile`: replace the hardcoded
   `"${BEAGLE_PIN_ROOT:-$HOME/code/beagle-pin}/bin/beagle-build"` with
   `"${BEAGLE_BUILD:-${BEAGLE_PIN_ROOT:-$HOME/code/beagle-pin}/bin/beagle-build}"`
   so the devshell's `BEAGLE_BUILD` (store path) takes precedence, falling back
   to the worktree for non-nix users.

### Phase 5 — CI switches to the flake input (gjoa, unilateral)
9. `.github/workflows/build-*.yml`: replace the 4 beagle steps (Install Racket /
   Checkout beagle / Register collection / Link runtime) with a single
   `nix develop` (or `nix build .#beagle` from the input) that provides
   `beagle-build` + `core.js` from the locked input. CI then matches local
   exactly (the whole point), and the SHA comes from `flake.lock`, not a
   second `git clone` of `tompassarelli/beagle`.

### Phase 6 — pin source-of-truth reconciliation (gjoa, unilateral)
10. Decide: does `configs/beagle.ref` stay, or does `flake.lock` become the pin?
    **Recommendation: keep `configs/beagle.ref` as the human-facing pin, add a
    CI check that `flake.lock`'s beagle rev == `configs/beagle.ref`.** Rationale:
    `beagle.ref` is reviewed, greppable, and read by non-nix tooling
    (`overlay.bjs` provenance header, Gate M, CI checksum). Making `flake.lock`
    the sole pin would hide the SHA from the bun tooling that stamps the vendored
    `core.js` header. A tiny "pins agree" gate keeps them in lockstep — mirrors
    how `gjoa.json` stays the Firefox source-of-truth that `flake.nix` reads.

### Phase 7 — preflight Gate M / Q adapt (gjoa, unilateral)
11. **Gate M** today asserts `~/code/beagle-pin` HEAD == `configs/beagle.ref`.
    Post-migration the pin lives in `flake.lock`, so Gate M becomes: assert
    `flake.lock`'s `beagle` input `locked.rev` == `configs/beagle.ref` (a pure
    file-vs-file check, no worktree, no `git -C … rev-parse`). Simpler and more
    robust (no detached-worktree failure mode).
12. **Gate Q** is unaffected in spirit — it compares emitted chrome `$$bc`
    references against the vendored `core.js` surface. Only the *path* to the
    "compiler-side" beagle changes (store path), not the assertion. The
    `equivV`-compat shim in `overlay.bjs` stays until the pinned beagle's
    `core.js` exports `equivV` natively.

### Phase 8 — keep raco-link as a transition fallback, then remove
13. During transition, the resolver's worktree fallback (Phase 4) means a dev
    with `~/code/beagle-pin` still works even if the flake input is flaky. Once
    the flake path is proven green in CI + a local `bun run import`, delete the
    `~/code/beagle-pin` worktree dependency from Gate M, the resolvers, and the
    docs. **Do NOT delete the fallback in the same PR that introduces the
    input** — two PRs, so a regression is bisectable.

---

## Risk assessment

| Risk | Likelihood | Impact | De-risk |
|------|-----------|--------|---------|
| **Flake-built `beagle-build` can't resolve `#lang beagle/js` collection** (no `PLTCOLLECTS` in wrapper) | HIGH (confirmed gap) | Build-blocking | Phase 0a upstream fix, OR Phase 0b gjoa-side `PLTCOLLECTS=${beagle}/lib`. Verify with one `bun run import` before merging. |
| **Racket JIT-compiles source-only collection every cold run** (no `compiled/` in store) | Medium | Slower first `import`, not breaking | Acceptable; or have beagle's flake `raco make` the collection in `buildPhase` to ship bytecode. |
| **core.js path shape differs** (`lib/beagle/lib/beagle/core.js` vs `beagle-lib/lib/beagle/core.js`) | HIGH (confirmed) | `vendor-core-js!` throws "not found" | Phase 4 `BEAGLE_CORE_JS` env var / dual-path resolver. |
| **bun runtime can't resolve `beagle/core.js` import** without `node_modules/beagle` | Medium | tooling runtime error | Keep a `node_modules/beagle` symlink to `${beagle}/lib/beagle/lib/beagle` in the devshell hook, OR set bun resolution via the import map. Lowest-friction: devshell `ln -sfn`. |
| **mach path vs nix path divergence** — mach devshell (`nix develop .#mach`) and the `bun run import` outside nix must use the SAME beagle | Medium | emit/runtime skew (the exact class Gate Q guards) | Both devshells take the same `beaglePkg` input ⇒ identical store path ⇒ stronger guarantee than today's two-symlink setup. This is a *net improvement*. |
| **CI fork URL mismatch** — CI clones `tompassarelli/beagle`, canonical is `Autonymy/beagle` | Low (in sync now) | drift if forks diverge | Flake input pins ONE URL (`Autonymy`) by SHA; CI stops cloning the other fork. Eliminates the discrepancy. |
| **`flake.lock` and `configs/beagle.ref` drift** | Medium | confusing double-pin | Phase 6 "pins agree" CI gate. |
| **`--impure` nix build + beagle input interaction** — gjoa's `nix build` already needs `--impure` (reads `engine/` outside flake src). Adding an input doesn't change that. | Low | none | beagle input is pure (store path); `--impure` is unrelated (it's for `engine/`). No new coupling. |
| **Non-nix contributors** (no nix, build via raco) | Low | broken for them | Phase 4 fallbacks keep `~/code/beagle-pin` + `raco link` working; document both paths. |

---

## What's BLOCKED on beagle vs what gjoa can do unilaterally

**Blocked on beagle (or requires gjoa to couple to beagle's `$out` layout):**
- A flake-provided `beagle-build` that resolves its own collection with zero
  extra env (Phase 0a). Without it, gjoa must set `PLTCOLLECTS=${beagle}/lib`
  itself (Phase 0b) — works, but gjoa hardcodes beagle's internal layout.
- Shipping precompiled bytecode (`raco make`) for fast cold runs — beagle flake
  change; optional.

**gjoa can do unilaterally TODAY (even before any beagle change), using 0b:**
- Declare the `beagle` flake input pinned to the SHA (Phase 1).
- Wire devshells to put `beagle-build` on PATH + set `PLTCOLLECTS`/`BEAGLE_CORE_JS`
  to store paths (Phases 2–4).
- Strip `.envrc` symlinks, switch CI to the input, simplify Gate M (Phases 3, 5, 7).
- Keep `configs/beagle.ref` as the reviewed pin + a "pins agree" gate (Phase 6).

**Net:** gjoa can land the whole migration unilaterally via the Phase-0b
workaround; the only thing gated on beagle is making the beagle-provided CLI
*self-contained* so gjoa doesn't reach into `${beagle}/lib`. Recommend filing a
one-line beagle issue for Phase 0a, but not blocking gjoa on it.
