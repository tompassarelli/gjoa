# Stewardship

Gjoa carries a small Firefox patch surface. Keep the current line easy to change:

- [`testing.md`](testing.md) defines the direct semantic-test loop.
- [`performance.md`](performance.md) maps user-visible costs to current measurements.
- [`churn.md`](churn.md) describes source pinning, structural patches, and compiler
  boundaries.
- [`security.md`](security.md) describes the live security checks.
- [`topology.md`](topology.md) is generated from the current preflight registry.

`bun run preflight` checks current source, pins, patches, generated output, and
security invariants before an expensive build. A new gate requires a reproducible
product failure and a deterministic check that changes the build decision.

Removal means absence. Delete old behavior, its adapters, its tests, and its prose;
Git history is the archive.
