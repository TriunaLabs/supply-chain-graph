import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
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

test('folder picker returns only the chosen directory, validates it, and saves nothing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'supply-picker-'));
  const root = join(base, 'Chosen App'), config = join(base, 'portfolio.json'), snapshot = join(base, 'snapshot.json'), html = join(base, 'dashboard.html');
  const control = join(base, 'pick.txt'), picker = join(base, 'fake-picker.mjs');
  const port = await freePort();
  await mkdir(root);
  await writeFile(config, JSON.stringify({ projects: [{ id: 'app', label: 'App', root: null }] }));
  await writeFile(snapshot, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), nodes: [], edges: [], coverage: [], findings: [] }));
  await writeFile(html, '<script>const snapshot = {};</script>');
  await writeFile(picker, [
    "import { readFileSync } from 'node:fs';",
    `const choice = readFileSync(${JSON.stringify(control)}, 'utf8').trim();`,
    "if (choice === 'cancel') { process.stderr.write('User canceled.'); process.exit(1); }",
    'process.stdout.write(choice);'
  ].join('\n'));
  const configBefore = await readFile(config, 'utf8');
  const child = spawn(process.execPath, [cli, 'serve', '--config', config, '--snapshot', snapshot, '--out', html, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SUPPLY_CHAIN_FOLDER_PICKER: JSON.stringify([process.execPath, picker]) } });
  try {
    let sessionUrl;
    await Promise.race([
      new Promise((done, reject) => { let log = ''; child.stderr.on('data', chunk => { log += chunk; sessionUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?key=[a-f0-9]+/)?.[0]; if (sessionUrl) done(); }); child.once('exit', code => reject(new Error(`Server exited ${code}: ${log}`))); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 5000))
    ]);
    const origin = `http://127.0.0.1:${port}`;
    const token = (await (await fetch(sessionUrl)).text()).match(/token: '([a-f0-9]+)'/)?.[1];
    const pick = (headers = {}) => fetch(`${origin}/api/pick-folder`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': token, ...headers }, body: '{}' });
    await writeFile(control, root);
    assert.equal((await fetch(`${origin}/api/pick-folder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const chosen = await pick();
    const chosenText = await chosen.text();
    assert.equal(chosen.status, 200, chosenText);
    const result = JSON.parse(chosenText);
    assert.equal(result.path.toLowerCase(), root.toLowerCase());
    assert.equal(result.suggestedId, 'chosen-app');
    assert.equal(result.suggestedLabel, 'Chosen App');
    await writeFile(control, 'cancel');
    assert.deepEqual(await (await pick()).json(), { cancelled: true });
    await writeFile(control, join(base, 'does-not-exist'));
    const missing = await pick();
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /not an accessible directory/);
    await writeFile(control, parse(base).root);
    const drive = await pick();
    assert.equal(drive.status, 400);
    assert.match((await drive.json()).error, /not a whole drive or filesystem root/);
    assert.equal(await readFile(config, 'utf8'), configBefore, 'picking never writes the config');
    assert.equal(JSON.parse(await readFile(snapshot, 'utf8')).nodes.length, 0, 'picking never rescans');

    const parent = join(base, 'Projects');
    for (const name of ['alpha', 'beta']) { await mkdir(join(parent, name, '.git'), { recursive: true }); await writeFile(join(parent, name, 'package.json'), JSON.stringify({ name })); }
    await mkdir(join(parent, 'notes'));
    const post = (path, payload) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': token }, body: JSON.stringify(payload) });
    const rejected = await post('/api/discover', { searchRoot: parse(base).root });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not a whole drive or filesystem root/);
    const relative = await post('/api/discover', { searchRoot: 'Projects' });
    assert.equal(relative.status, 400);
    const beforeAdopt = await post('/api/adopt-discovery', {});
    assert.equal(beforeAdopt.status, 400);
    assert.match((await beforeAdopt.json()).error, /Run discovery under a parent folder first/);
    const discovered = await post('/api/discover', { searchRoot: parent });
    const discoveredText = await discovered.text();
    assert.equal(discovered.status, 200, discoveredText);
    const discoveredBody = JSON.parse(discoveredText);
    assert.equal(discoveredBody.discovery.candidates, 2);
    assert.equal(discoveredBody.discovery.unlisted, 2);
    const configAfterDiscover = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(configAfterDiscover.projects.length, 1, 'discovery adds nothing to the project list');
    assert.equal(configAfterDiscover.searchRoots.length, 1);
    assert.equal(JSON.parse(await readFile(snapshot, 'utf8')).discovery.candidates.filter(candidate => candidate.status === 'unlisted').length, 2);
    const adopted = await post('/api/adopt-discovery', { nestedLocks: false });
    const adoptedText = await adopted.text();
    assert.equal(adopted.status, 200, adoptedText);
    assert.deepEqual(JSON.parse(adoptedText).added.sort(), ['alpha', 'beta']);
    const configAfterAdopt = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(configAfterAdopt.projects.map(project => project.id).sort(), ['alpha', 'app', 'beta']);
    const rescanned = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(rescanned.coverage.length, 3);
    assert.ok(rescanned.discovery.candidates.every(candidate => candidate.status === 'configured'));
    assert.match(await readFile(html, 'utf8'), /Supply Chain Graph/);
  } finally { child.kill(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
