import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate, loadSchema } from '../scripts/schema.mjs';
import { evaluate } from '../scripts/policy.mjs';
import { buildPacket, packetHashOf } from '../scripts/packet.mjs';
import { deliver, activeSuppression } from '../examples/notify/webhook.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(base, 'scripts/supply-chain.mjs');
const readJson = async file => JSON.parse(await readFile(resolve(base, file), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'supply-chain-packet-'));
const AT = '2026-10-31T00:00:00.000Z';

test('the packet is redacted, deterministic, hashed, and aliases replace project identity everywhere', async () => {
  const result = await readJson('contracts/examples/policy-result.json');
  const packet = buildPacket(result);
  assert.deepEqual(validate(await loadSchema('agent-packet'), packet).errors, []);
  assert.deepEqual(packet, await readJson('contracts/examples/agent-packet.json'), 'contracts/examples/agent-packet.json is stale; regenerate with: node scripts/supply-chain.mjs packet --result contracts/examples/policy-result.json --out contracts/examples/agent-packet.json');
  assert.equal(packet.packetHash, packetHashOf(packet));
  assert.equal(packet.packetId, 'pk_' + packet.packetHash.slice(0, 16));
  assert.deepEqual(buildPacket(result), packet, 'same result, same packet');
  const text = JSON.stringify(packet);
  for (const forbidden of ['/portfolio', 'rootPath', 'C:\\\\', 'example/web-app']) assert.ok(!text.includes(forbidden), `packet leaks ${forbidden}`);
  assert.ok(packet.items.every((item, index) => !index || packet.items[index - 1].eventId < item.eventId), 'items are sorted by event ID');
  assert.ok(packet.items.every(item => item.transition === 'observed' && item.baselineKnown === false), 'without a previous result every item is observed with no known baseline');
  const advisory = packet.items.find(item => item.ruleId === 'osv-advisory');
  assert.deepEqual(advisory.files, ['package-lock.json', 'package.json']);
  assert.ok(advisory.evidence.every(entry => /^ev_[0-9a-f]{16}$/.test(entry.id) && packet.evidenceIds.includes(entry.id)));
  assert.deepEqual(advisory.dependencyPath.map(step => step.label), ['web-app', 'vulnerable-lib@1.0.2'], 'the project step carries the alias, not the display label');
  assert.deepEqual(advisory.fixedBoundaries, ['1.0.3']);
  const tampered = JSON.parse(JSON.stringify(packet)); tampered.items[0].title = 'edited';
  assert.notEqual(packetHashOf(tampered), packet.packetHash);

  const aliased = buildPacket(result, { aliases: { 'web-app': 'alpha', 'unlocked-tool': 'beta' } });
  const aliasedText = JSON.stringify(aliased);
  for (const forbidden of ['web-app', 'Web App', 'unlocked-tool', 'Unlocked Tool']) assert.ok(!aliasedText.includes(forbidden), `aliased packet leaks ${forbidden}`);
  assert.deepEqual(Object.keys(aliased.scan.sourceCommits).sort(), ['alpha', 'beta']);
  assert.notEqual(aliased.packetHash, packet.packetHash);
  const actionableOnly = buildPacket(result, { include: ['actionable'] });
  assert.ok(actionableOnly.items.length < packet.items.length && actionableOnly.items.every(item => item.actionability === 'actionable'));
});

test('transitions flow into the packet; an unknown re-check is carried as unknown, never as a resolution', async () => {
  const snapshot = await readJson('contracts/examples/enriched-snapshot.json');
  const policy = await readJson('contracts/policy.default.json');
  const previous = evaluate(snapshot, policy, { now: AT });
  const later = JSON.parse(JSON.stringify(snapshot));
  later.generatedAt = '2026-10-31T06:00:00.000Z';
  later.enrichment.packages['npm:vulnerable-lib@1.0.2'].osv = { status: 'error', checkedAt: '2026-10-31T06:05:00.000Z', reason: 'HTTP 503' };
  const current = evaluate(later, policy, { now: '2026-10-31T07:00:00.000Z', previous });
  const packet = buildPacket(current);
  assert.deepEqual(validate(await loadSchema('agent-packet'), packet).errors, []);
  const advisoryId = previous.findings.find(finding => finding.ruleId === 'osv-advisory').id;
  const unknown = packet.items.find(item => item.findingId === advisoryId);
  assert.equal(unknown.transition, 'unknown');
  assert.equal(unknown.artifact, null);
  assert.ok(packet.items.filter(item => item.transition === 'still-observed').length > 0);
  assert.ok(packet.items.some(item => item.transition === 'observed' && item.ruleId === 'osv-lookup-failed'));
  const observedOnly = buildPacket(current, { transitions: ['observed'] });
  assert.ok(observedOnly.items.every(item => item.transition === 'observed'));
});

