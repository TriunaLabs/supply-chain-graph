import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.style = {}; this.clientWidth = tag === 'graph-stage' ? 900 : 0; this.clientHeight = tag === 'graph-stage' ? 500 : 0; this.scrollLeft = 0; this.scrollTop = 0; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}
async function executeDashboard(snapshot, globals = {}) {
  const elements = new Map();
  const document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
    createElement: tag => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: text => ({ textContent: text })
  };
  const source = await readFile(resolve(base, 'assets/dashboard.js'), 'utf8');
  vm.runInNewContext(`const snapshot = ${JSON.stringify(snapshot)};\n${source}`, { document, console, ...globals });
  return elements;
}
const minimal = () => ({ generatedAt: '2026-10-31T00:00:00Z', findings: [], coverage: [], enrichment: { packages: {} }, nodes: [{ id: 'project:app', kind: 'project', label: 'App', projectId: 'app', rootPath: '/portfolio/app' }], edges: [] });

test('Add project folder opens the root form; the local picker fills it and waits for Add and scan', async () => {
  const staticElements = await executeDashboard(minimal());
  staticElements.get('add-project').listeners.click();
  assert.ok(staticElements.get('inspector').children.some(item => item.tag === 'code' && item.textContent.includes('serve --config')));
  assert.ok(!staticElements.get('inspector').children.some(item => item.className === 'root-form'));
  assert.ok(staticElements.get('inspector').children.some(item => item.tag === 'p' && /Choose project folder opens a folder dialog on your machine/.test(item.textContent)));

  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, token: init.headers?.['x-supply-chain-token'] });
    if (url === '/api/triage') return { ok: true, status: 200, json: async () => ({ items: {} }) };
    if (url === '/api/pick-folder') return { ok: true, status: 200, json: async () => ({ path: 'C:\\portfolio\\chosen-app', suggestedId: 'chosen-app', suggestedLabel: 'chosen-app' }) };
    throw new Error(`unexpected request ${url}`);
  };
  const elements = await executeDashboard(minimal(), { supplyChainLocal: { token: 'test-token' }, fetch });
  elements.get('add-project').listeners.click();
  const form = elements.get('inspector').children.find(item => item.className === 'root-form');
  assert.ok(form, 'local mode shows the root form');
  const inputs = Object.fromEntries(form.children.filter(item => item.tag === 'label').map(item => [item.children[0].name, item.children[0]]));
  const pick = form.children.find(item => item.tag === 'button' && item.textContent === 'Choose project folder…');
  const submit = form.children.find(item => item.tag === 'button' && item.type === 'submit');
  assert.ok(pick && submit);
  assert.equal(submit.textContent, 'Add and scan');
  assert.equal(inputs.root.value, '');
  await pick.listeners.click();
  assert.equal(inputs.root.value, 'C:\\portfolio\\chosen-app');
  assert.equal(inputs.id.value, 'chosen-app');
  assert.equal(inputs.label.value, 'chosen-app');
  const pickCall = calls.find(call => call.url === '/api/pick-folder');
  assert.equal(pickCall.method, 'POST');
  assert.equal(pickCall.token, 'test-token');
  assert.ok(!calls.some(call => call.url === '/api/set-root'), 'picking a folder saves nothing');
  const status = form.children.find(item => item.tag === 'p' && /Folder chosen/.test(item.textContent));
  assert.match(status.textContent, /click Add and scan to save it and scan/);

  const cancelled = await executeDashboard(minimal(), { supplyChainLocal: { token: 'test-token' }, fetch: async url => ({ ok: true, status: 200, json: async () => url === '/api/pick-folder' ? { cancelled: true } : { items: {} } }) });
  const projectNode = cancelled.get('graph').children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('project: App'));
  projectNode.listeners.click();
  cancelled.get('inspector').children.find(item => item.textContent === 'Set or change root').listeners.click();
  const editForm = cancelled.get('inspector').children.find(item => item.className === 'root-form');
  const editInputs = Object.fromEntries(editForm.children.filter(item => item.tag === 'label').map(item => [item.children[0].name, item.children[0]]));
  assert.equal(editForm.children.find(item => item.tag === 'button' && item.type === 'submit').textContent, 'Save root and rescan');
  await editForm.children.find(item => item.tag === 'button' && item.textContent === 'Choose project folder…').listeners.click();
  assert.equal(editInputs.root.value, '/portfolio/app');
  assert.ok(editForm.children.some(item => item.tag === 'p' && /No folder chosen. The form is unchanged./.test(item.textContent)));
});
test('four supply-chain lenses show distinct relationships, column headings, and working zoom', async () => {
  const sample = {
    generatedAt: new Date().toISOString(), findings: [{ id: 'sample-gap', projectId: 'sample', type: 'coverage', title: 'Source gap', evidence: 'fixture' }], coverage: [{ projectId: 'sample', npm: 'resolved-v3', git: 'not-found' }],
    enrichment: { packages: { 'npm:alpha@1.0.0': { osv: { status: 'checked', checkedAt: '2026-10-30T00:00:00Z', advisories: [{ id: 'OSV-EXAMPLE' }] }, registry: { status: 'checked', checkedAt: '2026-10-30T00:00:00Z', deprecated: 'Use the replacement', latestTag: '2.0.0', newerLatestTag: true } } }, advisories: { 'OSV-EXAMPLE': { status: 'checked', severity: 'CRITICAL', summary: 'Example issue', affected: [{ ecosystem: 'npm', name: 'alpha', fixedBoundaries: ['1.0.1'] }, { ecosystem: 'npm', name: 'alpha', fixedBoundaries: ['2.0.0'] }] } } },
    nodes: [
      { id: 'project:sample', kind: 'project', label: 'Sample', projectId: 'sample', rootPath: 'C:\\example\\sample' },
      { id: 'decl:js:sample:root:runtime:alpha', kind: 'declaration', label: 'alpha ^1.0.0', projectId: 'sample' },
      { id: 'source:sample:src/main.js', kind: 'source-file', label: 'src/main.js', location: 'src/main.js', projectId: 'sample' },
      { id: 'source-package:sample:three', kind: 'source-import', label: 'three', name: 'three', mappedUrl: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', versionHint: '0.160.0', projectId: 'sample' },
      { id: 'occ:sample:alpha', kind: 'occurrence', label: 'alpha@1.0.0', name: 'alpha', version: '1.0.0', projectId: 'sample' },
      { id: 'occ:sample:beta', kind: 'occurrence', label: 'beta@2.0.0', name: 'beta', version: '2.0.0', projectId: 'sample' },
      { id: 'npm:alpha@1.0.0', kind: 'artifact', ecosystem: 'npm', label: 'alpha@1.0.0' },
      { id: 'npm:beta@2.0.0', kind: 'artifact', ecosystem: 'npm', label: 'beta@2.0.0' },
      { id: 'action:actions/checkout@v4', kind: 'action', label: 'actions/checkout@v4', reference: 'v4' },
      { id: 'github:actions/checkout', kind: 'repository', label: 'actions/checkout' }
    ],
    edges: [
      { from: 'project:sample', to: 'decl:js:sample:root:runtime:alpha', kind: 'declares', source: 'package.json' },
      { from: 'project:sample', to: 'source:sample:src/main.js', kind: 'has-source-imports', source: 'src/main.js' },
      { from: 'source:sample:src/main.js', to: 'source-package:sample:three', kind: 'imports-external', scope: 'three', source: 'src/main.js:1' },
      { from: 'decl:js:sample:root:runtime:alpha', to: 'occ:sample:alpha', kind: 'resolved-by', source: 'package-lock.json' },
      { from: 'project:sample', to: 'occ:sample:alpha', kind: 'depends-on', source: 'package.json' },
      { from: 'occ:sample:alpha', to: 'occ:sample:beta', kind: 'depends-on', source: 'package-lock.json' },
      { from: 'occ:sample:alpha', to: 'npm:alpha@1.0.0', kind: 'resolves-to' },
      { from: 'occ:sample:beta', to: 'npm:beta@2.0.0', kind: 'resolves-to' },
      { from: 'project:sample', to: 'action:actions/checkout@v4', kind: 'uses-action', source: 'check.yml' },
      { from: 'action:actions/checkout@v4', to: 'github:actions/checkout', kind: 'sourced-from', source: 'check.yml' }
    ]
  };
  const elements = await executeDashboard(sample);
  const graph = elements.get('graph');
  assert.ok(graph.children.filter(item => item.tag === 'g').length >= 3);
  assert.ok(graph.children.filter(item => item.tag === 'path').length >= 2);
  assert.ok(graph.children.some(item => item.tag === 'text' && item.textContent === 'Transitive dependency'));
  assert.equal(elements.get('signal-advisory-count').textContent, '1');
  assert.equal(elements.get('signal-critical-count').textContent, '1');
  assert.equal(elements.get('signal-deprecated-count').textContent, '1');
  assert.equal(elements.get('signal-outdated-count').textContent, '1');
  assert.equal(elements.get('signal-unknown-count').textContent, '1');
  assert.equal(elements.get('signal-coverage-count').textContent, '1');
  const flagged = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.includes('alpha@1.0.0'));
  assert.ok(flagged.attributes.class.includes('signal-critical'));
  flagged.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'advisory-group' && item.children.some(child => child.className === 'advisory-links')));
  const advisoryList = elements.get('inspector').children.find(item => item.className === 'advisory-group').children.find(item => item.className === 'advisory-links');
  assert.match(advisoryList.children[0].children.find(item => item.tag === 'small').textContent, /1\.0\.1, 2\.0\.0/);
  assert.ok(elements.get('inspector').children.some(item => item.className === 'action-text'));
  elements.get('signal-critical').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes.class.includes('signal-critical')));
  elements.get('signal-advisory').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'path').length >= 1);
  elements.get('signal-unknown').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes['aria-label']?.includes('beta@2.0.0')));
  elements.get('signal-coverage').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes.class.includes('signal-coverage')));
  elements.get('signal-all').listeners.click();
  elements.get('project').value = 'project:sample'; elements.get('project').listeners.change();
  assert.equal(graph.style.width, '100%');
  assert.equal(graph.style.height, '100%');
  assert.equal(elements.get('zoom-level').textContent, 'Fit');
  elements.get('zoom-in').listeners.click();
  assert.ok(parseInt(graph.style.height, 10) > 500);
  elements.get('zoom-out').listeners.click();
  assert.equal(parseInt(graph.style.height, 10), 500);
  elements.get('zoom-fit').listeners.click();
  assert.equal(graph.style.width, '100%');
  assert.equal(graph.style.height, '100%');
  elements.get('js-tab').listeners.click();
  assert.equal(elements.get('js-tab').attributes['aria-selected'], 'true');
  assert.ok(graph.children.some(item => item.tag === 'text' && item.textContent === 'Requested dependency'));
  assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes.class.includes('declaration')));
  elements.get('source-tab').listeners.click();
  assert.equal(elements.get('source-tab').attributes['aria-selected'], 'true');
  assert.ok(graph.children.some(item => item.tag === 'text' && item.textContent === 'Importing source file'));
  const sourceNode = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.includes('source-import: three'));
  assert.ok(sourceNode);
  sourceNode.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'Import map URL · ')));
  elements.get('github-tab').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes.class.includes('repository')));
  elements.get('project').value = 'all'; elements.get('project').listeners.change();
  assert.equal(elements.get('graph-detail').value, 'direct');
  assert.ok(graph.children.filter(item => item.tag === 'path').length >= 1);
  const projectNode = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.includes('project: Sample'));
  projectNode.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'Project root · ')));
  const html = await readFile(resolve(base, 'assets/dashboard.html'), 'utf8');
  assert.ok(html.indexOf('class="graph-zoom"') < html.indexOf('id="graph-stage"'));
  assert.match(html, /preserveAspectRatio="xMidYMid meet"/);
});

