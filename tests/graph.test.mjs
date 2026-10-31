import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(base, 'scripts/supply-chain.mjs');
const scratch = await mkdtemp(resolve(tmpdir(), 'supply-chain-graph-test-'));
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: base, encoding: 'utf8' });

test('nested npm resolution keeps the actual version and diff reports a change', async () => {
  const root = resolve(scratch, 'project');
  await mkdir(root, { recursive: true });
  const manifest = { name: 'test-project', version: '1.0.0', dependencies: { alpha: '^1.0.0' } };
  const lock = { name: 'test-project', version: '1.0.0', lockfileVersion: 3, packages: {
    '': { version: '1.0.0', dependencies: { alpha: '^1.0.0' } },
    'node_modules/alpha': { version: '1.0.0', deprecated: 'Legacy package', dependencies: { beta: '^2.0.0' } },
    'node_modules/beta': { version: '1.0.0' },
    'node_modules/alpha/node_modules/beta': { version: '2.0.0' },
    'packages/workspace': { name: 'workspace', version: '1.0.0', dependencies: { beta: '^1.0.0' } }
  } };
  await writeFile(resolve(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify(lock));
  const config = resolve(scratch, 'config.json');
  const beforeFile = resolve(scratch, 'before.json');
  const afterFile = resolve(scratch, 'after.json');
  const eventsFile = resolve(scratch, 'events.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'test', root }] }));
  run('scan', '--config', config, '--out', beforeFile);
  const before = JSON.parse(await readFile(beforeFile, 'utf8'));
  assert.equal(before.nodes.find(node => node.id === 'npm:alpha@1.0.0').localDeprecation, 'Legacy package');
  assert.ok(before.edges.some(e => e.from === 'project:test' && e.to === 'decl:js:test:root:runtime:alpha' && e.kind === 'declares'));
  assert.ok(before.edges.some(e => e.from === 'decl:js:test:root:runtime:alpha' && e.to === 'occ:test:node_modules/alpha' && e.kind === 'resolved-by'));
  assert.ok(before.edges.some(e => e.from === 'occ:test:node_modules/alpha' && e.to === 'occ:test:node_modules/alpha/node_modules/beta'));
  assert.ok(!before.edges.some(e => e.from === 'occ:test:node_modules/alpha' && e.to === 'occ:test:node_modules/beta'));
  assert.ok(before.edges.some(e => e.from === 'occ:test:packages/workspace' && e.to === 'occ:test:node_modules/beta'));
  lock.packages['node_modules/alpha/node_modules/beta'].version = '2.1.0';
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify(lock));
  run('scan', '--config', config, '--out', afterFile);
  run('diff', '--previous', beforeFile, '--current', afterFile, '--out', eventsFile);
  const events = JSON.parse(await readFile(eventsFile, 'utf8')).events;
  assert.ok(events.some(e => e.kind === 'package-changed' && e.name === 'beta' && e.from === '2.0.0' && e.to === '2.1.0'));
});

test('missing npm lockfile remains visible as a coverage finding', async () => {
  const root = resolve(scratch, 'unlocked');
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'unlocked', dependencies: { alpha: '^1' } }));
  const config = resolve(scratch, 'unlocked-config.json');
  const result = resolve(scratch, 'unlocked-result.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'unlocked', root }] }));
  run('scan', '--config', config, '--out', result);
  const snapshot = JSON.parse(await readFile(result, 'utf8'));
  assert.ok(snapshot.findings.some(f => f.type === 'missing-lockfile'));
  assert.ok(snapshot.edges.some(e => e.kind === 'declares' && e.to === 'decl:js:unlocked:root:runtime:alpha'));
  assert.ok(!snapshot.edges.some(e => e.kind === 'resolved-by'));
});

