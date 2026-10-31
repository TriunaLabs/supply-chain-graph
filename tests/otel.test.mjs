import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createTelemetry, sanitizeAttributes, errorCode } from '../examples/otel/telemetry.mjs';
import { runPipeline } from '../examples/otel/run-pipeline.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'supply-chain-otel-'));

test('span attributes are allowlisted: secrets, paths, names, versions and messages never reach the export', async () => {
  const secret = 'ghp_syntheticSECRET1234567890', path = 'C:\\Users\\someone\\code\\private-app', pkg = 'vulnerable-lib@1.0.2';
  const kept = sanitizeAttributes({ 'scg.stage': 'scan', 'scg.count.nodes': 12, 'scg.coverage.osv.failed': 1, 'scg.flag.enriched': false,
    'scg.token': secret, 'scg.root': path, 'scg.package': pkg, 'scg.count.bad': 'twelve', 'scg.coverage.osv.clean': 3, 'scg.coverage.registry.failed.extra': 1, 'scg.stage.name': 'x', 'scg.outcome': 'success', 'scg.error.code': 'HTTP 503 from https://example.invalid/private', 'repo.name': 'example/web-app' });
  assert.deepEqual(kept, { 'scg.stage': 'scan', 'scg.count.nodes': 12, 'scg.coverage.osv.failed': 1, 'scg.flag.enriched': false, 'scg.dropped_attributes': 10 });
  assert.deepEqual(sanitizeAttributes({ 'scg.error.code': 'http_503' }), { 'scg.error.code': 'http_503' });
  assert.equal(errorCode(Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })), 'enoent');
  assert.equal(errorCode(new Error(`HTTP 503 while fetching ${secret}`)), 'http_503');
  assert.equal(errorCode(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(errorCode(new Error(`cannot read ${path}: token ${secret}`)), 'error');

  const posts = [];
  const telemetry = createTelemetry({ endpoint: 'http://collector.invalid', fetchImpl: async (url, init) => { posts.push({ url, body: init.body }); return { ok: true, status: 200 }; }, now: (() => { let t = 1000; return () => (t += 5); })() });
  await telemetry.span('scan', { 'scg.root': path, 'scg.count.nodes': 3 }, async set => { set({ 'scg.package': pkg, 'scg.count.edges': 4 }); });
  await assert.rejects(telemetry.span('enrich', {}, async () => { throw new Error(`HTTP 503 fetching ${secret} for ${pkg} at ${path}`); }), /HTTP 503/);
  await assert.rejects(telemetry.span('upload', {}, async () => {}), /Unknown stage/);
  const flushed = await telemetry.flush();
  assert.equal(flushed.exported, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://collector.invalid/v1/traces');
  const exported = posts[0].body;
  for (const forbidden of [secret, path, pkg, 'private-app', 'example.invalid', 'someone']) assert.ok(!exported.includes(forbidden), `export leaks ${forbidden}`);
  const names = JSON.parse(exported).resourceSpans[0].scopeSpans[0].spans.map(span => span.name);
  assert.deepEqual(names, ['scg.scan', 'scg.enrich']);
  const enrichSpan = JSON.parse(exported).resourceSpans[0].scopeSpans[0].spans[1];
  assert.equal(enrichSpan.status.code, 2);
  assert.ok(enrichSpan.attributes.some(attribute => attribute.key === 'scg.error.code' && attribute.value.stringValue === 'http_503'));
  assert.ok(enrichSpan.attributes.some(attribute => attribute.key === 'scg.duration_ms' && attribute.value.intValue === '5'));

  const silent = createTelemetry({ endpoint: null, fetchImpl: async () => { throw new Error('must not be called'); } });
  await silent.span('packet', { 'scg.count.items': 1 }, async () => {});
  const unsent = await silent.flush();
  assert.equal(unsent.exported, false);
  assert.equal(unsent.spans, 1);
  assert.throws(() => createTelemetry({ endpoint: 'collector:4318' }), /explicit http\(s\) URL/);
});

test('the pipeline example emits one span per stage and exports nothing from the fixture but counts', async () => {
  const received = [];
  const server = createServer((request, response) => { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { received.push({ url: request.url, body }); response.writeHead(200); response.end(); }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const privateDir = join(scratch, 'run');
    const telemetry = createTelemetry({ endpoint: `http://127.0.0.1:${server.address().port}` });
    const run = await runPipeline({ config: resolve(base, 'examples/portfolio.example.json'), privateDir, telemetry });
    assert.deepEqual(run.telemetry.spans.map(span => span.name), ['scg.scan', 'scg.evaluate', 'scg.packet']);
    assert.equal(run.exported.exported, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/v1/traces');
    const exported = received[0].body;
    const fixtureRoot = resolve(base, 'examples/fixture/sample-app');
    for (const forbidden of [fixtureRoot, fixtureRoot.replace(/\\/g, '/'), 'sample-app', 'Sample App', 'graph-widget', 'shared-core', 'requests', 'TriunaLabs/supply-chain-graph', '790276d']) assert.ok(!exported.includes(forbidden), `pipeline export leaks ${forbidden}`);
    const spans = JSON.parse(exported).resourceSpans[0].scopeSpans[0].spans;
    const attribute = (span, key) => span.attributes.find(entry => entry.key === key)?.value;
    assert.equal(attribute(spans[0], 'scg.count.nodes').intValue, String(run.snapshot.nodes.length));
    assert.equal(attribute(spans[1], 'scg.gate').stringValue, 'not-configured');
    assert.equal(attribute(spans[1], 'scg.coverage.osv.unqueried').intValue, '3');
    assert.equal(attribute(spans[2], 'scg.count.items').intValue, String(run.packet.items.length));

    const proposal = join(scratch, 'proposal.json'), decision = join(scratch, 'decision.json');
    await writeFile(proposal, JSON.stringify({ schemaVersion: 1, proposalId: 'bad', eventId: 'e_0000000000000000', sourceCommit: 'abcdef1', packetHash: 'c'.repeat(64), summary: 'x', evidenceIds: ['ev_0000000000000000'], suggestedAction: 'investigate', affectedFiles: [], currentArtifact: { ecosystem: 'npm', name: 'x' }, targetArtifact: null, dependencyPath: ['x'], validationSteps: [], unknowns: [], rollbackSteps: [], confidence: 0.1 }));
    await writeFile(decision, JSON.stringify({ schemaVersion: 1, proposalId: 'bad', proposalHash: 'd'.repeat(64), packetHash: 'c'.repeat(64), sourceCommit: 'abcdef1', reviewer: { identity: 'x', method: 'manual-record' }, decision: 'approve', decidedAt: '2026-10-31T00:00:00Z', expiresAt: '2027-10-31T00:00:00Z', reason: 'x' }));
    const second = createTelemetry({ endpoint: null });
    const withChecks = await runPipeline({ config: resolve(base, 'examples/portfolio.example.json'), privateDir: join(scratch, 'run2'), proposal, decision, telemetry: second });
    assert.equal(withChecks.proposalOk, false);
    assert.equal(withChecks.authorized, false);
    const outcomes = Object.fromEntries(second.spans.map(span => [span.name, span.attributes['scg.outcome']]));
    assert.equal(outcomes['scg.proposal.check'], 'rejected');
    assert.equal(outcomes['scg.decision.check'], 'not-authorized');
    assert.equal(withChecks.exported.exported, false);
    assert.ok(!JSON.stringify(second.payload()).includes('abcdef1'));
    await readFile(join(scratch, 'run2', 'packet.json'));
  } finally { await new Promise(done => server.close(done)); }
});
