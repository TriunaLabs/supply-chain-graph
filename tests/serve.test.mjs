import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/supply-chain.mjs');
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

test('local root editor requires its token and rescans the chosen directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'supply-server-'));
  const root = join(base, 'app'), config = join(base, 'portfolio.json'), snapshot = join(base, 'snapshot.json'), html = join(base, 'dashboard.html');
  const port = await freePort();
  await mkdir(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'test-app', dependencies: { alpha: '^1.0.0' } }));
  await writeFile(config, JSON.stringify({ projects: [{ id: 'app', label: 'App', root: null }] }));
  await writeFile(snapshot, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), nodes: [], edges: [], coverage: [], findings: [] }));
  await writeFile(html, '<script>const snapshot = {};</script>');
  const child = spawn(process.execPath, [cli, 'serve', '--config', config, '--snapshot', snapshot, '--out', html, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let sessionUrl;
    await Promise.race([
      new Promise((done, reject) => { let log = ''; child.stderr.on('data', chunk => { log += chunk; sessionUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?key=[a-f0-9]+/)?.[0]; if (sessionUrl) done(); }); child.once('exit', code => reject(new Error(`Server exited ${code}: ${log}`))); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 5000))
    ]);
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin)).status, 403);
    const page = await (await fetch(sessionUrl)).text();
    const token = page.match(/token: '([a-f0-9]+)'/)?.[1];
    assert.ok(token);
    const body = JSON.stringify({ id: 'app', root });
    const denied = await fetch(`${origin}/api/set-root`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(denied.status, 403);
    const saved = await fetch(`${origin}/api/set-root`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': token }, body });
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(JSON.parse(await readFile(config, 'utf8')).projects[0].root, root);
    const rescanned = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(rescanned.coverage[0].npm, 'manifest-only');
    assert.equal(rescanned.nodes.find(node => node.id === 'project:app').rootPath, root);
    const arbitraryFolder = await fetch(`${origin}/api/open-folder`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': token }, body: JSON.stringify({ nodeId: '../../' }) });
    assert.equal(arbitraryFolder.status, 400);
    const noTokenFolder = await fetch(`${origin}/api/open-folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'project:app' }) });
    assert.equal(noTokenFolder.status, 403);
    const triage = await fetch(`${origin}/api/triage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': token }, body: JSON.stringify({ key: 'finding:missing-lock:app', status: 'investigating', note: 'Check the lockfile owner' }) });
    assert.equal(triage.status, 200);
    const state = JSON.parse(await readFile(join(base, 'triage-state.json'), 'utf8'));
    assert.equal(state.items['finding:missing-lock:app'].status, 'investigating');
    const readBack = await fetch(`${origin}/api/triage`, { headers: { 'x-supply-chain-token': token } });
    assert.equal((await readBack.json()).items['finding:missing-lock:app'].note, 'Check the lockfile owner');
  } finally { child.kill(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
