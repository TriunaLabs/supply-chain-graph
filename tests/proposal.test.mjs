import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate, loadSchema } from '../scripts/schema.mjs';
import { checkProposal, checkDecision, proposalHash } from '../scripts/proposal.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(base, 'scripts/supply-chain.mjs');
const readJson = async file => JSON.parse(await readFile(resolve(base, file), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'supply-chain-proposal-'));
const clone = value => JSON.parse(JSON.stringify(value));

test('a proposal may cite only what the packet contains', async () => {
  const packet = await readJson('contracts/examples/agent-packet.json');
  const proposal = await readJson('contracts/examples/proposal.json');
  const schema = await loadSchema('proposal');
  const validateSchema = document => validate(schema, document);
  assert.deepEqual(validateSchema(proposal).errors, []);
  const verdict = checkProposal(proposal, packet, { validateSchema });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.proposalHash, proposalHash(proposal));

  const cases = [
    ['unknown evidence ID', p => { p.evidenceIds = ['ev_0000000000000000']; }, /does not exist in the packet/],
    ['changed packet hash', p => { p.packetHash = 'a'.repeat(64); }, /does not match the packet/],
    ['invented file', p => { p.affectedFiles.push('src/secret-config.js'); }, /not among the files the packet associates/],
    ['absolute path', p => { p.affectedFiles.push('C:\\Users\\someone\\package.json'); }, /not a safe repository-relative path/],
    ['parent traversal', p => { p.affectedFiles.push('../other/package.json'); }, /not a safe repository-relative path/],
    ['invented advisory', p => { p.summary += ' Also fixes GHSA-9999-zzzz-yyyy and CVE-2026-99999.'; }, /GHSA-9999-ZZZZ-YYYY is mentioned but does not appear/],
    ['wrong artifact', p => { p.currentArtifact.version = '1.0.1'; }, /currentArtifact does not match/],
    ['changed path', p => { p.dependencyPath = ['web-app', 'other@1.0.0']; }, /dependencyPath must equal/],
    ['foreign commit', p => { p.sourceCommit = 'f'.repeat(40); }, /not a commit the packet recorded/],
    ['range instead of exact version', p => { p.targetArtifact.version = '^1.0.3'; }, /exact version, not a range/],
    ['missing rollback', p => { p.rollbackSteps = []; }, /needs rollback steps/],
    ['no direct flag', p => { p.direct = null; }, /direct or transitive/],
    ['unknown event', p => { p.eventId = 'e_0000000000000000'; }, /is not in the packet/]
  ];
  for (const [label, mutate, pattern] of cases) {
    const mutated = clone(proposal); mutate(mutated);
    const result = checkProposal(mutated, packet, { validateSchema });
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(result.problems.some(problem => pattern.test(problem)), `${label}: ${result.problems.join(' | ')}`);
  }
  const unsupported = clone(proposal); unsupported.schemaVersion = 2;
  assert.match(checkProposal(unsupported, packet, { validateSchema }).problems[0], /not supported/);
  const missingField = clone(proposal); delete missingField.unknowns;
  assert.match(checkProposal(missingField, packet, { validateSchema }).problems[0], /missing required property "unknowns"/);

  const reviewOnly = packet.items.find(item => item.actionability === 'needs-review' && item.artifact && item.files.length);
  const changeOnReview = { ...clone(proposal), eventId: reviewOnly.eventId, evidenceIds: [reviewOnly.evidence[0].id], affectedFiles: reviewOnly.files, currentArtifact: reviewOnly.artifact, dependencyPath: reviewOnly.dependencyPath.map(step => step.label), summary: 'Upgrade it.' };
  assert.ok(checkProposal(changeOnReview, packet, { validateSchema }).problems.some(problem => /policy marked this event needs-review/.test(problem)));
  const investigate = { ...changeOnReview, suggestedAction: 'investigate', targetArtifact: null, direct: null, affectedFiles: [] };
  assert.deepEqual(checkProposal(investigate, packet, { validateSchema }).problems, []);

  const tamperedPacket = clone(packet); tamperedPacket.items[0].files.push('src/anything.js');
  assert.ok(checkProposal(proposal, tamperedPacket, { validateSchema }).problems.some(problem => /tampered packet/.test(problem)));
});

