# End-to-end walkthrough on synthetic data

Every command below runs against files in this repository. No real project is scanned, nothing is sent anywhere, and every output lands under `local/`, which Git ignores. Run it from the repository root with Node 20 or newer.

```sh
# 1. Scan the synthetic fixture and render the dashboard.
node scripts/supply-chain.mjs scan --config examples/portfolio.example.json --out local/snapshot.json
node scripts/supply-chain.mjs render --snapshot local/snapshot.json --out local/dashboard.html

# 2. Validate the snapshot against its contract, then evaluate it with the reporting-only default policy.
#    (Add --at ISO-TIME to make freshness reproducible; a time earlier than the scan reads as unknown freshness.)
node scripts/supply-chain.mjs validate --schema snapshot --file local/snapshot.json
node scripts/supply-chain.mjs evaluate --snapshot local/snapshot.json --policy contracts/policy.default.json --out local/policy-result.json
node scripts/supply-chain.mjs summary --result local/policy-result.json --out -
```

The fixture has no enrichment, so the summary shows every npm package version as `unqueried`, a PyPI package as `unsupported`, and one actionable finding: the workflow action pinned to a tag. Nothing says "safe".

```sh
# 3. Build the redacted packet and look at what a reviewer, webhook, or model would receive.
node scripts/supply-chain.mjs packet --result local/policy-result.json --policy contracts/policy.default.json --out local/packet.json

# 4. See what the webhook example would send, without a destination. It refuses to send for real until you set
#    SCG_WEBHOOK_URL and SCG_WEBHOOK_SECRET.
node examples/notify/webhook.mjs --packet local/packet.json --receipts local/receipts.json --dry-run
```

To see the full chain, including an advisory with a fixed boundary, a failed lookup, a deprecation, and transitions, use the hand-written enriched example instead of the fixture:

```sh
# 5. Evaluate the synthetic enriched snapshot, then evaluate it again as if a later lookup had failed.
node scripts/supply-chain.mjs evaluate --snapshot contracts/examples/enriched-snapshot.json --policy contracts/policy.default.json --at 2026-10-31T00:00:00Z --out local/first.json
node scripts/supply-chain.mjs packet --result local/first.json --out local/first-packet.json

# 6. A model's proposal for the advisory item, and a human decision bound to it: both synthetic.
node scripts/supply-chain.mjs check-proposal --proposal contracts/examples/proposal.json --packet contracts/examples/agent-packet.json
node scripts/supply-chain.mjs check-decision --decision contracts/examples/decision.json --proposal contracts/examples/proposal.json --packet contracts/examples/agent-packet.json --at 2026-11-01T00:00:00Z

# 7. Change one character of the proposal and the decision no longer authorizes it.
node -e "const p=require('./contracts/examples/proposal.json'); p.targetArtifact.version='1.0.4'; require('fs').writeFileSync('local/changed-proposal.json', JSON.stringify(p))"
node scripts/supply-chain.mjs check-decision --decision contracts/examples/decision.json --proposal local/changed-proposal.json --packet contracts/examples/agent-packet.json --at 2026-11-01T00:00:00Z

# 8. Run the whole pipeline with one span per stage; nothing is exported without SCG_OTEL_ENDPOINT.
node examples/otel/run-pipeline.mjs --config examples/portfolio.example.json --private local/otel-run
```

Step 7 exits 1 with "the plan changed after review and needs a new decision". Step 8 prints the spans and "No OTLP endpoint configured; nothing was exported."

What this walkthrough does not do: call OSV or npm (`enrich` is a separate, opt-in command), deliver a webhook, call a model, or write to any repository. Those are the user's decisions, made with the boundaries in `SECURITY.md`, `ci-setup.md`, and `hitl-remediation.md`.