test('source imports expose local modules and a browser import map without inventing an installed version', async () => {
  const root = resolve(scratch, 'source-only');
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'source-only', type: 'module' }));
  await writeFile(resolve(root, 'index.html'), '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>');
  await writeFile(resolve(root, 'src/main.js'), "import * as THREE from 'three';\nimport { value } from './local.js';\nconst loader = import('three/addons/loaders/GLTFLoader.js');\n// import 'fake-package';\n");
  await writeFile(resolve(root, 'src/local.js'), 'export const value = 1;\n');
  const config = resolve(scratch, 'source-config.json'), result = resolve(scratch, 'source-result.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'source-only', root }] }));
  run('scan', '--config', config, '--out', result);
  const snapshot = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(snapshot.coverage[0].npm, 'manifest-only');
  assert.equal(snapshot.coverage[0].sourceImports, 3);
  assert.ok(snapshot.edges.some(e => e.from === 'project:source-only' && e.to === 'source:source-only:src/main.js' && e.kind === 'has-source-imports'));
  assert.ok(snapshot.edges.some(e => e.from === 'source:source-only:src/main.js' && e.to === 'source-target:source-only:src/local.js' && e.kind === 'imports-local'));
  assert.ok(snapshot.edges.some(e => e.from === 'source:source-only:src/main.js' && e.to === 'source-package:source-only:three' && e.kind === 'imports-external' && e.mappedUrl.includes('three@0.160.0')));
  assert.ok(snapshot.edges.some(e => e.kind === 'imports-external' && e.scope.includes('GLTFLoader') && e.source === 'src/main.js:3'));
  assert.equal(snapshot.nodes.find(n => n.id === 'source-package:source-only:three').versionHint, '0.160.0');
  assert.ok(!snapshot.nodes.some(n => n.id === 'npm:three@0.160.0'));
  assert.ok(snapshot.findings.some(f => f.type === 'missing-lockfile' && /external source imports found/.test(f.title)));
});

