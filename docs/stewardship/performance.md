# Performance

Performance work starts from a named user-visible cost and the lowest tool that
measures it.

| Surface | Implementation | Measurement |
|---|---|---|
| Startup | Firefox build and Gjoa loader | `bun run bench:cold-start` |
| Memory | Browser processes | `bun run bench:memory` |
| Dark-mode rendering | Engine inversion plus content actor | `bun run darkmode:regress` |
| Patch carrying cost | `patches/` and `src/gjoa/` | `bun run cost` |

Use chrome code for chrome behavior, `.sys.mjs` at Firefox seams, and native code
only when the engine must own the operation. Measure the changed surface once;
keep a check only when it deterministically changes the shipping decision.

Release builds use the flags in `flake.nix` and the CI workflows. The native build
is machine-specific and must not be distributed.