test('a decision authorizes exactly one proposal hash at one commit until it expires', async () => {
  const packet = await readJson('contracts/examples/agent-packet.json');
  const proposal = await readJson('contracts/examples/proposal.json');
  const decision = await readJson('contracts/examples/decision.json');
  const schema = await loadSchema('decision');
  const validateSchema = document => validate(schema, document);
  assert.deepEqual(validateSchema(decision).errors, []);
  const now = new Date('2026-11-01T00:00:00Z');
  const ok = checkDecision(decision, proposal, packet, { now, validateSchema });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.authorized, true);
  assert.equal(ok.boundary, 'external');

  const changedPlan = clone(proposal); changedPlan.targetArtifact.version = '1.0.4';
  const stale = checkDecision(decision, changedPlan, packet, { now, validateSchema });
  assert.equal(stale.authorized, false);
  assert.ok(stale.problems.some(problem => /plan changed after review/.test(problem)));

  const movedCommit = clone(proposal); movedCommit.sourceCommit = 'f'.repeat(40);
  const d2 = { ...clone(decision), proposalHash: proposalHash(movedCommit) };
  const moved = checkDecision(d2, movedCommit, packet, { now, validateSchema });
  assert.ok(moved.problems.some(problem => /sourceCommit does not match the proposal/.test(problem)));

  assert.equal(checkDecision(decision, proposal, packet, { now: new Date('2028-01-01T00:00:00Z'), validateSchema }).authorized, false, 'expired approvals do not authorize');
  const rejected = { ...clone(decision), decision: 'reject' };
  assert.equal(checkDecision(rejected, proposal, packet, { now, validateSchema }).authorized, false);
  const weak = { ...clone(decision), reviewer: { identity: 'ci-bot', method: 'manual-record', reference: null } };
  const weakVerdict = checkDecision(weak, proposal, packet, { now, validateSchema });
  assert.equal(weakVerdict.boundary, 'weak');
  assert.match(weakVerdict.warnings[0], /not a security boundary/);
  const otherPacket = { ...clone(packet), packetHash: 'b'.repeat(64) };
  assert.ok(checkDecision(decision, proposal, otherPacket, { now, validateSchema }).problems.some(problem => /packetHash does not match/.test(problem)));
});

test('the CLI exits 1 for a rejected proposal or an unauthorized decision and 0 otherwise', async () => {
  const packet = resolve(base, 'contracts/examples/agent-packet.json'), proposal = resolve(base, 'contracts/examples/proposal.json'), decision = resolve(base, 'contracts/examples/decision.json');
  const good = spawnSync(process.execPath, [cli, 'check-proposal', '--proposal', proposal, '--packet', packet, '--out', join(scratch, 'verdict.json')], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stderr, /still needs a human decision/);
  assert.equal(JSON.parse(await readFile(join(scratch, 'verdict.json'), 'utf8')).ok, true);
  const badFile = join(scratch, 'bad-proposal.json');
  const bad = JSON.parse(await readFile(proposal, 'utf8')); bad.affectedFiles.push('deploy/prod.yml'); bad.summary += ' see CVE-2026-12345';
  await writeFile(badFile, JSON.stringify(bad));
  const rejected = spawnSync(process.execPath, [cli, 'check-proposal', '--proposal', badFile, '--packet', packet], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /deploy\/prod\.yml/);
  assert.match(rejected.stderr, /CVE-2026-12345/);
  const authorized = spawnSync(process.execPath, [cli, 'check-decision', '--decision', decision, '--proposal', proposal, '--packet', packet, '--at', '2026-11-01T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(authorized.status, 0, authorized.stderr);
  assert.match(authorized.stderr, /Authorized: approve/);
  const expired = spawnSync(process.execPath, [cli, 'check-decision', '--decision', decision, '--proposal', proposal, '--packet', packet, '--at', '2030-01-01T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /expired/);
  const unbound = spawnSync(process.execPath, [cli, 'check-decision', '--decision', decision, '--proposal', badFile, '--packet', packet, '--at', '2026-11-01T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(unbound.status, 1);
  assert.match(unbound.stderr, /plan changed after review/);
});
