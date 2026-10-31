# Opt-in telemetry example

`telemetry.mjs` is a small tracer and `run-pipeline.mjs` an example that wraps `scan`, optional `enrich`, `evaluate`, `packet`, `check-proposal`, and `check-decision` in one span each. It exists to diagnose the pipeline (which stage is slow or failing, how coverage states trend), not to prove approval or remediation: the policy result, proposal, decision, and receipt files remain the audit record.

```sh
node examples/otel/run-pipeline.mjs --config PRIVATE_CONFIG --private PRIVATE_DIR
SCG_OTEL_ENDPOINT=http://127.0.0.1:4318 node examples/otel/run-pipeline.mjs --config PRIVATE_CONFIG --private PRIVATE_DIR
```

Without `SCG_OTEL_ENDPOINT` nothing leaves the process: the run prints a one-line span summary and discards the spans. With it, spans are posted once, as OTLP/HTTP JSON, to `ENDPOINT/v1/traces` with a 5 s timeout.

## What a span may carry

Attribute keys are allowlisted; anything else is dropped and only counted:

| Key | Values |
| --- | --- |
| `scg.stage`, `scg.run_id`, `scg.outcome`, `scg.gate`, `scg.freshness` | fixed vocabularies |
| `scg.duration_ms`, `scg.count.*`, `scg.coverage.<osv|registry>.<state>` | non-negative integers |
| `scg.flag.*` | booleans |
| `scg.error.code` | a coarse code: an errno or `ERR_` code, `http_503`, `timeout`, `exit_1`, or `error`; never a message |

No attribute can hold a path, repository or project name, package name, version, advisory text, source text, token, packet body, or proposal body, because no allowlisted key accepts free text. The test in `tests/otel.test.mjs` feeds a synthetic secret, an absolute path, a package name, and a chatty error through the tracer and asserts none of them reaches the exported payload, then runs the whole pipeline against the fixture and checks the export again.

If you add a stage, add its name to `stages` and keep the same discipline: counts and vocabularies, never identifiers from the scan.
