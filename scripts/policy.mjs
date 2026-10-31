// Deterministic policy evaluation over an accepted snapshot.
// Same snapshot + same policy + same evaluation time => same result, byte for byte. Evaluation time is an input so
// freshness is testable. Coverage gaps can be routed to review; nothing here can turn them into "safe" or "resolved".
import { createHash } from 'node:crypto';
import { assertSupportedVersion } from './schema.mjs';

export const ruleIds = ['osv-advisory', 'osv-lookup-failed', 'osv-unqueried', 'unsupported-ecosystem', 'coverage-gap', 'stale-scan', 'npm-deprecation', 'npm-deprecation-cached', 'newer-latest', 'unpinned-action'];
const defaultRules = {
  'osv-advisory': { enabled: true, actionability: 'actionable', severity: null },
  'osv-lookup-failed': { enabled: true, actionability: 'needs-review', severity: null },
  'osv-unqueried': { enabled: true, actionability: 'needs-review', severity: null },
  'unsupported-ecosystem': { enabled: true, actionability: 'needs-review', severity: null },
  'coverage-gap': { enabled: true, actionability: 'needs-review', severity: null },
  'stale-scan': { enabled: true, actionability: 'needs-review', severity: null },
  'npm-deprecation': { enabled: true, actionability: 'actionable', severity: null },
  'npm-deprecation-cached': { enabled: true, actionability: 'needs-review', severity: null },
  'newer-latest': { enabled: true, actionability: 'informational', severity: null },
  'unpinned-action': { enabled: true, actionability: 'actionable', severity: 'medium' }
};
const coverageStates = ['checked-and-none', 'checked-with-results', 'failed', 'unqueried', 'unsupported', 'stale'];

const sha = text => createHash('sha256').update(text).digest('hex');
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
export const canonical = value => JSON.stringify(sortKeys(value));
export const policyHash = policy => sha(canonical(policy));
// Identity never includes absolute paths or timestamps: rule, advisory, ecosystem, exact artifact or commit, project, occurrence.
export const findingIdentity = parts => 'f_' + sha(parts.map(part => part == null ? '' : String(part)).join('\u001f')).slice(0, 16);
// Event identity adds the transition and the observed version or commit, so retries deduplicate while a later reappearance alerts again.
export const eventIdentity = (findingId, transition, observed) => 'e_' + sha([findingId, transition, observed ?? ''].join('\u001f')).slice(0, 16);

const hours = (later, earlier) => (later - earlier) / 3600000;
const parseTime = value => { const time = value ? new Date(value) : null; return time && !Number.isNaN(time.getTime()) ? time : null; };

function ruleConfig(policy) {
  const rules = {};
  for (const id of ruleIds) rules[id] = { ...defaultRules[id], ...(policy.rules?.[id] || {}) };
  for (const id of Object.keys(policy.rules || {})) if (!ruleIds.includes(id)) throw new Error(`Unknown policy rule: ${id}`);
  return rules;
}

function lookupState(lookup, evaluatedAt, maxAgeHours) {
  if (!lookup) return 'unqueried';
  if (lookup.status === 'unavailable') return 'unsupported';
  if (lookup.status === 'error') return 'failed';
  if (lookup.status !== 'checked') return 'unqueried';
  const checked = parseTime(lookup.checkedAt);
  if (maxAgeHours != null && checked && hours(evaluatedAt, checked) > maxAgeHours) return 'stale';
  return (lookup.advisories?.length || 0) > 0 || lookup.deprecated ? 'checked-with-results' : 'checked-and-none';
}

