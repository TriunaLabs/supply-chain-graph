# Running the scan in your own CI

`examples/ci/scan.yml` is a GitHub Actions workflow for a **caller's** repository. It scans that repository's own checkout, evaluates a policy, and writes an aggregate-only job summary. Nothing in it is specific to Triuna Labs; copy it, pin it, and own it.

## Install

1. Copy `examples/ci/scan.yml` to `.github/workflows/supply-chain-scan.yml` in your repository.
2. Replace `REPLACE_WITH_REVIEWED_COMMIT_SHA` in `SKILL_REF` with the full commit SHA of this skill repository that you have read and tested. Never point it at `main` or another branch: a branch can change after your review. Bump the SHA deliberately, the same way you bump a pinned action.
3. The two third-party actions are already pinned to full commit SHAs with their version in a comment. Keep them pinned; a tool such as Dependabot or Renovate can propose SHA updates.
4. Run it once from the Actions tab with **Run workflow**, leaving **enrich** unchecked. Read the job summary. Only then enable `pull_request` on busy repositories, and optionally `push` or `schedule`.

## What it does on each run

- Checks out your repository and the skill, both with `persist-credentials: false` and a `contents: read` token.
- Creates a private one-project config under `$RUNNER_TEMP` with `init` and `set-root` pointing at `$GITHUB_WORKSPACE`. It never discovers the runner's home directory, the whole disk, or unrelated workspaces. If you already keep a private config, check it in to a private location and replace the configure step with a copy.
- Runs `scan` locally: no package installation, no package scripts, no Git fetches, no network.
- Runs `evaluate` with `.github/supply-chain-policy.json` from your repository when present, otherwise the skill's reporting-only default. Exit 3 means a gate you configured failed; exit 1 means the tool or its input failed. The workflow prints which, without printing the result.
- Appends `summary` to the job summary: counts by actionability and rule, coverage state totals, freshness, and the gate verdict. No paths, project labels, package names, or advisory text appear there.

The config, snapshot, enriched snapshot, policy result, and any HTML stay in `$RUNNER_TEMP` and are discarded with the job. The workflow uploads no artifacts and publishes nothing to Pages. If you want to inspect the full result, upload it as a **private**, retention-limited artifact in your own copy, after deciding who can read your repository's artifacts.

## Enrichment is a disclosure decision

The default run makes no OSV or npm registry requests. Dispatching with **enrich** checked sends the resolved npm package names and exact versions in your lockfile to OSV, and package names to the public npm registry. Decide first whether your private package names may leave your network. Enrichment is only offered on `workflow_dispatch`, never on pull requests, so a contributor cannot trigger disclosure of a lockfile from a fork.

## Pull requests from forks

The workflow uses `pull_request`, which runs with a read-only token and no secrets for forked pull requests. Do not switch it to `pull_request_target`: that event runs with the base repository's permissions, and building or scanning pull request content under it hands those permissions to untrusted code. If you need secrets (for example to store a baseline), do that in a separate workflow that runs after merge, not on PR content. See GitHub's guidance on [secure use](https://docs.github.com/en/actions/reference/security/secure-use) and [`pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

## Baselines for `diff` and `--previous`

Cross-run comparison needs the last **accepted** snapshot and policy result, not the last attempted one. There is no implicit baseline: a public artifact would publish your dependency inventory. Choose private storage you control, such as a private repository, an encrypted bucket, or a private artifact with a short retention, restore the previous files into `$RUNNER_TEMP` before the evaluate step, and pass `--previous PREVIOUS_RESULT` to `evaluate` (and the previous snapshot to `diff`). A finding is reported as no longer observed only after a comparable successful check; a failed later lookup never produces a resolution.

## Coverage gaps are visible, not green

A missing lockfile, a failed lookup, an unsupported ecosystem, or a stale snapshot shows up as `needs-review` findings and non-zero `failed`, `unqueried`, `unsupported`, or `stale` counts in the summary. The job can still succeed when the gate is reporting-only; read the counts. A run with zero OSV checks is not a vulnerability check.

## Reusable workflow

Once the example interface has stabilised, a `workflow_call` wrapper with versioned inputs (project ID, policy path, enrich flag) and outputs (gate status, counts) can replace the copied file. Callers would still reference it by a reviewed commit SHA or a signed, immutable tag, and a called workflow cannot grant the caller's token more permission than the caller declared. Until then the copied file is the interface.

## Exit codes

| Code | Meaning | Where it comes from |
| --- | --- | --- |
| 0 | Scanned and evaluated; gate passed or not configured | `evaluate` |
| 1 | Invalid config, invalid snapshot or policy, or a tool failure | any command |
| 2 | Usage error | the CLI |
| 3 | A configured policy gate failed | `evaluate` |
