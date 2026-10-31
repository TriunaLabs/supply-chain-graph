import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichSnapshot, newerStableTag } from '../scripts/enrich.mjs';

const snapshot = {
  generatedAt: '2026-10-30T00:00:00Z',
  nodes: [
    { id: 'project:one', kind: 'project', projectId: 'one' },
    { id: 'project:two', kind: 'project', projectId: 'two' },
    { id: 'occ:one:alpha', kind: 'occurrence', projectId: 'one' },
    { id: 'occ:one:beta', kind: 'occurrence', projectId: 'one' },
    { id: 'occ:two:gamma', kind: 'occurrence', projectId: 'two' },
    { id: 'npm:alpha@1.0.0', kind: 'artifact', ecosystem: 'npm', name: 'alpha', version: '1.0.0' },
    { id: 'npm:beta@2.0.0', kind: 'artifact', ecosystem: 'npm', name: 'beta', version: '2.0.0' },
    { id: 'npm:gamma@3.0.0', kind: 'artifact', ecosystem: 'npm', name: 'gamma', version: '3.0.0' }
  ],
  edges: [
    { from: 'occ:one:alpha', to: 'npm:alpha@1.0.0', kind: 'resolves-to' },
    { from: 'occ:one:beta', to: 'npm:beta@2.0.0', kind: 'resolves-to' },
    { from: 'occ:two:gamma', to: 'npm:gamma@3.0.0', kind: 'resolves-to' }
  ]
};

test('enrichment preserves checked, advisory, deprecation, and unscanned states', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.includes('querybatch')) {
      const { queries } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ results: queries.map(query => ({ vulns: query.package.name === 'alpha' ? [{ id: 'OSV-EXAMPLE', modified: '2026-01-01T00:00:00Z' }] : [] })) }) };
    }
    const name = decodeURIComponent(url.split('/').at(-1));
    return { ok: true, json: async () => ({ 'dist-tags': { latest: name === 'alpha' ? '2.0.0' : '2.0.0' }, versions: { [name === 'alpha' ? '1.0.0' : '2.0.0']: { deprecated: name === 'alpha' ? 'Use the replacement' : undefined } } }) };
  };
  const result = await enrichSnapshot(snapshot, { projectId: 'one', fetchImpl });
  const alpha = result.enrichment.packages['npm:alpha@1.0.0'];
  assert.equal(alpha.osv.status, 'checked');
  assert.deepEqual(alpha.osv.advisories.map(item => item.id), ['OSV-EXAMPLE']);
  assert.equal(alpha.registry.deprecated, 'Use the replacement');
  assert.equal(alpha.registry.newerLatestTag, true);
  assert.equal(result.enrichment.packages['npm:beta@2.0.0'].osv.advisories.length, 0);
  assert.equal(result.enrichment.packages['npm:gamma@3.0.0'], undefined);
  assert.equal(calls.length, 3);
});

test('failed lookups stay unknown, and prerelease tags are not called outdated', async () => {
  const fetchImpl = async url => url.includes('querybatch') ? Promise.reject(new Error('offline')) : { ok: false, status: 404 };
  const result = await enrichSnapshot(snapshot, { projectId: 'one', fetchImpl });
  const alpha = result.enrichment.packages['npm:alpha@1.0.0'];
  assert.equal(alpha.osv.status, 'error');
  assert.equal(alpha.registry.status, 'unavailable');
  assert.equal(newerStableTag('1.0.0-beta.1', '1.0.0'), null);
  assert.equal(newerStableTag('2.0.0', '1.0.0'), false);
});

test('OSV pagination is completed before a package is marked checked', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const query = JSON.parse(options.body).queries[0];
    return { ok: true, json: async () => ({ results: [{ vulns: [{ id: query.page_token ? 'OSV-SECOND' : 'OSV-FIRST' }], ...(query.page_token ? {} : { next_page_token: 'page-two' }) }] }) };
  };
  const one = { ...snapshot, nodes: snapshot.nodes.filter(node => ['project:one', 'occ:one:alpha', 'npm:alpha@1.0.0'].includes(node.id)), edges: snapshot.edges.slice(0, 1) };
  const result = await enrichSnapshot(one, { fetchImpl, checkNpm: false });
  assert.equal(calls, 2);
  assert.deepEqual(result.enrichment.packages['npm:alpha@1.0.0'].osv.advisories.map(item => item.id), ['OSV-FIRST', 'OSV-SECOND']);
});

test('Git-sourced package names are not sent to npm or OSV as registry identities', async () => {
  const one = { ...snapshot, nodes: snapshot.nodes.filter(node => ['project:one', 'occ:one:alpha', 'npm:alpha@1.0.0'].includes(node.id)).map(node => node.id === 'occ:one:alpha' ? { ...node, sourceKind: 'github-git' } : node), edges: snapshot.edges.slice(0, 1) };
  const result = await enrichSnapshot(one, { fetchImpl: async () => { throw new Error('request should not run'); } });
  assert.equal(result.enrichment.packages['npm:alpha@1.0.0'].osv.status, 'unavailable');
  assert.match(result.enrichment.packages['npm:alpha@1.0.0'].registry.reason, /cannot verify the installed code/);
});
