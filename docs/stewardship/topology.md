# Stewardship topology (GENERATED — do not edit by hand)

> Projection of `tools/scripts/preflight.bjs` (the gate registry) +
> `docs/stewardship/*.md` + `package.json` scripts. Regenerate with
> `bun tools/stewardship/topology.mjs gen`; drift or a dangling reference fails
> `bun tools/stewardship/topology.mjs check`. A hand-list would rot — this can't.

## Preflight gates (22)

| Gate | Name | Enforce | Cited by |
|---|---|---|---|
| A | patches apply clean on fresh source | hard | churn, security |
| B | jar.mn pattern matches working example | hard | churn |
| C | no production-mode TODO/no-op landmines | hard | churn |
| D | dep floors satisfied | hard | churn |
| F | nix daemon will accept flake settings | hard | churn |
| G | nix flake evaluates without errors | hard | churn |
| I | chrome bundle three-way alignment | hard | churn |
| J | scriptlet bundle integrity | hard | churn, security |
| K | engine/ reflects current source (import-currency) | hard | _(undocumented)_ |
| L | surface contracts (declared upstream deps resolve) | hard | churn, security |
| M | beagle compiler pinned (beagle-currency) | hard | churn |
| N | knobs backed + reversible (knob-not-delete) | hard | churn |
| O | no bare beagle/ import in shipped gjoa .sys.mjs | hard | churn |
| P | patch hashes match recorded manifest | hard | security |
| Q | $$bc runtime export-closure (emit ↔ core.js) | hard | _(undocumented)_ |
| R | security mitigations intact | hard | security |
| S | security-critical patches persist | hard | churn, security |
| T | stewardship tapestry intact (docs ↔ machinery) | hard | _(undocumented)_ |
| U | patch numbering coherent (domains contiguous) | warn | churn |
| V | upstream provenance lock current | warn | churn |
| W | dark-mode contrast backstop ships ON | hard | _(undocumented)_ |
| X | release tag matches gjoa.json displayVersion | hard | churn |

## Health

- domains: 5 (README, churn, performance, security, testing)
- file references: 53 (53 resolve, 0 dangling)
- script references: 17 (17 resolve)
- gates: 22 (18 documented, 4 undocumented)
- undocumented gates (add to a domain doc): K, Q, T, W
