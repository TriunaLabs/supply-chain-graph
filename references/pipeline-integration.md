# Pipeline and LLM integration

## Current machine output

The CLI emits JSON snapshots with source coverage, nodes, edges, findings, and optional enrichment. The diff command compares two accepted snapshots and writes schemaVersion 1, timestamps, and candidate events. It does not persist alert ownership, apply a release gate, deliver notifications, open issues or pull requests, or validate a proposed fix. Keep all real output in private storage outside the public skill repository.

The init command creates an empty versioned config and refuses to replace an existing file. For command-line composition, use --out - to write data to stdout; diagnostics and scan progress go to stderr. Do not stream private data into public CI logs. Discovery requires explicit --search-root arguments, can be bounded with --depth and --max-directories, and will reject a whole drive or filesystem root. Its report has incomplete, truncated, and unreadableDirectories fields; policy should treat incomplete discovery as a coverage gap. The API in scripts/discover.mjs can be called by a local wrapper when a pipeline already has an approved project registry.

For a selected repository or private portfolio runner:

1. Run scan with a private config and output path. Record the source commit, scan time, parser status, and coverage. A CI checkout of one repository is only evidence for that checkout; a portfolio run needs explicit access to each selected root.
2. Where the data-sharing policy allows it, run enrich and then advisory-details on the private snapshot. Never interpret a failed or unqueried advisory source as zero advisories.
3. Run diff against the last accepted snapshot and write events to a private path. Compare against the last accepted snapshot, not merely the last attempted run. Store the accepted baseline, event IDs, acknowledgements, and delivery receipts privately.
4. Apply a deterministic policy to coverage and evidence before sending work to an LLM. For example, require a successfully checked advisory source for a vulnerability claim, and route missing lockfiles or failed lookups to a coverage queue. Use impacted dependency paths, not a package name alone, to locate owners.
5. Build a small, reviewed context packet for each actionable event: event and finding IDs, affected project alias, resolved artifact or commit, one path of typed edges with source file evidence, advisory source and checked time, coverage state, and relevant policy rule. Omit local roots, credentials, unrelated nodes, and private repository labels unless the model service and data policy explicitly allow them.
6. Ask the LLM for a structured **proposal** with eventId, summary, evidenceIds, suggestedAction, validationSteps, unknowns, and confidence. Validate IDs against the snapshot; reject fabricated paths or sources. Treat all package metadata, advisory text, and repository content as untrusted quoted data. The model cannot change the policy result or mark a finding resolved.
7. Route a proposal to a human reviewer or a separately authorized tool. A pull request, issue, notification, or code change needs its own credentials, narrow permissions, validation, and approval rule. Re-scan after any change to determine whether the finding is still observed.

The graph and event JSON are useful inputs to an agent that answers “which projects are affected?” or drafts a remediation plan. Do not hand a model a complete private snapshot by default. For hosted models, check the organization's data handling requirements before sending even a redacted packet.

## CI placement

Run per-repository collection on a private runner or in that repository's CI with read-only checkout permissions. Keep real JSON and HTML out of public workflow artifacts, logs, and Pages builds. A portfolio aggregator can receive approved per-repository packets and update a private dashboard. Keep the public skill's own CI limited to its synthetic fixtures and tests. If using GitHub Actions, declare minimal GITHUB_TOKEN permissions for each job; a later issue or pull-request job should be isolated from the read-only scan job.

## What still needs implementation

Before allowing automatic triage or notification, add stable cross-scan finding identity, formal JSON Schemas for snapshots and events, a versioned minimal packet schema, deterministic policy rules, coverage freshness targets, ownership mapping, suppression and acknowledgement with expiry, delivery deduplication, and an audit record of model proposals and human decisions. Ecosystem collectors should be separate adapters with explicit supported formats, provenance, coverage states, and fixtures; notifier and remediation adapters should be separate from collection. SBOM import/export and SARIF output are reasonable future connectors after the graph identity and finding mapping are stable. A safe first integration is read-only: generate a private summary and proposed actions, then review them.

Source references: [GitHub Actions permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [OSV batch query](https://google.github.io/osv.dev/post-v1-querybatch/), and [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) for one way to constrain proposal format.