export function evaluate(snapshot, policy, { now = null, previous = null } = {}) {
  assertSupportedVersion(snapshot, 1, 'snapshot');
  assertSupportedVersion(policy, 1, 'policy');
  if (previous) assertSupportedVersion(previous, 1, 'previous policy result');
  const evaluatedAt = parseTime(now) || (now ? null : new Date());
  if (!evaluatedAt) throw new Error(`Evaluation time is not a valid date-time: ${now}`);
  const rules = ruleConfig(policy);
  const maxAgeHours = policy.freshness?.maxAgeHours ?? null;
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const projects = snapshot.nodes.filter(node => node.kind === 'project').map(node => node.projectId).sort();
  const checkouts = new Map(snapshot.nodes.filter(node => node.kind === 'checkout').map(node => [node.projectId, node]));
  const packages = snapshot.enrichment?.packages || {};
  const advisoryDetails = snapshot.enrichment?.advisories || {};

  // Freshness of the scan itself.
  const generated = parseTime(snapshot.generatedAt);
  const ageHours = generated ? Math.round(hours(evaluatedAt, generated) * 100) / 100 : null;
  const freshness = { state: ageHours == null ? 'unknown' : maxAgeHours != null && ageHours > maxAgeHours ? 'stale' : 'fresh', maxAgeHours, ageHours };

  // Occurrence -> artifact, artifact -> occurrences, and one dependency path per occurrence (labels only, never paths on disk).
  const artifactOf = new Map(snapshot.edges.filter(edge => edge.kind === 'resolves-to').map(edge => [edge.from, edge.to]));
  const occurrencesOf = new Map();
  for (const [occurrenceId, artifactId] of artifactOf) { if (!occurrencesOf.has(artifactId)) occurrencesOf.set(artifactId, []); occurrencesOf.get(artifactId).push(occurrenceId); }
  for (const list of occurrencesOf.values()) list.sort();
  const dependsOn = new Map();
  for (const edge of snapshot.edges) if (edge.kind === 'depends-on' || edge.kind === 'uses-action') { if (!dependsOn.has(edge.from)) dependsOn.set(edge.from, []); dependsOn.get(edge.from).push(edge); }
  const pathTo = (projectId, targetId) => {
    const start = `project:${projectId}`;
    const parent = new Map([[start, null]]);
    const queue = [start];
    for (let i = 0; i < queue.length && !parent.has(targetId); i++) for (const edge of dependsOn.get(queue[i]) || []) if (!parent.has(edge.to)) { parent.set(edge.to, { from: queue[i], edge }); queue.push(edge.to); }
    if (!parent.has(targetId)) { const target = byId.get(targetId); return [{ kind: 'project', label: byId.get(start)?.label || projectId, via: null }, ...(target ? [{ kind: target.kind, label: target.label, via: 'recorded' }] : [])]; }
    const steps = [];
    for (let current = targetId; current; current = parent.get(current)?.from) { const node = byId.get(current); const link = parent.get(current); steps.unshift({ kind: node?.kind || 'node', label: node?.label || current, via: link ? link.edge.scope || link.edge.kind : null }); }
    return steps;
  };

  // Per-artifact check states.
  const artifacts = snapshot.nodes.filter(node => node.kind === 'artifact').sort((a, b) => a.id.localeCompare(b.id));
  const projectsOfArtifact = artifactId => [...new Set((occurrencesOf.get(artifactId) || []).map(id => byId.get(id)?.projectId).concat(byId.get(artifactId)?.projectId ? [byId.get(artifactId).projectId] : []).filter(Boolean))].sort();
  const checks = { artifacts: [], totals: { osv: Object.fromEntries(coverageStates.map(state => [state, 0])), registry: Object.fromEntries(coverageStates.map(state => [state, 0])) } };
  const stateOf = new Map();
  for (const artifact of artifacts) {
    const entry = packages[artifact.id] || {};
    const npm = artifact.ecosystem === 'npm';
    const osv = npm ? lookupState(entry.osv, evaluatedAt, maxAgeHours) : 'unsupported';
    const registry = npm ? lookupState(entry.registry, evaluatedAt, maxAgeHours) : 'unsupported';
    const record = { artifactId: artifact.id, ecosystem: artifact.ecosystem || 'unknown', name: artifact.name || artifact.label, version: artifact.version ?? null, osv, registry, advisoryCount: entry.osv?.status === 'checked' ? (entry.osv.advisories || []).length : null, checkedAt: entry.osv?.checkedAt || entry.registry?.checkedAt || null, projects: projectsOfArtifact(artifact.id) };
    checks.artifacts.push(record); stateOf.set(artifact.id, record);
    checks.totals.osv[osv]++; checks.totals.registry[registry]++;
  }

  const findings = [];
  const emit = (ruleId, identityParts, fields) => {
    const rule = rules[ruleId];
    if (!rule.enabled) return;
    findings.push({ id: findingIdentity([ruleId, ...identityParts]), ruleId, title: '', actionability: rule.actionability, coverageState: 'unqueried', projectId: null, artifact: null, occurrence: null, advisoryId: null, severity: rule.severity ?? null, severitySource: rule.severity != null ? 'policy' : null, checkedAt: null, evidence: [], dependencyPath: [], reasons: [], v1Ids: [], ...fields });
  };
  const artifactRef = artifact => ({ ecosystem: artifact.ecosystem || 'unknown', name: artifact.name || artifact.label, version: artifact.version ?? null });
  const artifactKey = artifact => `${artifact.ecosystem || 'unknown'}:${artifact.name || artifact.label}@${artifact.version ?? ''}`;

  for (const artifact of artifacts) {
    const entry = packages[artifact.id] || {}, record = stateOf.get(artifact.id);
    const occurrences = occurrencesOf.get(artifact.id) || [];
    const placements = occurrences.length ? occurrences.map(id => ({ projectId: byId.get(id)?.projectId, occurrence: byId.get(id)?.location ?? null, targetId: id })) : artifact.projectId ? [{ projectId: artifact.projectId, occurrence: null, targetId: artifact.id }] : [];
    for (const placement of placements) {
      if (!placement.projectId) continue;
      const base = { projectId: placement.projectId, artifact: artifactRef(artifact), occurrence: placement.occurrence, dependencyPath: pathTo(placement.projectId, placement.targetId) };
      const identity = [artifact.ecosystem || 'unknown', artifactKey(artifact), placement.projectId, placement.occurrence ?? ''];
      if (artifact.ecosystem !== 'npm') {
        emit('unsupported-ecosystem', identity, { ...base, title: `${artifact.label} (${artifact.ecosystem}) has no advisory lookup in this tool`, coverageState: 'unsupported', evidence: [{ kind: 'source', value: 'requirements.txt' }], reasons: [`This tool queries npm names and versions only; ${artifact.ecosystem} packages are recorded but never checked.`] });
        continue;
      }
      if (record.osv === 'unsupported') emit('unsupported-ecosystem', identity, { ...base, title: `${artifact.label} comes from a Git or local source and cannot be checked by name and version`, coverageState: 'unsupported', checkedAt: entry.osv?.checkedAt || null, evidence: [{ kind: 'lookup', value: 'OSV' }], reasons: [entry.osv?.reason || 'Public name/version lookup would not verify the installed code.'] });
      if (record.osv === 'failed') emit('osv-lookup-failed', identity, { ...base, title: `OSV lookup failed for ${artifact.label}`, coverageState: 'failed', checkedAt: entry.osv?.checkedAt || null, evidence: [{ kind: 'lookup', value: 'OSV' }], reasons: [`The advisory lookup did not complete (${entry.osv?.reason || 'unknown reason'}); advisory status is unknown, not clean.`] });
      if (record.osv === 'checked-with-results' || record.osv === 'stale') {
        for (const item of (entry.osv?.advisories || []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
          const detail = advisoryDetails[item.id];
          const matching = detail?.status === 'checked' ? (detail.affected || []).filter(affected => affected.ecosystem === 'npm' && affected.name?.toLowerCase() === artifact.name?.toLowerCase()) : [];
          const severity = detail?.status === 'checked' ? detail.severity || matching.find(affected => affected.severity)?.severity || null : null;
          const fixed = [...new Set(matching.flatMap(affected => affected.fixedBoundaries || []))].sort();
          emit('osv-advisory', [item.id, ...identity], { ...base, title: `${item.id} affects ${artifact.label}`, coverageState: record.osv, advisoryId: item.id, severity: severity ?? rules['osv-advisory'].severity ?? null, severitySource: severity ? 'osv' : rules['osv-advisory'].severity != null ? 'policy' : null, checkedAt: entry.osv.checkedAt || null, evidence: [{ kind: 'lookup', value: 'OSV' }, { kind: 'reference', value: `https://osv.dev/vulnerability/${item.id}` }], reasons: [record.osv === 'stale' ? `OSV returned this advisory, but the check is older than ${maxAgeHours} hours; re-run enrich before acting.` : 'OSV returned this advisory for the exact installed version.', ...(detail?.status === 'checked' && detail.summary ? [detail.summary] : []), ...(fixed.length ? [`OSV lists fixed boundaries ${fixed.join(', ')}; a lead, not proof that an update fixes every issue.`] : ['OSV lists no fixed boundary for this package.'])], detail: detail?.status === 'checked' ? detail.summary || null : detail?.status === 'error' ? 'Advisory detail lookup failed' : null, fixedBoundaries: fixed });
        }
      }
      // A stale registry check keeps the same finding identity with coverageState "stale" rather than silently changing rule.
      const registryChecked = entry.registry?.status === 'checked';
      if (registryChecked && entry.registry.deprecated) emit('npm-deprecation', identity, { ...base, title: `${artifact.label} is deprecated on npm`, coverageState: record.registry, checkedAt: entry.registry.checkedAt || null, evidence: [{ kind: 'lookup', value: 'npm registry' }], reasons: [record.registry === 'stale' ? `The registry check is older than ${maxAgeHours} hours; re-run enrich before acting.` : 'The public npm registry marks this version deprecated.', entry.registry.deprecated], detail: entry.registry.deprecated });
      else if (artifact.localDeprecation && !registryChecked) emit('npm-deprecation-cached', identity, { ...base, title: `${artifact.label} carries a deprecation message in the lockfile`, coverageState: record.registry, evidence: [{ kind: 'source', value: 'package-lock.json' }], reasons: ['The message comes from the lockfile and is cached until a registry check confirms it.', artifact.localDeprecation], detail: artifact.localDeprecation });
      if (registryChecked && entry.registry.newerLatestTag === true) emit('newer-latest', identity, { ...base, title: `npm latest for ${artifact.name} is ${entry.registry.latestTag}`, coverageState: record.registry, checkedAt: entry.registry.checkedAt || null, evidence: [{ kind: 'lookup', value: 'npm registry' }], reasons: ['A newer latest tag is informational; it does not establish that any advisory is fixed.'], latestTag: entry.registry.latestTag || null });
    }
  }

  // Unqueried npm artifacts are aggregated per project so a fresh local snapshot reads as one review item per project, not one per package.
  for (const projectId of projects) {
    const unqueried = checks.artifacts.filter(record => record.ecosystem === 'npm' && record.osv === 'unqueried' && record.projects.includes(projectId));
    if (unqueried.length) emit('osv-unqueried', [projectId], { projectId, title: `${unqueried.length} npm package version${unqueried.length === 1 ? '' : 's'} in ${byId.get(`project:${projectId}`)?.label || projectId} have no advisory lookup`, coverageState: 'unqueried', dependencyPath: [{ kind: 'project', label: byId.get(`project:${projectId}`)?.label || projectId, via: null }], evidence: [{ kind: 'lookup', value: 'OSV' }], reasons: ['No OSV query has been recorded for these versions. Unknown is not clean; run enrich from a machine allowed to share package names.'] });
  }

  // Scan-level coverage findings map one to one onto the v1 finding IDs so existing diff consumers keep working.
  for (const finding of [...snapshot.findings].sort((a, b) => a.id.localeCompare(b.id))) {
    emit('coverage-gap', [finding.type, finding.projectId, finding.id], { projectId: finding.projectId, title: finding.title, coverageState: 'unqueried', dependencyPath: [{ kind: 'project', label: byId.get(`project:${finding.projectId}`)?.label || finding.projectId, via: null }], evidence: [{ kind: 'snapshot-finding', value: finding.evidence }], reasons: [`Coverage gap of type ${finding.type}.`, ...(finding.detail ? [finding.detail] : [])], v1Ids: [finding.id], detail: finding.detail ?? null });
  }
  if (freshness.state === 'stale') emit('stale-scan', ['portfolio'], { title: `Snapshot is ${Math.round(ageHours)} hours old, older than the ${maxAgeHours} hour freshness target`, coverageState: 'stale', evidence: [{ kind: 'snapshot-finding', value: 'generatedAt' }], reasons: ['Evidence older than the freshness target cannot support a current claim; rescan.'] });

  // Mutable workflow references.
  for (const edge of snapshot.edges.filter(edge => edge.kind === 'uses-action').sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))) {
    const action = byId.get(edge.to), project = byId.get(edge.from);
    if (!action || action.pinned !== false || !project?.projectId) continue;
    const repository = snapshot.edges.find(item => item.from === action.id && item.kind === 'sourced-from');
    emit('unpinned-action', [action.label, project.projectId, edge.source || ''], { projectId: project.projectId, artifact: { ecosystem: 'github-actions', name: action.label.split('@')[0], version: action.reference ?? null }, occurrence: edge.source || null, title: `${action.label} is referenced by a mutable tag or branch`, coverageState: 'checked-with-results', evidence: [{ kind: 'source', value: edge.source || 'workflow' }], dependencyPath: [{ kind: 'project', label: project.label, via: null }, { kind: 'action', label: action.label, via: 'uses-action' }, ...(repository ? [{ kind: 'repository', label: byId.get(repository.to)?.label || repository.to, via: 'sourced-from' }] : [])], reasons: ['A tag or branch can move after review; pin third-party actions to a reviewed full commit SHA.'] });
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));
  const duplicate = findings.find((finding, index) => index && findings[index - 1].id === finding.id);
  if (duplicate) throw new Error(`Duplicate finding identity ${duplicate.id} (${duplicate.ruleId})`);

  // Gate: configured values match actionability or severity labels, case-insensitively.
  const failOn = (policy.gate?.failOn || []).map(String);
  const matchesGate = finding => failOn.some(value => value.toLowerCase() === finding.actionability || (finding.severity && value.toLowerCase() === String(finding.severity).toLowerCase()));
  const failing = failOn.length ? findings.filter(matchesGate).map(finding => finding.id) : [];
  const gate = { status: failOn.length ? (failing.length ? 'fail' : 'pass') : 'not-configured', failOn, failing };

  const summary = { findings: findings.length, actionable: findings.filter(f => f.actionability === 'actionable').length, needsReview: findings.filter(f => f.actionability === 'needs-review').length, informational: findings.filter(f => f.actionability === 'informational').length, byRule: Object.fromEntries(ruleIds.map(id => [id, findings.filter(f => f.ruleId === id).length]).filter(([, count]) => count)) };
  const result = {
    schemaVersion: 1,
    evaluatedAt: evaluatedAt.toISOString(),
    policy: { id: policy.id, version: policy.version, hash: policyHash(policy) },
    scan: { schemaVersion: 1, generatedAt: snapshot.generatedAt, projects, sourceCommits: Object.fromEntries(projects.map(id => [id, checkouts.get(id)?.commit || null])), enrichmentAttemptedAt: snapshot.enrichment?.attemptedAt || null },
    freshness,
    coverage: snapshot.coverage.map(record => Object.fromEntries(Object.entries(record).filter(([, value]) => value == null || typeof value === 'string' || Number.isInteger(value)))),
    checks,
    findings,
    gate,
    summary
  };
  if (previous) result.transitions = transitions(previous, result, snapshot, stateOf, byId);
  return result;
}