test('all-project pages expose every project root and label bounded edges', async () => {
  const nodes = Array.from({ length: 23 }, (_, i) => ({ id: `project:p${i}`, kind: 'project', label: `Project ${String(i).padStart(2, '0')}`, projectId: `p${i}` }));
  const elements = await executeDashboard({ generatedAt: new Date().toISOString(), nodes, edges: [], findings: [], coverage: [], enrichment: { packages: {} } });
  elements.get('project').value = 'all'; elements.get('project').listeners.change();
  assert.match(elements.get('page-label').textContent, /Projects 1–10 of 23 · page 1\/3/);
  assert.equal(elements.get('graph').children.filter(item => item.tag === 'g').length, 10);
  elements.get('page-next').listeners.click();
  assert.match(elements.get('page-label').textContent, /Projects 11–20 of 23 · page 2\/3/);
  elements.get('page-next').listeners.click();
  assert.match(elements.get('page-label').textContent, /Projects 21–23 of 23 · page 3\/3/);
  assert.equal(elements.get('graph').children.filter(item => item.tag === 'g').length, 3);
  assert.match(elements.get('graph-note').textContent, /direct links/);
  elements.get('page-all').listeners.click();
  assert.match(elements.get('page-label').textContent, /All 23 projects · scroll graph/);
  assert.equal(elements.get('graph').children.filter(item => item.tag === 'g').length, 23);
  assert.equal(elements.get('page-prev').hidden, true);
  elements.get('page-all').listeners.click();
  assert.match(elements.get('page-label').textContent, /Projects 1–10 of 23/);
});

