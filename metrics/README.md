# `metrics/` — local measurement telemetry

The single home for run-local measurement data. The data files are gitignored
(run-local, machine-specific); only this README is tracked.

| file | written by | read by | what it is |
|------|-----------|---------|------------|
| `runs.jsonl` | `tools/test-driver/record-metrics.bjs` (tees the integration runner's NDJSON) | `bun run test:report`, `bun run test:profile` | one line per test per run — duration history for p50/p95-vs-budget + diminishing-returns trend |
| `audit-ledger.jsonl` | `bun run test:profile` | `bun run test:profile` | one line per test-optimization audit — tracks `estSavingsMs` over time so a *falling* return signals the suite is tuned |

Not here (deliberately):
- **Build outcomes / postmortems** → `private-docs/build-logs/` (can leak nix paths).
- **Security-audit ledger** → `private-docs/security-audit-ledger.json` (private).

Budgets that the telemetry is graded against: `configs/test-budgets.json`.
Policy + profiler: [`docs/stewardship/testing.md`](../docs/stewardship/testing.md).

(Consolidated from the old `.test-metrics/` — task #132.)
