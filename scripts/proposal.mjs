// Proposal and decision validation for the human-in-the-loop remediation contract.
// A proposal (from a model, a person, or a tool) may only cite what the packet contains: its evidence IDs, its files,
// its artifact, its advisory IDs, its dependency path, and a source commit the packet recorded. Repository text,
// package metadata, and advisory descriptions inside the proposal are data; nothing here executes or interprets them.
// A decision authorizes exactly one proposal hash at one source commit until it expires.
import { createHash } from 'node:crypto';
import { assertSupportedVersion } from './schema.mjs';
import { canonical } from './policy.mjs';
import { packetHashOf } from './packet.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
export const proposalHash = proposal => sha(canonical(proposal));
const advisoryPattern = /\b(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,}|PYSEC-\d{4}-\d+|OSV-\d{4}-\d+|RUSTSEC-\d{4}-\d+|GO-\d{4}-\d+|MAL-\d{4}-\d+)\b/gi;
const changeActions = new Set(['upgrade', 'replace', 'pin', 'remove']);
const safeRelativeFile = value => typeof value === 'string' && !/^(?:[a-zA-Z]:[\\/]|[\\/]|\\\\|[a-z]+:)/.test(value) && !value.split(/[\\/]/).includes('..') && !/[\u0000-\u001f]/.test(value);
const sameArtifact = (a, b) => !!a && !!b && a.ecosystem === b.ecosystem && a.name === b.name && (a.version ?? null) === (b.version ?? null);

export function checkProposal(proposal, packet, { validateSchema = null } = {}) {
  const problems = [];
  try { assertSupportedVersion(proposal, 1, 'proposal'); } catch (error) { return { ok: false, problems: [error.message] }; }
  try { assertSupportedVersion(packet, 1, 'packet'); } catch (error) { return { ok: false, problems: [error.message] }; }
  if (validateSchema) { const check = validateSchema(proposal); if (!check.valid) return { ok: false, problems: check.errors.map(problem => `schema ${problem.path}: ${problem.message}`) }; }
  if (packetHashOf(packet) !== packet.packetHash) problems.push('The packet\'s own content hash does not match its body; refuse to evaluate proposals against a tampered packet');
  if (proposal.packetHash !== packet.packetHash) problems.push(`packetHash ${proposal.packetHash} does not match the packet (${packet.packetHash}); the proposal was made against different evidence`);
  const item = packet.items.find(candidate => candidate.eventId === proposal.eventId);
  if (!item) problems.push(`eventId ${proposal.eventId} is not in the packet`);
  const packetEvidence = new Set(packet.evidenceIds || []);
  for (const id of proposal.evidenceIds || []) if (!packetEvidence.has(id)) problems.push(`evidence ${id} does not exist in the packet`);
  if (item && !(proposal.evidenceIds || []).some(id => item.evidence.some(entry => entry.id === id))) problems.push('at least one cited evidence ID must belong to the proposal\'s own event');
  const commits = new Set(Object.values(packet.scan?.sourceCommits || {}).filter(Boolean));
  if (commits.size && !commits.has(proposal.sourceCommit)) problems.push(`sourceCommit ${proposal.sourceCommit} is not a commit the packet recorded for any project`);
  if (item?.project && packet.scan?.sourceCommits?.[item.project] && packet.scan.sourceCommits[item.project] !== proposal.sourceCommit) problems.push(`sourceCommit does not match the commit recorded for project ${item.project}`);
  const allowedFiles = new Set(item?.files || []);
  for (const file of proposal.affectedFiles || []) {
    if (!safeRelativeFile(file)) problems.push(`affected file "${file}" is not a safe repository-relative path`);
    else if (!allowedFiles.has(file)) problems.push(`affected file "${file}" is not among the files the packet associates with this event (${[...allowedFiles].join(', ') || 'none'})`);
  }
  if (item && item.artifact && !sameArtifact(proposal.currentArtifact, item.artifact)) problems.push('currentArtifact does not match the packet item\'s artifact exactly');
  if (item && !item.artifact && proposal.currentArtifact) problems.push('the packet item has no artifact, so the proposal cannot name a currentArtifact');
  if (item) {
    const labels = item.dependencyPath.map(step => step.label);
    if (JSON.stringify(proposal.dependencyPath) !== JSON.stringify(labels)) problems.push(`dependencyPath must equal the packet item's path: ${labels.join(' -> ')}`);
  }
  const text = [proposal.summary, proposal.rationale, ...(proposal.validationSteps || []), ...(proposal.unknowns || []), ...(proposal.rollbackSteps || []), ...(proposal.successCriteria || [])].filter(Boolean).join('\n');
  const knownAdvisories = new Set(packet.items.flatMap(candidate => [candidate.advisoryId, ...candidate.evidence.map(entry => entry.value)]).filter(Boolean).flatMap(value => [...String(value).matchAll(advisoryPattern)].map(match => match[0].toUpperCase())));
  for (const match of new Set([...text.matchAll(advisoryPattern)].map(match => match[0].toUpperCase()))) if (!knownAdvisories.has(match)) problems.push(`advisory ${match} is mentioned but does not appear in the packet`);
  if (changeActions.has(proposal.suggestedAction)) {
    if (proposal.suggestedAction !== 'remove') {
      if (!proposal.targetArtifact) problems.push(`${proposal.suggestedAction} requires a targetArtifact with an exact version or ref`);
      else if (!proposal.targetArtifact.version && !proposal.targetArtifact.ref) problems.push('targetArtifact needs an exact version or ref');
      else if (proposal.targetArtifact.version && !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(proposal.targetArtifact.version)) problems.push('targetArtifact.version must be an exact version, not a range');
    }
    if (typeof proposal.direct !== 'boolean') problems.push('a change proposal must state whether the dependency is direct or transitive');
    if (!proposal.rationale) problems.push('a change proposal must say why it is expected to help');
    if (!(proposal.successCriteria || []).length) problems.push('a change proposal must say what would demonstrate success');
    if (!(proposal.validationSteps || []).length) problems.push('a change proposal needs validation steps');
    if (!(proposal.rollbackSteps || []).length) problems.push('a change proposal needs rollback steps');
    if (!(proposal.affectedFiles || []).length) problems.push('a change proposal must name the files it would touch');
  }
  if (item && item.actionability !== 'actionable' && changeActions.has(proposal.suggestedAction)) problems.push(`the policy marked this event ${item.actionability}; a change may be proposed only for an actionable event, propose investigate instead`);
  if (item && item.transition === 'unknown' && proposal.suggestedAction !== 'investigate') problems.push('the event is an unknown re-check; only investigate is acceptable');
  return { ok: problems.length === 0, problems, eventId: proposal.eventId, proposalHash: proposalHash(proposal) };
}