test('two sample checkouts show separate roots, branches, and cached critical status', async () => {
  const snapshot = {
    generatedAt: '2026-10-30T20:00:00Z', findings: [], coverage: [],
    enrichment: { packages: {
      'npm:next@16.2.6': { osv: { status: 'checked', advisories: [{ id: 'GHSA-example' }] } },
      'npm:next@16.4.3': { osv: { status: 'checked', advisories: [] } }
    }, advisories: { 'GHSA-example': { status: 'checked', severity: 'CRITICAL' } } },
    nodes: [
      { id: 'project:old', kind: 'project', projectId: 'old', label: 'Sample App', rootPath: '/fixtures/checkout-old' },
      { id: 'project:new', kind: 'project', projectId: 'new', label: 'Sample App (new checkout)', rootPath: '/fixtures/checkout-new' },
      { id: 'checkout:old', kind: 'checkout', projectId: 'old', label: 'legacy', branch: 'legacy', origin: 'example/sample-app' },
      { id: 'checkout:new', kind: 'checkout', projectId: 'new', label: 'main', branch: 'main', origin: 'example/sample-app' },
      { id: 'occ:old:next', kind: 'occurrence', projectId: 'old', label: 'next@16.2.6', name: 'next', version: '16.2.6' },
      { id: 'occ:new:next', kind: 'occurrence', projectId: 'new', label: 'next@16.4.3', name: 'next', version: '16.4.3' },
      { id: 'npm:next@16.2.6', kind: 'artifact', ecosystem: 'npm', label: 'next@16.2.6' },
      { id: 'npm:next@16.4.3', kind: 'artifact', ecosystem: 'npm', label: 'next@16.4.3' }
    ],
    edges: [
      { from: 'project:old', to: 'occ:old:next', kind: 'depends-on' },
      { from: 'project:new', to: 'occ:new:next', kind: 'depends-on' },
      { from: 'occ:old:next', to: 'npm:next@16.2.6', kind: 'resolves-to' },
      { from: 'occ:new:next', to: 'npm:next@16.4.3', kind: 'resolves-to' }
    ]
  };
  const elements = await executeDashboard(snapshot);
  const options = elements.get('project').children;
  assert.match(options.find(option => option.value === 'project:old').textContent, /Sample App · legacy · checkout-old/);
  assert.match(options.find(option => option.value === 'project:new').textContent, /Sample App \(new checkout\) · main · checkout-new/);
  elements.get('project').value = 'project:old'; elements.get('project').listeners.change();
  assert.match(elements.get('scope-context').textContent, /\/fixtures\/checkout-old · 1 critical package version/);
  assert.match(elements.get('scope-context').textContent, /Same remote also scanned as Sample App \(new checkout\) \(main\)/);
  const oldRoot = elements.get('graph').children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('project: Sample App;'));
  assert.ok(oldRoot.attributes.class.includes('signal-critical'));
  oldRoot.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'next@16.2.6')));
  elements.get('project').value = 'project:new'; elements.get('project').listeners.change();
  assert.match(elements.get('scope-context').textContent, /\/fixtures\/checkout-new · 0 critical package versions/);
  const newRoot = elements.get('graph').children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('project: Sample App (new checkout)'));
  assert.ok(!newRoot.attributes.class.includes('signal-critical'));
});

