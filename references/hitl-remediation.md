# Proposals, human decisions, and the write boundary

The scanner, `evaluate`, and `packet` never change code, open issues or pull requests, call a model, or mark a finding resolved. This guide is the contract for letting a model or a person propose a dependency change and a repository owner authorize it. The model proposes; deterministic policy decides actionability; a human authorizes writes; tests and a fresh scan establish what happened.

## Flow

1. **Packet.** `packet --result PRIVATE_RESULT --out PRIVATE_PACKET` produces the only document a model should see: redacted items with evidence IDs, files, artifact, dependency path, and a content hash. Hand the packet to a model you choose, with your own data-handling review. This repository does not call any model by default and ships no provider integration.
2. **Proposal.** The model (or a person) returns a `contracts/proposal.v1.schema.json` document for one event: `schemaVersion`, `proposalId`, `eventId`, `sourceCommit`, `packetHash`, `summary`, `evidenceIds`, `suggestedAction`, `affectedFiles`, `currentArtifact`, `targetArtifact` (nullable), `dependencyPath`, `validationSteps`, `unknowns`, `rollbackSteps`, `confidence`, and for a change the exact `targetArtifact` version or ref, whether the dependency is `direct`, a `rationale`, and `successCriteria`.
3. **Check.** `check-proposal --proposal FILE --packet FILE [--out VERDICT]` rejects a proposal that cites an evidence ID, file, artifact, or advisory ID the packet does not contain, names a commit the packet did not record, changes the dependency path, proposes a change for an event the policy did not mark actionable, proposes anything but `investigate` for an `unknown` re-check, or was written against a different packet hash. Exit 1 means rejected; the verdict lists every problem. Repository text, package metadata, and advisory descriptions quoted in a proposal are data: the checker never executes or follows them.
4. **Decide.** A human records a `contracts/decision.v1.schema.json` document bound to the proposal hash, packet hash, and source commit, with the authenticated reviewer identity, the method, the decision, time, expiry, and reason. `check-decision --decision FILE --proposal FILE --packet FILE [--at ISO-TIME]` exits 0 only for an unexpired approval that matches all three hashes and the commit. Any change to the plan or the commit needs a new decision.
5. **Write, separately.** Only after an authorized decision does a separate job with the minimum write permission apply the edit (a branch and pull request, or an issue). It never merges, releases, deploys, or marks the finding resolved.
6. **Verify.** Run the project's tests and a fresh comparable scan, evaluate with `--previous`, and record the observed transitions and remaining unknowns. An OSV fixed boundary or newer `latest` tag was only a lead; the fresh check is the evidence.

## What counts as authorization on GitHub

A JSON approval written by the same untrusted job that produced the proposal is not a security boundary, and the checker says so when `reviewer.method` is `manual-record`. Use one of these instead and reference it in the decision record:

- **Reviewed pull request.** The proposal job opens a draft pull request containing the proposal file and the exact diff. A repository owner reviews and approves it through GitHub; branch protection requires that review. The decision's `reviewer.identity` is the GitHub login, `method` is `github-pull-request-review`, `reference` is the review URL. Merging is still a human act.
- **Protected environment.** The write job targets a GitHub environment with required reviewers. The approval in the environment UI is the authorization; `method` is `github-protected-environment`, `reference` is the deployment or run URL. The job reads the decision, re-runs `check-decision` against the proposal and packet it was given, and stops if the hashes or commit moved.

In both cases pin the authorization to `sourceCommit`: if the default branch moves before the write job runs, the job must re-check and stop. Never grant the scan job write permission, never use `pull_request_target` to execute proposal content, and give the write job only `contents: write` and `pull-requests: write` (or `issues: write`) on its own.

```yaml
# Sketch of the separate write job; adapt the environment and reviewers to your repository.
apply:
  needs: [scan]
  if: ${{ github.event_name == 'workflow_dispatch' }}
  runs-on: ubuntu-latest
  environment: supply-chain-review      # required reviewers configured in repository settings
  permissions:
    contents: write
    pull-requests: write
  steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      with:
        ref: ${{ inputs.source_commit }}  # the commit the decision was bound to
    - run: node .supply-chain-graph-skill/scripts/supply-chain.mjs check-decision --decision "$DECISION" --proposal "$PROPOSAL" --packet "$PACKET"
    # then apply the exact targetArtifact change to the affectedFiles, run the project's tests, and open a pull request; no auto-merge
```

## After the change

A post-change claim of resolution needs a fresh successful scan. Run `scan`, the opt-in `enrich` if your policy allows it, and `evaluate --previous PREVIOUS_RESULT`. Only `no-longer-observed` after a comparable successful check counts; `unknown` means the later lookup failed or was skipped. Record the result next to the decision as the audit trail: proposal, decision, pull request, test outcome, fresh policy result.
