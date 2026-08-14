# Test policy

Tests prove current behavior at the cheapest deterministic layer that can own the
claim.

- Use Beagle/unit tests for pure logic.
- Use browser integration tests only for behavior that crosses the browser seam.
- Synchronize on an observable condition with `await-true`; fixed sleeps require a
  paint or platform timing reason.
- Keep one product claim per test and table-drive close variants in one browser
  session.
- A flaky test is diagnostic until its race is fixed.
- Deleted behavior takes its tests with it. Do not retain negative assertions for
  old names, old schemas, aliases, or removed UI.

The integration runner selects current tests by file, subsystem, or lane through
`tests/integration/tags.json`:

```sh
bun run test:tabs
bun run test:darkmode
bun run test:changed
bun run test:integration
bun run test:integration:all
```

Use the smallest selection that covers the changed behavior. The full and network
lanes are release checks, not the inner loop.

Every check has a bounded supervisor. On the first failure, preserve the error and
stop the affected lane; do not retry a gate into success.