test('complete direct view shows each project’s own links and background clears selection', async () => {
  const nodes = ['a', 'b', 'c'].map(id => ({ id: `project:${id}`, kind: 'project', label: id.toUpperCase(), projectId: id }));
  const edges = [];
  for (const [projectId, count] of [['a', 25], ['b', 2], ['c', 3]]) {
    for (let i = 0; i < count; i++) {
      const id = `occ:${projectId}:${i}`;
      nodes.push({ id, kind: 'occurrence', label: `${projectId}-package-${i}@1.0.0`, projectId });
      edges.push({ from: `project:${projectId}`, to: id, kind: 'depends-on', source: 'package-lock.json' });
    }
  }
  const elements = await executeDashboard({ generatedAt: new Date().toISOString(), nodes, edges, findings: [], coverage: [], enrichment: { packages: {} } });
  elements.get('project').value = 'all'; elements.get('project').listeners.change();
  const graph = elements.get('graph');
  assert.equal(graph.children.filter(item => item.tag === 'path').length, 30);
  assert.equal(graph.children.filter(item => item.tag === 'g' && item.attributes.class.includes('project')).length, 3);
  assert.ok(graph.children.some(item => item.tag === 'text' && item.textContent === 'B · 2 direct links'));
  assert.ok(Number(graph.attributes.viewBox.split(' ')[3]) > 650);
  for (const id of ['A', 'B', 'C']) assert.ok(graph.children.some(item => item.tag === 'path' && item.attributes['aria-label']?.startsWith(`${id} to `)));
  const node = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('project: B'));
  node.listeners.click();
  assert.ok(graph.children.some(item => item.tag === 'g' && item.attributes.class.includes('selected')));
  elements.get('graph-stage').listeners.click({ target: { closest: () => null } });
  assert.ok(!graph.children.some(item => item.tag === 'g' && item.attributes.class.includes('selected')));
  assert.ok(elements.get('inspector').children.some(item => item.tag === 'p' && item.textContent.includes('every direct')));
  elements.get('graph-detail').value = 'paths'; elements.get('graph-detail').listeners.change();
  assert.match(elements.get('graph-note').textContent, /bounded path view/);
  assert.ok(graph.children.some(item => item.tag === 'path' && item.attributes['aria-label']?.startsWith('B to ')));
});