test('BOM manifests, pnpm v9 paths, and workflow actions produce relationships', async () => {
  const root = resolve(scratch, 'pnpm-project');
  await mkdir(resolve(root, '.github/workflows'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '\uFEFF' + JSON.stringify({ name: 'pnpm-project', packageManager: 'pnpm@11.6.0', dependencies: { alpha: '^1' } }));
  await writeFile(resolve(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: ^1\n        version: 1.0.0\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-example}\n  beta@2.0.0:\n    resolution: {integrity: sha512-example}\nsnapshots:\n  alpha@1.0.0:\n    dependencies:\n      beta: 2.0.0\n  beta@2.0.0: {}\n`);
  await writeFile(resolve(root, '.github/workflows/check.yml'), 'jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v4\n');
  await writeFile(resolve(root, 'requirements.txt'), 'requests==2.32.0\nhttpx>=0.27\n');
  await writeFile(resolve(root, '.gitmodules'), '[submodule "fixture"]\n  path = fixture\n  url = https://github.com/example/fixture.git\n');
  const config = resolve(scratch, 'pnpm-config.json'), result = resolve(scratch, 'pnpm-result.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'pnpm', root }] }));
  run('scan', '--config', config, '--out', result);
  const snapshot = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(snapshot.coverage[0].npm, 'pnpm-v9');
  assert.ok(!snapshot.findings.some(f => f.type === 'manifest-error'));
  assert.ok(snapshot.edges.some(e => e.from === 'project:pnpm' && e.to === 'occ:pnpm:pnpm:alpha@1.0.0'));
  assert.ok(snapshot.edges.some(e => e.from === 'decl:js:pnpm:root:runtime:alpha' && e.to === 'occ:pnpm:pnpm:alpha@1.0.0' && e.kind === 'resolved-by'));
  assert.ok(snapshot.edges.some(e => e.from === 'occ:pnpm:pnpm:alpha@1.0.0' && e.to === 'occ:pnpm:pnpm:beta@2.0.0'));
  assert.ok(snapshot.edges.some(e => e.from === 'project:pnpm' && e.to === 'action:actions/checkout@v4'));
  assert.ok(snapshot.edges.some(e => e.from === 'project:pnpm' && e.to === 'pypi:requests@2.32.0'));
  assert.ok(snapshot.edges.some(e => e.from === 'project:pnpm' && e.to === 'github:example/fixture' && e.kind === 'submodule'));
});

test('unconfigured source path explains the coverage gap without implying a read failure', async () => {
  const config = resolve(scratch, 'no-root-config.json'), result = resolve(scratch, 'no-root-result.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'no-root', root: null }] }));
  run('scan', '--config', config, '--out', result);
  const snapshot = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(snapshot.coverage[0].npm, 'path-not-configured');
  assert.match(snapshot.nodes.find(node => node.id === 'project:no-root').sourceStatus, /No path is configured/);
  assert.match(snapshot.findings[0].title, /No project source path is configured/);
});

test('diff reports checked advisory signals and does not resolve them after a failed lookup', async () => {
  const previous = { schemaVersion: 1, generatedAt: '2026-10-29T00:00:00Z', findings: [], nodes: [{ id: 'project:check', kind: 'project', projectId: 'check' }, { id: 'occ:check:alpha', kind: 'occurrence', projectId: 'check', name: 'alpha', version: '1.0.0', location: 'node_modules/alpha' }, { id: 'npm:alpha@1.0.0', kind: 'artifact', ecosystem: 'npm', name: 'alpha', version: '1.0.0' }], edges: [{ from: 'occ:check:alpha', to: 'npm:alpha@1.0.0', kind: 'resolves-to' }] };
  const current = { ...previous, generatedAt: '2026-10-30T00:00:00Z', enrichment: { packages: { 'npm:alpha@1.0.0': { osv: { status: 'checked', checkedAt: '2026-10-30T00:00:00Z', advisories: [{ id: 'OSV-EXAMPLE' }] }, registry: { status: 'checked', checkedAt: '2026-10-30T00:00:00Z', deprecated: 'Use another package', latestTag: '2.0.0', newerLatestTag: true } } } } };
  const oldFile = resolve(scratch, 'signal-old.json'), newFile = resolve(scratch, 'signal-new.json'), eventFile = resolve(scratch, 'signal-events.json');
  await writeFile(oldFile, JSON.stringify(previous)); await writeFile(newFile, JSON.stringify(current));
  run('diff', '--previous', oldFile, '--current', newFile, '--out', eventFile);
  const events = JSON.parse(await readFile(eventFile, 'utf8')).events;
  assert.ok(events.some(event => event.kind === 'advisory-observed' && event.advisoryId === 'OSV-EXAMPLE' && event.impactedProjects[0] === 'check' && event.baselineKnown === false));
  assert.ok(events.some(event => event.kind === 'deprecation-observed'));
  assert.ok(events.some(event => event.kind === 'newer-latest-observed'));
  const failed = { ...current, generatedAt: '2026-10-31T00:00:00Z', enrichment: { packages: { 'npm:alpha@1.0.0': { osv: { status: 'error', checkedAt: '2026-10-31T00:00:00Z', reason: 'offline' } } } } };
  await writeFile(oldFile, JSON.stringify(current));
  await writeFile(newFile, JSON.stringify(failed));
  run('diff', '--previous', oldFile, '--current', newFile, '--out', eventFile);
  const failedEvents = JSON.parse(await readFile(eventFile, 'utf8')).events;
  assert.ok(!failedEvents.some(event => event.kind === 'advisory-no-longer-returned'));
  const cached = { ...previous, nodes: previous.nodes.map(node => node.id === 'npm:alpha@1.0.0' ? { ...node, localDeprecation: 'Cached warning' } : node) };
  await writeFile(oldFile, JSON.stringify(previous)); await writeFile(newFile, JSON.stringify(cached));
  run('diff', '--previous', oldFile, '--current', newFile, '--out', eventFile);
  assert.ok(JSON.parse(await readFile(eventFile, 'utf8')).events.some(event => event.kind === 'cached-deprecation-observed'));
});
