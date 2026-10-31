# Contracts

Versioned JSON Schemas for the machine-readable documents this tool reads and writes, plus synthetic examples. Every document carries an integer `schemaVersion`; a document whose major version is not the supported one is rejected before field validation, never reinterpreted. The validator in `scripts/schema.mjs` is dependency-free and covers the subset of JSON Schema these files use.

| Schema | Written by | Read by |
| --- | --- | --- |
| `snapshot.v1.schema.json` | `scan`, extended by `enrich` and `advisory-details` | `render`, `diff`, `evaluate`, `serve` |
| `diff-events.v1.schema.json` | `diff` | a caller's notification pipeline |
| `policy.v1.schema.json` | you, starting from `policy.default.json` | `evaluate` |
| `policy-result.v1.schema.json` | `evaluate` | gates, packet builders, later `evaluate --previous` runs |

Validate any document:

```sh
node scripts/supply-chain.mjs validate --schema snapshot --file PRIVATE_SNAPSHOT
```

Evaluate a snapshot deterministically. The evaluation time is an input so freshness is reproducible; omit `--at` to use the current time.

```sh
node scripts/supply-chain.mjs evaluate --snapshot PRIVATE_SNAPSHOT --policy contracts/policy.default.json --at 2026-10-31T00:00:00Z --out PRIVATE_RESULT
node scripts/supply-chain.mjs evaluate --snapshot PRIVATE_SNAPSHOT --policy PRIVATE_POLICY --previous PRIVATE_LAST_RESULT --out PRIVATE_RESULT
```

Exit codes: 0 evaluated (gate passed or not configured), 1 invalid input or tool failure, 3 a configured gate failed. The default policy reports everything and fails nothing; copy it privately and set `gate.failOn` to actionability values or severity labels to make it a gate.

## What the policy result guarantees

- **Coverage states** per npm package version and check: `checked-and-none`, `checked-with-results`, `failed`, `unqueried`, `unsupported`, `stale`. A policy can route any of them to `needs-review`; there is no `safe` or `resolved` outcome anywhere in the schema.
- **Finding identity** (`f_` + 16 hex) is derived from rule ID, advisory ID, ecosystem, exact artifact (`name@version`) or commit, project ID, and the occurrence's install location relative to the project root. Absolute paths, labels, and timestamps are excluded, so the same finding keeps its ID across machines and runs. The human-readable dependency path stays as evidence. `v1Ids` maps a coverage finding back to the ID the scanner wrote, so existing `diff` consumers keep working.
- **Event identity** (`e_` + 16 hex) adds the transition and the observed version or commit: retries deduplicate, while a later reappearance at a new version alerts again.
- **No false resolution.** With `--previous`, a finding is `no-longer-observed` only after a comparable successful check (OSV or registry checked, or the artifact gone from the lockfile). If the later check failed, was skipped, or is stale, the transition is `unknown` and the prior finding stays open.
- **Stale is not clean.** A check older than `freshness.maxAgeHours` keeps its finding with `coverageState: stale`; a snapshot older than that adds a `stale-scan` finding.

## Examples

`examples/enriched-snapshot.json` is a hand-written synthetic snapshot covering a newly observed OSV advisory with severity and fixed boundary, a checked package with zero advisories, a failed lookup, a package never queried, a PyPI package this tool cannot check, a missing lockfile, an npm deprecation confirmed by the registry, a cached lockfile deprecation, a newer `latest` tag, and an unpinned workflow action. `examples/policy-result.json` is its evaluation at `2026-10-31T00:00:00.000Z` with the default policy; a test fails if it drifts. Regenerate it with:

```sh
node scripts/supply-chain.mjs evaluate --snapshot contracts/examples/enriched-snapshot.json --policy contracts/policy.default.json --at 2026-10-31T00:00:00.000Z --out contracts/examples/policy-result.json
```

Evaluating the same snapshot at `2026-11-30` shows the stale states and the `stale-scan` finding while every other finding keeps its identity.