// A finding may be reported as no longer observed only after a comparable successful check. If the check that produced it
// failed, was skipped, or is stale this time, its status is unknown, never resolved.
function transitions(previous, current, snapshot, stateOf, byId) {
  const before = new Map((previous.findings || []).map(finding => [finding.id, finding]));
  const now = new Map(current.findings.map(finding => [finding.id, finding]));
  const observedValue = finding => finding.artifact?.version ?? (finding.projectId ? current.scan.sourceCommits[finding.projectId] : null) ?? null;
  const list = [];
  for (const finding of current.findings) {
    const transition = before.has(finding.id) ? 'still-observed' : 'observed';
    list.push({ eventId: eventIdentity(finding.id, transition, observedValue(finding)), findingId: finding.id, transition, ruleId: finding.ruleId, observed: observedValue(finding), reason: transition === 'observed' ? 'Not present in the previous policy result.' : 'Present in the previous policy result.' });
  }
  const presentArtifact = finding => stateOf.get(`${finding.artifact.ecosystem}:${finding.artifact.name}@${finding.artifact.version}`) || [...stateOf.values()].find(record => record.ecosystem === finding.artifact.ecosystem && record.name === finding.artifact.name && record.version === finding.artifact.version && (!finding.projectId || record.projects.includes(finding.projectId)));
  for (const finding of before.values()) {
    if (now.has(finding.id)) continue;
    let transition = 'no-longer-observed', reason = 'The current scan no longer produces this finding.';
    if (['osv-advisory', 'osv-lookup-failed', 'npm-deprecation', 'newer-latest'].includes(finding.ruleId) && finding.artifact) {
      const record = presentArtifact(finding);
      const check = record ? (finding.ruleId.startsWith('osv') ? record.osv : record.registry) : null;
      if (!record) reason = 'The artifact is no longer present in that project in the current snapshot.';
      else if (check === 'checked-and-none' || check === 'checked-with-results') reason = `A successful ${finding.ruleId.startsWith('osv') ? 'OSV' : 'npm registry'} check no longer reports it.`;
      else { transition = 'unknown'; reason = `No comparable successful check this time (state: ${check}); the previous finding stays unresolved.`; }
    }
    list.push({ eventId: eventIdentity(finding.id, transition, observedValue(finding)), findingId: finding.id, transition, ruleId: finding.ruleId, observed: observedValue(finding), reason });
  }
  return list.sort((a, b) => a.eventId.localeCompare(b.eventId));
}
