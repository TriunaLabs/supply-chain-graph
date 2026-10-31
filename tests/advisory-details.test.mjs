import test from 'node:test';
import assert from 'node:assert/strict';
import { addAdvisoryDetails } from '../scripts/advisory-details.mjs';

test('advisory details retain source severity and package-specific fixed boundaries', async () => {
  const snapshot = { enrichment: { packages: { 'npm:alpha@1.0.0': { osv: { status: 'checked', advisories: [{ id: 'GHSA-example', modified: '2026-10-30T00:00:00Z' }] } } } } };
  const calls = [];
  const result = await addAdvisoryDetails(snapshot, { fetchImpl: async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: 'GHSA-example', summary: 'Example issue', database_specific: { severity: 'HIGH' }, affected: [{ package: { ecosystem: 'npm', name: 'alpha' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }, { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ type: 'SEMVER', events: [{ fixed: '9.0.0' }] }] }] }) };
  } });
  assert.equal(calls.length, 1);
  assert.equal(result.enrichment.advisories['GHSA-example'].severity, 'HIGH');
  assert.deepEqual(result.enrichment.advisories['GHSA-example'].affected.find(item => item.name === 'alpha').fixedBoundaries, ['1.0.1']);
  await addAdvisoryDetails(result, { fetchImpl: async () => { throw new Error('should reuse unchanged detail'); } });
});
