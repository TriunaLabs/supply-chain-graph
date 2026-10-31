import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { summarize } from '../scripts/summary.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(base, 'scripts/supply-chain.mjs');
const read = async file => (await readFile(resolve(base, file), 'utf8')).replace(/\r\n/g, '\n');

test('workflows run read-only, pin every action to a full commit SHA, and never use pull_request_target', async () => {
  for (const file of ['examples/ci/scan.yml', '.github/workflows/ci.yml']) {
    const text = await read(file);
    assert.match(text, /^permissions:\n  contents: read$/m, `${file} declares a read-only token at the top level`);
    assert.ok(!/^\s*pull_request_target\s*:/m.test(text), `${file} must not trigger on pull_request_target`);
    const uses = [...text.matchAll(/^\s*uses:\s*(\S+)/gm)].map(match => match[1]);
    assert.ok(uses.length >= 2, `${file} uses actions`);
    for (const reference of uses) assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${reference} in ${file} is pinned to a full commit SHA`);
    assert.ok(!/upload-artifact|actions\/deploy-pages|upload-pages-artifact/.test(text), `${file} publishes no artifacts or Pages`);
  }
  const caller = await read('examples/ci/scan.yml');
  assert.match(caller, /SKILL_REF: REPLACE_WITH_REVIEWED_COMMIT_SHA/, 'the caller must pin the skill to a reviewed commit, not a branch');
  assert.match(caller, /ref: \$\{\{ env\.SKILL_REF \}\}/);
  assert.match(caller, /--root "\$GITHUB_WORKSPACE"/, 'the caller scans only its own checkout');
  assert.ok(!/--search-root/.test(caller), 'no discovery of the runner filesystem');
  assert.match(caller, /github\.event_name == 'workflow_dispatch' && inputs\.enrich/, 'enrichment is opt-in and never runs on pull requests');
  assert.match(caller, /3\) echo "::error::The configured policy gate failed/);
  assert.match(caller, /\*\) echo "::error::Scan or evaluation failed/);
  assert.match(caller, /persist-credentials: false/);
});

test('the job summary carries counts only: no project IDs, labels, paths, package names, or advisory text', async () => {
  const result = JSON.parse(await read('contracts/examples/policy-result.json'));
  const text = summarize(result);
  assert.match(text, /## Supply chain scan summary/);
  assert.match(text, /\| Actionable \| 3 \|/);
  assert.match(text, /\| OSV advisories \| 2 \| 1 \| 1 \| 1 \| 1 \| 0 \|/);
  assert.match(text, /Gate: \*\*not-configured\*\*/);
  assert.match(text, /Unknown is not clean/);
  for (const secret of ['web-app', 'Web App', 'unlocked-tool', '/portfolio', 'vulnerable-lib', 'GHSA-xxxx', 'unbounded recursion', 'old-tool', 'actions/checkout', '0123456789abcdef']) assert.ok(!text.includes(secret), `summary leaks "${secret}"`);
  const viaCli = execFileSync(process.execPath, [cli, 'summary', '--result', resolve(base, 'contracts/examples/policy-result.json'), '--out', '-'], { encoding: 'utf8' });
  assert.equal(viaCli, text);
  assert.throws(() => summarize({ ...result, schemaVersion: 2 }), /not supported/);
});