test('the webhook example signs, retries, deduplicates by idempotency key, honours suppressions, and never alerts on unknown', async () => {
  const packet = await readJson('contracts/examples/agent-packet.json');
  const unknownPacket = { ...packet, items: [...packet.items, { ...packet.items[0], eventId: 'e_0000000000000001', findingId: 'f_0000000000000001', transition: 'unknown', title: 'Previous finding could not be re-checked', artifact: null, evidence: [], files: [], dependencyPath: [], reasons: ['No comparable successful check this time'] }] };
  const received = [];
  let failFirst = true;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      if (failFirst) { failFirst = false; response.writeHead(503); response.end('try later'); return; }
      response.writeHead(200); response.end('ok');
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const secret = 'synthetic-secret';
  const receiptsFile = join(scratch, 'receipts.json');
  try {
    await assert.rejects(deliver(packet, { url: null, secret: null, receiptsFile }), /Set SCG_WEBHOOK_URL and SCG_WEBHOOK_SECRET/);
    const suppressions = { schemaVersion: 1, items: {
      [packet.items[1].findingId]: { status: 'acknowledged', owner: 'team-a', reason: 'tracked', createdAt: AT, expiresAt: '2027-01-01T00:00:00Z' },
      [packet.items[2].findingId]: { status: 'suppressed', owner: 'team-b', reason: 'expired example', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z' }
    } };
    const now = new Date('2026-10-31T12:00:00Z');
    assert.equal(activeSuppression(suppressions, packet.items[2].findingId, now).expired, true);
    const first = await deliver(unknownPacket, { url, secret, receiptsFile, suppressions, transitions: ['observed', 'unknown'], backoffMs: 1, now });
    assert.equal(first.outcome.notDeliverable, 1, 'unknown is never delivered even when asked for');
    assert.equal(first.outcome.suppressed, 1);
    assert.equal(first.outcome.delivered, packet.items.length - 1);
    assert.equal(first.outcome.failed, 0);
    assert.equal(received.length, packet.items.length, 'one retry after the 503 plus one request per delivered item');
    const sample = received[1];
    assert.equal(sample.headers['x-scg-signature'], 'sha256=' + createHmac('sha256', secret).update(sample.body).digest('hex'));
    assert.match(sample.headers['x-scg-idempotency-key'], /^e_[0-9a-f]{16}$/);
    assert.equal(sample.headers['x-scg-packet-hash'], packet.packetHash);
    const parsed = JSON.parse(sample.body);
    assert.equal(parsed.packetHash, packet.packetHash);
    assert.match(parsed.note, /Acknowledgement is not resolution/);
    for (const body of received.map(entry => entry.body)) for (const forbidden of ['/portfolio', 'rootPath', 'example/web-app']) assert.ok(!body.includes(forbidden));
    const receipts = JSON.parse(await readFile(receiptsFile, 'utf8'));
    assert.equal(receipts.destination, `127.0.0.1:${server.address().port}`);
    const retried = Object.values(receipts.deliveries).find(entry => entry.attempts === 2);
    assert.ok(retried && retried.status === 'delivered', 'the 503 was retried and then delivered');
    const suppressed = receipts.deliveries[packet.items[1].eventId];
    assert.equal(suppressed.status, 'suppressed');
    assert.equal(suppressed.suppressedBy, 'team-a');
    assert.equal(receipts.deliveries[packet.items[2].eventId].status, 'delivered', 'an expired suppression no longer blocks delivery');
    assert.ok(receipts.deliveries[packet.items[2].eventId].expiredSuppression);
    assert.ok(!receipts.deliveries['e_0000000000000001'], 'nothing is recorded for the unknown transition');
    assert.ok(!JSON.stringify(receipts).includes(secret));
    const before = received.length;
    const second = await deliver(unknownPacket, { url, secret, receiptsFile, suppressions, transitions: ['observed', 'unknown'], backoffMs: 1, now });
    assert.equal(received.length, before, 'a re-run delivers nothing twice');
    assert.equal(second.outcome.delivered, 0);
    const dry = await deliver(packet, { dryRun: true, receiptsFile: join(scratch, 'dry.json') });
    assert.equal(received.length, before, 'dry run sends nothing');
    assert.equal(dry.outcome.delivered, packet.items.length);
  } finally { await new Promise(done => server.close(done)); }
});

test('the CLI builds a packet and the webhook script refuses to send without configuration', async () => {
  const out = join(scratch, 'packet.json');
  const built = spawnSync(process.execPath, [cli, 'packet', '--result', resolve(base, 'contracts/examples/policy-result.json'), '--policy', resolve(base, 'contracts/policy.default.json'), '--out', out], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stderr, /items/);
  const refused = spawnSync(process.execPath, [resolve(base, 'examples/notify/webhook.mjs'), '--packet', out, '--receipts', join(scratch, 'r.json')], { encoding: 'utf8', env: { ...process.env, SCG_WEBHOOK_URL: '', SCG_WEBHOOK_SECRET: '' } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /nothing is sent without both/);
  const dry = spawnSync(process.execPath, [resolve(base, 'examples/notify/webhook.mjs'), '--packet', out, '--receipts', join(scratch, 'dry-cli.json'), '--dry-run'], { encoding: 'utf8', env: { ...process.env, SCG_WEBHOOK_URL: '', SCG_WEBHOOK_SECRET: '' } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /Delivered 9, skipped 0/);
  await writeFile(join(scratch, 'placeholder'), '');
});
