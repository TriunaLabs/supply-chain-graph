// Builds a small, redacted event packet from an accepted policy result.
// The packet is data for a reviewer, a webhook, or a model. It carries stable event and finding IDs, the transition,
// a project alias, the artifact or commit, one typed dependency path, evidence sources with IDs a proposal can cite,
// the coverage state and policy rule, and a content hash. It never carries absolute roots, source text, credentials,
// unrelated nodes, or private remote labels. Project IDs can be replaced by opaque aliases from the policy.
import { createHash } from 'node:crypto';
import { assertSupportedVersion } from './schema.mjs';
import { canonical, eventIdentity } from './policy.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
export const evidenceIdentity = (findingId, kind, value) => 'ev_' + sha([findingId, kind, value].join('\u001f')).slice(0, 16);
const manifestFiles = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'requirements.txt']);
const relativeFile = value => typeof value === 'string' && !/^(?:[a-zA-Z]:[\\/]|[\\/]|https?:)/.test(value) && /^[\w.@/-]+\.[\w-]+$/.test(value) && !value.includes('..');

// Titles may quote the project's display label; the packet replaces it with the alias so a sensitive label never leaves.
function aliasedTitle(finding, alias) {
  const label = finding.dependencyPath.find(step => step.kind === 'project')?.label;
  const replacement = alias(finding.projectId);
  return label && replacement && label !== replacement ? finding.title.split(label).join(replacement) : finding.title;
}

export function buildPacket(result, { aliases = {}, include = ['actionable', 'needs-review', 'informational'], transitions = null } = {}) {
  assertSupportedVersion(result, 1, 'policy result');
  const alias = id => id == null ? null : String(aliases[id] || id);
  const byFinding = new Map((result.transitions || []).map(item => [item.findingId, item]));
  const observedOf = finding => finding.artifact?.version ?? (finding.projectId ? result.scan.sourceCommits[finding.projectId] : null) ?? null;
  const items = [];
  for (const finding of result.findings) {
    if (!include.includes(finding.actionability)) continue;
    const transition = byFinding.get(finding.id) || { eventId: eventIdentity(finding.id, 'observed', observedOf(finding)), transition: 'observed', observed: observedOf(finding) };
    if (transitions && !transitions.includes(transition.transition)) continue;
    const evidence = finding.evidence.map(entry => ({ id: evidenceIdentity(finding.id, entry.kind, entry.value), kind: entry.kind, value: entry.value }));
    // Files a remediation may touch: evidence files plus, for an npm occurrence, the project's manifest and the lockfile its coverage record names.
    const coverage = result.coverage.find(record => record.projectId === finding.projectId);
    const lockfile = typeof coverage?.npm === 'string' && coverage.npm.startsWith('resolved-v') ? 'package-lock.json' : coverage?.npm === 'pnpm-v9' ? 'pnpm-lock.yaml' : null;
    const files = [...new Set([
      ...finding.evidence.map(entry => entry.value).filter(value => relativeFile(value) && (manifestFiles.has(value) || /\.ya?ml$/.test(value) || value.includes('/'))),
      ...(finding.artifact?.ecosystem === 'npm' && finding.occurrence ? ['package.json', ...(lockfile ? [lockfile] : [])] : [])
    ])].sort();
    items.push({
      eventId: transition.eventId,
      findingId: finding.id,
      transition: transition.transition,
      baselineKnown: byFinding.has(finding.id),
      ruleId: finding.ruleId,
      actionability: finding.actionability,
      coverageState: finding.coverageState,
      severity: finding.severity,
      severitySource: finding.severitySource,
      project: alias(finding.projectId),
      artifact: finding.artifact,
      occurrence: finding.occurrence,
      advisoryId: finding.advisoryId,
      checkedAt: finding.checkedAt,
      observed: transition.observed ?? observedOf(finding),
      title: aliasedTitle(finding, alias),
      evidence,
      files,
      dependencyPath: finding.dependencyPath.map(step => step.kind === 'project' ? { ...step, label: alias(finding.projectId) ?? step.label } : step),
      reasons: finding.reasons,
      ...(finding.fixedBoundaries?.length ? { fixedBoundaries: finding.fixedBoundaries } : {}),
      ...(finding.latestTag ? { latestTag: finding.latestTag } : {})
    });
  }
  // Transitions for findings that are no longer in the current result (gone, or unknown because the later check failed).
  const current = new Set(result.findings.map(finding => finding.id));
  for (const item of result.transitions || []) {
    if (current.has(item.findingId)) continue;
    if (transitions && !transitions.includes(item.transition)) continue;
    items.push({ eventId: item.eventId, findingId: item.findingId, transition: item.transition, baselineKnown: true, ruleId: item.ruleId, actionability: null, coverageState: null, severity: null, severitySource: null, project: null, artifact: null, occurrence: null, advisoryId: null, checkedAt: null, observed: item.observed ?? null, title: item.transition === 'unknown' ? 'Previous finding could not be re-checked' : 'Previous finding no longer observed', evidence: [], files: [], dependencyPath: [], reasons: [item.reason] });
  }
  items.sort((a, b) => a.eventId.localeCompare(b.eventId));
  const body = {
    schemaVersion: 1,
    generatedAt: result.evaluatedAt,
    policy: result.policy,
    scan: { generatedAt: result.scan.generatedAt, sourceCommits: Object.fromEntries(Object.entries(result.scan.sourceCommits).map(([id, commit]) => [alias(id), commit])), freshness: result.freshness.state },
    gate: result.gate.status,
    items,
    evidenceIds: [...new Set(items.flatMap(item => item.evidence.map(entry => entry.id)))].sort()
  };
  const packetHash = sha(canonical(body));
  return { ...body, packetId: 'pk_' + packetHash.slice(0, 16), packetHash };
}

export function packetHashOf(packet) {
  const { packetId, packetHash, ...body } = packet;
  return sha(canonical(body));
}