test('relationship index pages through edges beyond the drawn graph sample', async () => {
  const nodes = [{ id: 'project:p', kind: 'project', label: 'P', projectId: 'p' }, ...Array.from({ length: 120 }, (_, i) => ({ id: `occ:p:${i}`, kind: 'occurrence', label: `package-${i}@1.0.0`, projectId: 'p' }))];
  const edges = nodes.slice(1).map(node => ({ from: 'project:p', to: node.id, kind: 'depends-on', source: 'package-lock.json' }));
  const elements = await executeDashboard({ generatedAt: new Date().toISOString(), nodes, edges, findings: [], coverage: [], enrichment: { packages: {} } });
  assert.match(elements.get('edge-index-note').textContent, /120 matching of 120 recorded edges/);
  assert.equal(elements.get('edges-table').children.length, 100);
  elements.get('edge-next').listeners.click();
  assert.equal(elements.get('edges-table').children.length, 20);
  assert.match(elements.get('edge-page-label').textContent, /Page 2 of 2/);
  elements.get('edges-table').children[0].children[4].children[0].listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'entity-type' && item.textContent === 'Relationship'));
});

test('non-npm packages, empty source coverage, and nested checkouts are labeled instead of looking clean', async () => {
  const snapshot = {
    generatedAt: '2026-10-31T00:00:00Z', findings: [], enrichment: { packages: {} },
    coverage: [{ projectId: 'app', npm: 'resolved-v3', source: 'not-found', git: 'cached-upstream', actions: 'not-found', python: '1 requirements', sourceFiles: 0, sourceImports: 0 }],
    nodes: [
      { id: 'project:app', kind: 'project', label: 'App', projectId: 'app', rootPath: '/repo/examples/app' },
      { id: 'checkout:app', kind: 'checkout', label: 'main', projectId: 'app', branch: 'main', origin: 'example/repo', commit: 'abc', repoRoot: '/repo', rootIsRepoSubdirectory: true },
      { id: 'github:example/repo', kind: 'repository', label: 'example/repo' },
      { id: 'occ:app:node_modules/alpha', kind: 'occurrence', label: 'alpha@1.0.0', name: 'alpha', version: '1.0.0', projectId: 'app' },
      { id: 'npm:alpha@1.0.0', kind: 'artifact', ecosystem: 'npm', label: 'alpha@1.0.0', name: 'alpha', version: '1.0.0' },
      { id: 'pypi:requests@2.32.0', kind: 'artifact', ecosystem: 'PyPI', label: 'requests@2.32.0', name: 'requests', version: '2.32.0', projectId: 'app' }
    ],
    edges: [
      { from: 'project:app', to: 'occ:app:node_modules/alpha', kind: 'depends-on', source: 'package.json + package-lock.json' },
      { from: 'occ:app:node_modules/alpha', to: 'npm:alpha@1.0.0', kind: 'resolves-to', source: 'package-lock.json' },
      { from: 'project:app', to: 'pypi:requests@2.32.0', kind: 'depends-on', source: 'requirements.txt' },
      { from: 'project:app', to: 'checkout:app', kind: 'checked-out-at', source: 'local-git' },
      { from: 'checkout:app', to: 'github:example/repo', kind: 'tracks', source: 'local-git' }
    ]
  };
  const elements = await executeDashboard(snapshot);
  const graph = elements.get('graph');
  assert.equal(elements.get('signal-unknown-count').textContent, '2');
  assert.match(elements.get('signal-note').textContent, /1 PyPI package versions have no advisory lookup/);
  const python = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('artifact: requests@2.32.0 · PyPI'));
  assert.ok(python, 'PyPI artifact is labeled with its ecosystem');
  assert.match(python.attributes['aria-label'], /unknown/);
  assert.ok(python.attributes.class.includes('signal-unknown'));
  python.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'OSV advisory lookup · ')));
  assert.ok(elements.get('inspector').children.some(item => item.className === 'action-text'));
  elements.get('signal-unknown').listeners.click();
  assert.ok(graph.children.some(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('artifact: requests@2.32.0 · PyPI')));
  elements.get('signal-all').listeners.click();
  elements.get('project').value = 'project:app'; elements.get('project').listeners.change();
  assert.match(elements.get('scope-context').textContent, /enclosing repository; project folder is a subdirectory/);
  elements.get('source-tab').listeners.click();
  assert.equal(graph.children.filter(item => item.tag === 'path').length, 0);
  assert.ok(elements.get('inspector').children.some(item => item.tag === 'p' && /No JavaScript or TypeScript source files were found under this root \(source coverage: Not found · 0 files\)/.test(item.textContent)));
  assert.match(elements.get('graph-note').textContent, /no source files found \(coverage, not a clean check\)/);
  elements.get('graph-detail').value = 'direct'; elements.get('graph-detail').listeners.change();
  assert.ok(elements.get('inspector').children.some(item => item.tag === 'p' && item.textContent.startsWith('No JavaScript or TypeScript source files')));
  elements.get('github-tab').listeners.click();
  const checkout = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('checkout: main'));
  checkout.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'Repository root · ')));
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'Project folder · ') && item.children.some(child => /enclosing repository/.test(child.textContent))));
  const project = graph.children.find(item => item.tag === 'g' && item.attributes['aria-label']?.startsWith('project: App'));
  project.listeners.click();
  assert.ok(elements.get('inspector').children.some(item => item.className === 'detail-row' && item.children.some(child => child.textContent === 'Git metadata source · ')));
});

