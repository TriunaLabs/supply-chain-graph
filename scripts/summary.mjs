// Aggregate-only summary of a policy result for CI job summaries and logs.
// It prints counts and coverage states and nothing else: no project IDs or labels, no local paths, no package names,
// no advisory text. Anything a reader needs beyond counts lives in the private policy result.
import { assertSupportedVersion } from './schema.mjs';

const states = ['checked-and-none', 'checked-with-results', 'failed', 'unqueried', 'unsupported', 'stale'];

export function summarize(result) {
  assertSupportedVersion(result, 1, 'policy result');
  const lines = [];
  lines.push('## Supply chain scan summary');
  lines.push('');
  lines.push(`Policy \`${result.policy.id}@${result.policy.version}\` evaluated at ${result.evaluatedAt}. Snapshot from ${result.scan.generatedAt} is **${result.freshness.state}**${result.freshness.ageHours != null ? ` (${result.freshness.ageHours} h old, target ${result.freshness.maxAgeHours ?? 'none'} h)` : ''}. Projects scanned: ${result.scan.projects.length}.`);
  lines.push('');
  lines.push(`Gate: **${result.gate.status}**${result.gate.failOn.length ? ` (fails on ${result.gate.failOn.join(', ')}; ${result.gate.failing.length} failing)` : ' (reporting only)'}.`);
  lines.push('');
  lines.push('| Findings | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Actionable | ${result.summary.actionable} |`);
  lines.push(`| Needs review | ${result.summary.needsReview} |`);
  lines.push(`| Informational | ${result.summary.informational} |`);
  for (const [rule, count] of Object.entries(result.summary.byRule || {})) lines.push(`| ${rule} | ${count} |`);
  lines.push('');
  lines.push('| Check | ' + states.join(' | ') + ' |');
  lines.push('| --- |' + states.map(() => ' --- |').join(''));
  for (const check of ['osv', 'registry']) lines.push(`| ${check === 'osv' ? 'OSV advisories' : 'npm registry'} | ` + states.map(state => result.checks.totals[check][state]).join(' | ') + ' |');
  lines.push('');
  if (result.transitions) {
    const counts = {};
    for (const item of result.transitions) counts[item.transition] = (counts[item.transition] || 0) + 1;
    lines.push(`Transitions against the previous result: ${Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(', ') || 'none'}.`);
    lines.push('');
  }
  const unknown = result.checks.totals.osv.failed + result.checks.totals.osv.unqueried + result.checks.totals.osv.unsupported + result.checks.totals.osv.stale;
  lines.push(unknown ? `${unknown} package version${unknown === 1 ? '' : 's'} ${unknown === 1 ? 'has' : 'have'} no current successful advisory check. Unknown is not clean.` : 'Every package version has a current successful advisory check for this snapshot; this is coverage, not proof of absence.');
  lines.push('');
  lines.push('Names, paths, and advisory text are in the private policy result, not in this summary.');
  return lines.join('\n') + '\n';
}