export function checkDecision(decision, proposal, packet, { now = new Date(), validateSchema = null } = {}) {
  const problems = [];
  try { assertSupportedVersion(decision, 1, 'decision'); } catch (error) { return { ok: false, authorized: false, problems: [error.message] }; }
  if (validateSchema) { const check = validateSchema(decision); if (!check.valid) return { ok: false, authorized: false, problems: check.errors.map(problem => `schema ${problem.path}: ${problem.message}`) }; }
  const hash = proposalHash(proposal);
  if (decision.proposalId !== proposal.proposalId) problems.push(`decision is for proposal ${decision.proposalId}, not ${proposal.proposalId}`);
  if (decision.proposalHash !== hash) problems.push('proposalHash does not match this proposal; the plan changed after review and needs a new decision');
  if (decision.packetHash !== packet.packetHash) problems.push('packetHash does not match the packet the proposal was made against');
  if (decision.sourceCommit !== proposal.sourceCommit) problems.push('sourceCommit does not match the proposal; a new commit needs a new review');
  const time = value => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; };
  const decided = time(decision.decidedAt), expires = time(decision.expiresAt);
  if (!decided || !expires) problems.push('decidedAt and expiresAt must be valid date-times');
  else if (expires <= decided) problems.push('expiresAt must be after decidedAt');
  const expired = expires ? expires.getTime() <= now.getTime() : true;
  const boundary = decision.reviewer?.method === 'manual-record' ? 'weak' : 'external';
  const warnings = boundary === 'weak' ? ['reviewer.method is manual-record: a JSON approval written by the same job is a note, not a security boundary; use a pull request review or protected environment for real authorization'] : [];
  const ok = problems.length === 0;
  const authorized = ok && decision.decision === 'approve' && !expired;
  if (ok && decision.decision === 'approve' && expired) problems.push(`the approval expired at ${decision.expiresAt}`);
  return { ok, authorized, expired, boundary, warnings, problems, proposalHash: hash, decision: decision.decision };
}