if (process.env.SUPPLY_CHAIN_SNAPSHOT) test('large portfolio opens with a bounded, connected network', async () => {
  const data = JSON.parse(await readFile(process.env.SUPPLY_CHAIN_SNAPSHOT, 'utf8'));
  const elements = await executeDashboard(data);
  const graph = elements.get('graph');
  const nodeCount = graph.children.filter(item => item.tag === 'g').length;
  const edgeCount = graph.children.filter(item => item.tag === 'path').length;
  assert.ok(nodeCount >= 3 && nodeCount <= 50, `unexpected initial node count ${nodeCount}`);
  assert.ok(edgeCount >= 2, `unexpected initial edge count ${edgeCount}`);
  const flaggedDeprecations = data.nodes.filter(node => {
    if (node.kind !== 'artifact' || node.ecosystem !== 'npm') return false;
    const registry = data.enrichment?.packages?.[node.id]?.registry;
    return registry?.status === 'checked' ? !!registry.deprecated : !!node.localDeprecation;
  }).length;
  if (flaggedDeprecations) {
    assert.equal(Number(elements.get('signal-deprecated-count').textContent), flaggedDeprecations);
    elements.get('signal-deprecated').listeners.click();
    assert.ok(graph.children.filter(item => item.tag === 'g').some(item => item.attributes.class.includes('signal-deprecated')));
    elements.get('signal-all').listeners.click();
  }
  assert.match(await readFile(resolve(base, 'assets/dashboard.html'), 'utf8'), /viewBox="0 0 1100 650"/);
  elements.get('github-tab').listeners.click();
  assert.ok(graph.children.filter(item => item.tag === 'path').length >= 1);
});
