# Notification example

`webhook.mjs` posts items from an event packet to a webhook you configure. It is an example consumer, kept apart from the scan code, and it does nothing unless you run it with `SCG_WEBHOOK_URL` and `SCG_WEBHOOK_SECRET` set. Nothing in the scanner, `evaluate`, or `packet` ever sends anything.

```sh
node scripts/supply-chain.mjs packet --result PRIVATE_RESULT --out PRIVATE_PACKET
SCG_WEBHOOK_URL=https://hooks.example.invalid/scg SCG_WEBHOOK_SECRET=... node examples/notify/webhook.mjs --packet PRIVATE_PACKET --receipts PRIVATE_RECEIPTS --suppressions PRIVATE_STATE
```

What it guarantees:

- **Signed.** Each body carries `x-scg-signature: sha256=<HMAC-SHA256 of the exact body with your secret>`. Verify it before trusting a delivery.
- **Idempotent.** `x-scg-idempotency-key` is the event ID, which already encodes finding, transition, and observed version. Receipts record delivered keys, so a re-run after a crash or retry sends nothing twice; a later reappearance at a new version has a new key and alerts again.
- **Bounded.** 10 s timeout, three attempts with backoff on transport errors and 5xx responses, no retry on 4xx.
- **Private receipts.** `--receipts` is a JSON file you keep private: status, attempts, last status code, delivery time, packet hash. It contains event IDs and finding IDs, not paths.
- **Suppression is not resolution.** `--suppressions` points at a private file like `suppressions.example.json`: per finding ID, a `status` (`suppressed` or `acknowledged`), `owner`, `reason`, `createdAt`, `expiresAt`. An unexpired entry stops delivery of `observed` and `still-observed` events for that finding and writes a `suppressed` receipt with the owner and reason. It never changes the policy result, and only a later comparable successful scan can make a finding `no-longer-observed`.
- **No false resolutions.** Only `observed` is delivered by default. `--transitions observed,no-longer-observed` adds real resolutions. An `unknown` transition, where the later check failed or was skipped, is never delivered as an alert even if you ask for it.
- **No command execution.** The script posts JSON. It does not run shell commands from scan data, advisory text, package metadata, or a model's answer, and it reads no credentials other than the two environment variables.

Use `--dry-run` to see what would be sent without a destination. An issue-creating consumer follows the same pattern: a separate script with its own narrow token, run from a separate job, never from the scan job.
