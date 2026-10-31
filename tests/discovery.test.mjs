import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discover, adoptDiscovery, upsertRoot } from '../scripts/discover.mjs';

const cli = fileURLToPath(new URL('../scripts/supply-chain.mjs', import.meta.url));

test('discovery distinguishes configured repos, nested package roots, and unlisted repos', async () => {
  const base = await mkdtemp(join(tmpdir(), 'supply-discovery-'));
  try {
    const existing = join(base, 'existing'), child = join(existing, 'apps', 'web'), fresh = join(base, 'new-repo');
    await mkdir(join(existing, '.git'), { recursive: true });
    await mkdir(child, { recursive: true });
    await mkdir(join(fresh, '.git'), { recursive: true });
    await mkdir(join(fresh, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(child, 'package.json'), '{}');
    await writeFile(join(child, 'package-lock.json'), '{}');
    await writeFile(join(fresh, 'package.json'), '{}');
    await writeFile(join(fresh, 'node_modules', 'ignored', 'package.json'), '{}');
    const report = await discover({ searchRoots: [base], projects: [{ id: 'existing', root: existing }], maxDepth: 3 });
    assert.equal(report.candidates.find(item => item.path === existing)?.status, 'configured');
    assert.equal(report.candidates.find(item => item.path === child)?.status, 'nested-unscanned');
    assert.equal(report.candidates.find(item => item.path === fresh)?.status, 'unlisted');
    assert.ok(!report.candidates.some(item => item.path.includes('node_modules')));
    const { config, added } = adoptDiscovery({ projects: [{ id: 'existing', label: 'Existing', root: existing }] }, report, { nestedLocks: true });
    assert.equal(added.length, 2);
    assert.ok(config.projects.some(project => project.root === child && project.label === 'Existing · web'));
    assert.ok(config.projects.some(project => project.root === fresh));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('root edits preserve existing project identity and reject relative paths', () => {
  const config = { projects: [{ id: 'app', label: 'App', root: null }] };
  assert.throws(() => upsertRoot(config, { id: 'app', root: 'relative/path' }), /absolute/);
  assert.throws(() => upsertRoot(config, { id: 'app', root: parse(tmpdir()).root }), /narrower/);
  const next = upsertRoot(config, { id: 'app', root: join(tmpdir(), 'app') });
  assert.equal(next.projects.length, 1);
  assert.equal(next.projects[0].label, 'App');
  assert.equal(config.projects[0].root, null);
});

test('discovery refuses an entire drive and reports a bounded traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'supply-bounds-'));
  try {
    await assert.rejects(discover({ searchRoots: [parse(base).root] }), /narrower project parent/);
    await mkdir(join(base, 'first'));
    await mkdir(join(base, 'second'));
    const report = await discover({ searchRoots: [base], maxDirectories: 1 });
    assert.equal(report.truncated, true);
    assert.equal(report.incomplete, true);
    assert.deepEqual(report.unreadableDirectories, []);
    assert.equal(report.directoriesVisited, 1);
    await assert.rejects(discover({ searchRoots: [base], maxDirectories: 0 }), /Directory limit/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('CLI initializes a private config and emits discovery JSON to stdout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'supply-cli-'));
  try {
    const config = join(base, 'portfolio.json');
    const init = spawnSync(process.execPath, [cli, 'init', '--out', config], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { schemaVersion: 1, projects: [] });
    const repeat = spawnSync(process.execPath, [cli, 'init', '--out', config], { encoding: 'utf8' });
    assert.equal(repeat.status, 1);
    assert.match(repeat.stderr, /already exists/);
    const broadConfig = join(base, 'broad.json');
    await writeFile(broadConfig, JSON.stringify({ projects: [{ id: 'broad', root: parse(base).root }] }));
    const broadScan = spawnSync(process.execPath, [cli, 'scan', '--config', broadConfig, '--out', join(base, 'broad-snapshot.json')], { encoding: 'utf8' });
    assert.equal(broadScan.status, 1);
    assert.match(broadScan.stderr, /narrower than a filesystem or drive root/);
    await mkdir(join(base, 'app'));
    await writeFile(join(base, 'app', 'package.json'), '{}');
    const result = spawnSync(process.execPath, [cli, 'discover', '--config', config, '--search-root', base, '--depth', '1', '--out', '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.candidates.some(candidate => candidate.path === join(base, 'app')));
    assert.match(result.stderr, /Discovered/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
