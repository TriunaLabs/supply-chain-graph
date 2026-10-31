const $ = id => document.getElementById(id);
const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
const projects = snapshot.nodes.filter(node => node.kind === 'project');
const occurrences = snapshot.nodes.filter(node => node.kind === 'occurrence');
const npmArtifacts = snapshot.nodes.filter(node => node.kind === 'artifact' && node.ecosystem === 'npm');
const otherArtifacts = snapshot.nodes.filter(node => node.kind === 'artifact' && node.ecosystem && node.ecosystem !== 'npm');
const displayLabel = node => node?.kind === 'artifact' && node.ecosystem && node.ecosystem !== 'npm' ? `${node.label} · ${node.ecosystem}` : node?.label || '';
const artifactOf = new Map(snapshot.edges.filter(edge => edge.kind === 'resolves-to').map(edge => [edge.from, edge.to]));
const packageChecks = snapshot.enrichment?.packages || {};
const advisoryDetails = snapshot.enrichment?.advisories || {};
const checkoutByProject = new Map(snapshot.nodes.filter(node => node.kind === 'checkout').map(node => [node.projectId, node]));
const projectsByOrigin = new Map();
for (const project of projects) {
  const origin = checkoutByProject.get(project.projectId)?.origin;
  if (!origin || origin === 'other-remote') continue;
  if (!projectsByOrigin.has(origin)) projectsByOrigin.set(origin, []);
  projectsByOrigin.get(origin).push(project);
}
const projectCriticalPackages = new Map();
for (const occurrence of occurrences) {
  const checks = packageChecks[artifactOf.get(occurrence.id)];
  if (checks?.osv?.status !== 'checked' || !(checks.osv.advisories || []).some(item => advisoryDetails[item.id]?.status === 'checked' && advisoryDetails[item.id].severity === 'CRITICAL')) continue;
  if (!projectCriticalPackages.has(occurrence.projectId)) projectCriticalPackages.set(occurrence.projectId, new Set());
  projectCriticalPackages.get(occurrence.projectId).add(`${occurrence.name}@${occurrence.version}`);
}
const localService = globalThis.supplyChainLocal || null;
let triageItems = {};
$('panel-mode').textContent = localService ? 'Local editing mode · advisory lookups stay manual' : 'Read-only local snapshot';
const projectsWithFindings = new Set(snapshot.findings.map(finding => finding.projectId));
const relationKinds = new Set(['depends-on', 'declares', 'resolved-by', 'contains-workspace', 'uses-action', 'checked-out-at', 'tracks', 'sourced-from', 'submodule', 'has-source-imports', 'imports-local', 'imports-external', 'imports-unresolved']);
const relations = snapshot.edges.filter(edge => relationKinds.has(edge.kind) && byId.has(edge.from) && byId.has(edge.to));
const outgoing = new Map();
for (const edge of relations) {
  if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
  outgoing.get(edge.from).push(edge);
}
const edgePriority = edge => ({ 'declares': 0, 'has-source-imports': 0, 'resolved-by': 1, 'imports-external': 1, 'imports-local': 2, 'imports-unresolved': 3, 'depends-on': 4, 'contains-workspace': 5, 'checked-out-at': 6, 'uses-action': 7, 'tracks': 8, 'sourced-from': 9, 'submodule': 10 })[edge.kind] ?? 11;
for (const edges of outgoing.values()) edges.sort((a, b) => edgePriority(a) - edgePriority(b) || (byId.get(a.to)?.label || '').localeCompare(byId.get(b.to)?.label || ''));

let mode = 'npm';
let selectedId = null;
let selectedEdge = null;
let currentView = null;
let zoom = 1;
let fitZoom = true;
let signalFilter = 'all';
let graphDetail = 'paths';
let showAllProjects = false;
let projectPage = 0;
const projectsPerPage = 10;
let edgePage = 0;
const edgesPerPage = 100;
const projectSelect = $('project');
const allOption = document.createElement('option'); allOption.value = 'all'; allOption.textContent = 'All projects'; projectSelect.append(allOption);
for (const project of projects) {
  const option = document.createElement('option');
  option.value = project.id;
  const checkout = checkoutByProject.get(project.projectId);
  const sameOrigin = projectsByOrigin.get(checkout?.origin) || [];
  option.textContent = sameOrigin.length > 1 ? `${project.label} · ${checkout.branch || 'detached'} · ${project.rootPath?.split(/[\\/]/).at(-1) || 'root unknown'}` : project.label;
  option.title = [project.rootPath, checkout?.origin].filter(Boolean).join(' · ');
  projectSelect.append(option);
}
projectSelect.value = projects.find(project => (outgoing.get(project.id) || []).some(edge => byId.get(edge.to)?.kind === 'occurrence'))?.id || projects[0]?.id || '';
$('stamp').textContent = 'Snapshot · ' + new Date(snapshot.generatedAt).toLocaleString();
const metricValues = [
  [projects.length, 'portfolio entries'],
  [occurrences.length, 'resolved occurrences'],
  [snapshot.nodes.filter(node => node.kind === 'artifact').length, 'package versions'],
  [snapshot.edges.length, 'recorded edges']
];
for (const [value, label] of metricValues) {
  const box = document.createElement('div'); box.className = 'metric';
  const number = document.createElement('strong'); number.textContent = value.toLocaleString();
  const text = document.createElement('span'); text.textContent = label;
  box.append(number, text); $('metrics').append(box);
}

function checksFor(node) {
  const id = node?.kind === 'occurrence' ? artifactOf.get(node.id) : node?.kind === 'artifact' ? node.id : null;
  return id ? packageChecks[id] || {} : {};
}
function localDeprecationFor(node) {
  return node?.localDeprecation || null;
}
function signalFlags(node) {
  const checks = checksFor(node);
  return {
    critical: node?.kind === 'project' ? (projectCriticalPackages.get(node.projectId)?.size || 0) > 0 : checks.osv?.status === 'checked' && (checks.osv.advisories || []).some(item => advisoryDetails[item.id]?.status === 'checked' && advisoryDetails[item.id].severity === 'CRITICAL'),
    advisory: checks.osv?.status === 'checked' && (checks.osv.advisories?.length || 0) > 0,
    deprecated: checks.registry?.status === 'checked' ? !!checks.registry.deprecated : !!localDeprecationFor(node),
    outdated: checks.registry?.status === 'checked' && checks.registry.newerLatestTag === true,
    unknown: (node?.kind === 'occurrence' || node?.kind === 'artifact') && checks.osv?.status !== 'checked',
    coverage: node?.kind === 'project' && projectsWithFindings.has(node.projectId)
  };
}
function matchesSignal(node) { return signalFilter === 'all' || (node?.kind !== 'project' || signalFilter === 'coverage') && !!signalFlags(node)[signalFilter]; }
function visibleArtifacts() {
  if (projectSelect.value === 'all') return npmArtifacts;
  const selected = projectSelect.value.slice(8);
  const ids = new Set(occurrences.filter(node => node.projectId === selected).map(node => artifactOf.get(node.id)));
  return npmArtifacts.filter(node => ids.has(node.id));
}
function renderSignalBar() {
  const artifacts = npmArtifacts, counts = { critical: 0, advisory: 0, deprecated: 0, outdated: 0, unknown: 0 };
  let osvChecked = 0, registryChecked = 0, failed = 0, localDeprecated = 0;
  for (const artifact of artifacts) {
    const flags = signalFlags(artifact), checks = checksFor(artifact);
    for (const key of Object.keys(counts)) if (flags[key]) counts[key]++;
    if (checks.osv?.status === 'checked') osvChecked++;
    if (checks.registry?.status === 'checked') registryChecked++;
    if (localDeprecationFor(artifact)) localDeprecated++;
    if (checks.osv?.status === 'error' || checks.registry?.status === 'error') failed++;
  }
  counts.unknown += otherArtifacts.length;
  counts.coverage = snapshot.findings.length;
  for (const key of ['critical', 'advisory', 'deprecated', 'outdated', 'unknown', 'coverage']) {
    const checked = key === 'critical' ? Object.keys(advisoryDetails).length : key === 'advisory' ? osvChecked : key === 'deprecated' ? registryChecked + localDeprecated : key === 'outdated' ? registryChecked : 1;
    $(`signal-${key}-count`).textContent = checked ? String(counts[key]) : '—';
  }
  for (const key of ['all', 'critical', 'advisory', 'deprecated', 'outdated', 'unknown', 'coverage']) $(`signal-${key}`).setAttribute('aria-pressed', String(signalFilter === key));
  $('signal-note').textContent = `Portfolio totals · OSV checked ${osvChecked}/${artifacts.length} package versions · npm registry checked ${registryChecked}/${artifacts.length}${localDeprecated ? ` · ${localDeprecated} lockfile deprecation messages (cached)` : ''}${failed ? ` · ${failed} lookups failed` : ''}${otherArtifacts.length ? ` · ${otherArtifacts.length} ${[...new Set(otherArtifacts.map(node => node.ecosystem))].join('/')} package versions have no advisory lookup in this starter` : ''}. Unknown results are not clean results.`;
}

function readableStatus(value) {
  if (value?.startsWith('resolved-v')) return `npm lock v${value.slice(-1)}`;
  return ({ 'pnpm-v9': 'pnpm lock v9', 'manifest-only': 'Manifest only', 'not-found': 'Not found', 'scanned': 'Scanned', 'partial': 'Partial scan', 'nested-unscanned': 'Nested sources unscanned', 'path-not-configured': 'No source path configured', 'path-missing': 'Configured path missing', 'access-denied': 'Access denied', 'unavailable': 'Source unavailable', 'not-scanned': 'Not scanned', 'local-head-only': 'Local HEAD', 'cached-upstream': 'Cached upstream' })[value] || value || '—';
}
function tableRow(target, cells) {
  const row = document.createElement('tr');
  for (const cell of cells) { const td = document.createElement('td'); td.textContent = cell ?? '—'; row.append(td); }
  target.append(row);
}
function renderCoverage() {
  const body = $('coverage'); body.replaceChildren();
  for (const record of snapshot.coverage) tableRow(body, [byId.get(`project:${record.projectId}`)?.label || record.projectId, record.npm === 'not-found' ? 'No root manifest' : readableStatus(record.npm), record.sourceFiles != null ? `${readableStatus(record.source)} · ${record.sourceFiles} files · ${record.sourceImports} imports` : 'Not scanned', readableStatus(record.git), readableStatus(record.actions), readableStatus(record.python)]);
}
function renderInventory() {
  const body = $('inventory'); body.replaceChildren();
  const selected = projectSelect.value === 'all' ? null : projectSelect.value.slice(8), query = $('search').value.trim().toLowerCase();
  const matching = occurrences.filter(node => (!selected || node.projectId === selected) && (!query || node.label.toLowerCase().includes(query)) && (signalFilter === 'all' || signalFilter === 'coverage' || matchesSignal(node)));
  for (const node of matching.slice(0, 80)) {
    const checks = checksFor(node);
    const advisory = checks.osv?.status === 'checked' ? `${checks.osv.advisories?.length || 0} returned by OSV` : checks.osv?.status === 'error' ? 'Lookup failed' : checks.osv?.status === 'unavailable' ? 'Source not verifiable by name/version' : 'Not checked';
    const registry = checks.registry?.status === 'checked' ? [checks.registry.deprecated ? 'Deprecated' : null, checks.registry.newerLatestTag ? `Newer latest: ${checks.registry.latestTag}` : null].filter(Boolean).join(' · ') || 'Checked; no flag' : localDeprecationFor(node) ? 'Lockfile: deprecated (cached)' : checks.registry?.status === 'error' ? 'Lookup failed' : checks.registry?.status === 'unavailable' ? 'Public metadata unavailable' : 'Not checked';
    tableRow(body, [node.name, node.version, advisory, registry]);
  }
  $('inventory-note').textContent = `Showing ${Math.min(80, matching.length)} of ${matching.length} occurrences for ${byId.get(projectSelect.value)?.label || 'all projects'}`;
}
function detail(label, value) {
  if (value == null || value === '') return null;
  const row = document.createElement('div'); row.className = 'detail-row';
  const heading = document.createElement('b'); heading.textContent = label + ' · ';
  row.append(heading, document.createTextNode(String(value)));
  return row;
}
function actionText(title, value) {
  const row = document.createElement('div'); row.className = 'action-text';
  const strong = document.createElement('strong'); strong.textContent = title;
  const text = document.createElement('p'); text.textContent = value;
  row.append(strong, text); return row;
}
function appendTriage(panel, key) {
  if (!localService) return;
  const prior = triageItems[key] || { status: 'open', note: '' };
  const heading = document.createElement('h3'); heading.className = 'next-step-heading'; heading.textContent = 'Track this action'; panel.append(heading);
  const form = document.createElement('form'); form.className = 'triage-form';
  const statusLabel = document.createElement('label'); statusLabel.textContent = 'Status';
  const statusInput = document.createElement('select');
  for (const [value, text] of [['open', 'Open'], ['investigating', 'Investigating'], ['acknowledged', 'Acknowledged']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; statusInput.append(option);
  }
  statusInput.value = prior.status; statusLabel.append(statusInput); form.append(statusLabel);
  const noteLabel = document.createElement('label'); noteLabel.textContent = 'Owner note';
  const noteInput = document.createElement('textarea'); noteInput.value = prior.note; noteInput.maxLength = 1000; noteLabel.append(noteInput); form.append(noteLabel);
  const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Save action status'; form.append(button);
  const message = document.createElement('p'); message.setAttribute('role', 'status'); form.append(message);
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true; message.textContent = 'Saving…';
    try {
      const response = await fetch('/api/triage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': localService.token }, body: JSON.stringify({ key, status: statusInput.value, note: noteInput.value }) });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || 'Action save failed');
      triageItems[key] = saved; message.textContent = `Saved ${new Date(saved.updatedAt).toLocaleString()}`;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  panel.append(form);
}
function rootEditor({ id = '', label = '', root = '' } = {}) {
  const panel = $('inspector'); panel.replaceChildren();
  const title = document.createElement('div'); title.className = 'entity-name'; title.textContent = 'Set a source root'; panel.append(title);
  const note = document.createElement('p'); note.textContent = localService ? 'This saves the private portfolio config and rescans local sources. Advisory lookups are not run automatically.' : 'This saved HTML is read-only. Start the local editing server from the skill to save roots, then open its localhost URL. In that mode, Choose project folder opens a folder dialog on your machine and fills this form; nothing is saved until you click Add and scan.'; panel.append(note);
  if (!localService) {
    const code = document.createElement('code'); code.textContent = 'node scripts/supply-chain.mjs serve --config PRIVATE_CONFIG --snapshot PRIVATE_SNAPSHOT --out PRIVATE_DASHBOARD'; panel.append(code);
    return;
  }
  const isNew = !id;
  const form = document.createElement('form'); form.className = 'root-form';
  const fields = [['Project ID', id, 'id'], ['Display name', label, 'label'], ['Absolute root directory', root, 'root']];
  const inputs = {};
  for (const [caption, value, key] of fields) {
    const wrapper = document.createElement('label'); wrapper.textContent = caption;
    const input = document.createElement('input'); input.value = value; input.required = key !== 'label'; input.name = key; wrapper.append(input); form.append(wrapper); inputs[key] = input;
  }
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = isNew ? 'Add and scan' : 'Save root and rescan';
  const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'action-button'; pick.textContent = 'Choose project folder…';
  const pickStatus = document.createElement('p'); pickStatus.setAttribute('role', 'status'); pickStatus.textContent = `Opens a folder dialog on this machine and fills the path above. Nothing is saved until you click ${submit.textContent}.`;
  pick.addEventListener('click', async () => {
    pick.disabled = true; pickStatus.textContent = 'Waiting for the folder dialog on this machine…';
    try {
      const response = await fetch('/api/pick-folder', { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': localService.token }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The folder dialog failed');
      if (result.cancelled) { pickStatus.textContent = 'No folder chosen. The form is unchanged.'; return; }
      inputs.root.value = result.path;
      if (!inputs.id.value.trim()) inputs.id.value = result.suggestedId || '';
      if (!inputs.label.value.trim()) inputs.label.value = result.suggestedLabel || '';
      pickStatus.textContent = `Folder chosen: ${result.path}. Review the ID and name, then click ${submit.textContent} to save it and scan.`;
    } catch (error) { pickStatus.textContent = error.message; }
    finally { pick.disabled = false; }
  });
  form.append(pick, pickStatus, submit);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); form.append(status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; status.textContent = 'Scanning local files…';
    try {
      const response = await fetch('/api/set-root', { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': localService.token }, body: JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]))) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Root update failed');
      status.textContent = 'Saved and scanned. Reloading…'; location.reload();
    } catch (error) { status.textContent = error.message; submit.disabled = false; }
  });
  panel.append(form);
}
function inspectCandidate(candidate) {
  const parent = candidate.projectId ? byId.get(`project:${candidate.projectId}`)?.label : candidate.parentRepo?.split(/[\\/]/).at(-1);
  rootEditor({ id: candidate.suggestedId, label: parent ? `${parent} · ${candidate.label}` : candidate.label, root: candidate.path });
}
function appendFolderAction(panel, node) {
  const project = node.projectId && byId.get(`project:${node.projectId}`);
  if (!project?.rootPath) return;
  panel.append(detail('Project root', project.rootPath));
  if (node.kind === 'source-file' && node.location) {
    const separator = project.rootPath.includes('\\') ? '\\' : '/';
    panel.append(detail('Full source path', project.rootPath + separator + node.location.replaceAll('/', separator)));
  }
  if (node.kind === 'occurrence' && /^node_modules\//.test(node.location || '')) {
    const separator = project.rootPath.includes('\\') ? '\\' : '/';
    panel.append(detail('Install folder, if present', project.rootPath + separator + node.location.replaceAll('/', separator)));
  }
  if (!localService) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'action-button'; button.textContent = 'Open folder in Explorer';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true; message.textContent = 'Opening folder…';
    try {
      const response = await fetch('/api/open-folder', { method: 'POST', headers: { 'content-type': 'application/json', 'x-supply-chain-token': localService.token }, body: JSON.stringify({ nodeId: node.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not open folder');
      message.textContent = `Opened ${result.opened}`;
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  panel.append(button, message);
}
function inspectNode(node) {
  const panel = $('inspector'); panel.replaceChildren();
  const type = document.createElement('div'); type.className = 'entity-type'; type.textContent = node.kind;
  const name = document.createElement('div'); name.className = 'entity-name'; name.textContent = node.label;
  panel.append(type, name);
  for (const item of [detail('Project', node.projectId && byId.get(`project:${node.projectId}`)?.label), detail('Local source status', node.sourceStatus), detail('Ecosystem', node.ecosystem), detail('Version', node.version), detail('URL version hint', node.versionHint), detail('Requested', node.requested), detail('Source file', node.kind === 'source-file' ? node.location : null), detail('Install path', node.kind !== 'source-file' ? node.location : null), detail('Source type', node.sourceKind), detail('Import map URL', node.mappedUrl), detail('Reference', node.reference), detail('Pinned commit', node.pinned == null ? null : node.pinned ? 'Yes' : 'No'), detail('Local commit', node.commit), detail('Branch', node.branch), detail('Origin', node.origin), detail('Repository root', node.repoRoot), detail('Project folder', node.rootIsRepoSubdirectory ? 'Subdirectory of this checkout; the Git metadata belongs to the enclosing repository' : node.repoRoot ? 'Repository root' : null), detail('Cached upstream ref', node.upstream), detail('Upstream check', node.upstreamIsCached ? 'Cached local ref; live GitHub not queried' : null), detail('Ahead of cached upstream', node.ahead), detail('Behind cached upstream', node.behind)]) if (item) panel.append(item);
  appendFolderAction(panel, node);
  if ((node.kind === 'artifact' || node.kind === 'declaration') && node.ecosystem && node.ecosystem !== 'npm' && node.ecosystem !== 'JavaScript') {
    panel.append(detail('OSV advisory lookup', `Not checked · this starter queries npm packages only; ${node.ecosystem} lookups are not implemented`));
    const heading = document.createElement('h3'); heading.className = 'next-step-heading'; heading.textContent = 'Suggested next step'; panel.append(heading);
    panel.append(actionText('Complete the check', `Advisory coverage is unknown for this ${node.ecosystem} package. Check it against a ${node.ecosystem} advisory source before treating it as clean.`));
  }
  if (node.kind === 'source-import') panel.append(actionText('Source-only evidence', 'This import was observed in code. A mapped CDN URL is a source hint, not a verified installed package. npm and OSV checks require a confirmed package and version.'));
  if (node.kind === 'project') {
    const count = snapshot.findings.filter(finding => finding.projectId === node.projectId).length;
    panel.append(detail('Coverage findings', count));
    const checkout = checkoutByProject.get(node.projectId);
    const critical = [...(projectCriticalPackages.get(node.projectId) || [])];
    for (const item of [detail('Checkout branch', checkout?.branch), detail('Git origin', checkout?.origin), detail('Git metadata source', checkout?.rootIsRepoSubdirectory ? `Enclosing repository at ${checkout.repoRoot}; this project folder is a subdirectory of it` : null), detail('Critical package versions in cached checks', critical.length), detail('Critical packages', critical.join(', '))]) if (item) panel.append(item);
    const siblings = (projectsByOrigin.get(checkout?.origin) || []).filter(project => project.id !== node.id);
    for (const sibling of siblings) panel.append(detail('Other checkout of this remote', `${sibling.label} · ${checkoutByProject.get(sibling.projectId)?.branch || 'detached'} · ${sibling.rootPath || 'root unknown'}`));
    const button = document.createElement('button'); button.type = 'button'; button.className = 'action-button'; button.textContent = 'Set or change root';
    button.addEventListener('click', () => rootEditor({ id: node.projectId, label: node.label, root: node.rootPath || '' })); panel.append(button);
    if (projectSelect.value === 'all') {
      const focus = document.createElement('button'); focus.type = 'button'; focus.className = 'action-button'; focus.textContent = 'Focus this project';
      focus.addEventListener('click', () => { projectSelect.value = node.id; graphDetail = 'paths'; edgePage = 0; selectedId = node.id; selectedEdge = null; renderAll(); inspectNode(node); }); panel.append(focus);
    }
  }
  if (node.kind === 'occurrence' || node.kind === 'artifact' && node.ecosystem === 'npm') {
    const checks = checksFor(node), osv = checks.osv, registry = checks.registry;
    panel.append(detail('OSV advisory lookup', osv?.status === 'checked' ? `${osv.advisories?.length || 0} advisories returned · ${osv.checkedAt}` : osv?.status === 'error' ? `Failed · ${osv.reason}` : osv?.status === 'unavailable' ? osv.reason : 'Not checked'));
    if (osv?.status === 'checked' && osv.advisories?.length) {
      const group = document.createElement('details'); group.className = 'advisory-group';
      const summary = document.createElement('summary'); summary.textContent = `Review all ${osv.advisories.length} advisory records`; group.append(summary);
      const list = document.createElement('ul'); list.className = 'advisory-links';
      for (const advisory of osv.advisories) {
        const item = document.createElement('li'), link = document.createElement('a');
        link.href = `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = advisory.id;
        item.append(link);
        const record = advisoryDetails[advisory.id];
        if (record?.status === 'checked') {
          const matching = (record.affected || []).filter(entry => entry.ecosystem === 'npm' && entry.name?.toLowerCase() === node.name?.toLowerCase());
          const fixed = [...new Set(matching.flatMap(entry => entry.fixedBoundaries || []))];
          const pieces = [record.severity || matching.find(entry => entry.severity)?.severity || 'Severity not supplied', record.summary, fixed.length ? `OSV fixed boundaries: ${fixed.join(', ')}` : 'No fixed boundary listed'].filter(Boolean);
          const meta = document.createElement('small'); meta.textContent = pieces.join(' · '); item.append(meta);
        } else if (record?.status === 'error') {
          const meta = document.createElement('small'); meta.textContent = 'Detail lookup failed; open the source record'; item.append(meta);
        }
        list.append(item);
      }
      group.append(list); panel.append(group);
    }
    panel.append(detail('npm registry lookup', registry?.status === 'checked' ? `Checked · ${registry.checkedAt}` : registry?.status === 'error' ? `Failed · ${registry.reason}` : registry?.status === 'unavailable' ? registry.reason : 'Not checked'));
    if (localDeprecationFor(node)) panel.append(detail('Cached lockfile deprecation', localDeprecationFor(node)));
    if (registry?.status === 'checked') {
      for (const item of [detail('Deprecation message', registry.deprecated || 'None for this version'), detail('npm latest tag', registry.latestTag), detail('Newer latest tag', registry.newerLatestTag == null ? 'Unknown for this version format' : registry.newerLatestTag ? 'Yes' : 'No')]) if (item) panel.append(item);
    }
    const flags = signalFlags(node);
    if (flags.advisory || flags.deprecated || flags.outdated || flags.unknown) {
      const heading = document.createElement('h3'); heading.className = 'next-step-heading'; heading.textContent = 'Suggested next step'; panel.append(heading);
      const project = node.projectId ? `project:${node.projectId}` : null;
      const direct = project && relations.some(edge => edge.from === project && edge.to === node.id && edge.kind === 'depends-on');
      const parents = relations.filter(edge => edge.to === node.id && edge.kind === 'depends-on').map(edge => byId.get(edge.from)?.label).filter(Boolean).slice(0, 3);
      if (flags.advisory) panel.append(actionText('Review applicability', `Open the OSV records and check affected ranges and fixes. ${node.kind === 'artifact' ? 'Select an affected occurrence to trace its project path.' : direct ? 'This is a direct dependency; review its manifest range and lockfile.' : `This is transitive; trace the parent${parents.length ? ` (${parents.join(', ')})` : ''} before choosing an update or override.`} Re-run tests and scan after a change.`));
      if (flags.deprecated) panel.append(actionText('Plan replacement', 'Read the npm deprecation message, identify the replacement or supported release, and test the migration.'));
      if (flags.outdated) panel.append(actionText('Review newer release', `npm latest is ${registry.latestTag}. A newer latest tag does not establish that advisories are fixed.`));
      if (flags.unknown) panel.append(actionText('Complete the check', 'Advisory coverage is unknown for this source. Confirm its actual source and retry a supported lookup before treating it as clean.'));
      appendTriage(panel, `package:${node.id}`);
    }
  }
  const incident = (currentView?.edges || relations).filter(edge => edge.from === node.id || edge.to === node.id);
  if (incident.length) {
    const title = document.createElement('p'); title.textContent = `${incident.length} recorded relationship${incident.length === 1 ? '' : 's'}`; panel.append(title);
    const list = document.createElement('ul'); list.className = 'relation-list';
    for (const edge of incident.slice(0, 12)) { const item = document.createElement('li'); item.textContent = `${edge.from === node.id ? '→' : '←'} ${byId.get(edge.from === node.id ? edge.to : edge.from)?.label} · ${edge.kind}`; list.append(item); }
    panel.append(list);
  }
}
function inspectEdge(edge) {
  const panel = $('inspector'); panel.replaceChildren();
  const type = document.createElement('div'); type.className = 'entity-type'; type.textContent = 'Relationship';
  const name = document.createElement('div'); name.className = 'entity-name'; name.textContent = `${byId.get(edge.from)?.label} → ${byId.get(edge.to)?.label}`;
  panel.append(type, name);
  for (const item of [detail('Kind', edge.kind), detail('Import specifier', edge.kind?.startsWith('imports-') ? edge.scope : null), detail('Scope', edge.kind?.startsWith('imports-') ? null : edge.scope), detail('Requested', edge.requested), detail('Evidence', edge.source), detail('Import map URL', edge.mappedUrl)]) if (item) panel.append(item);
}
function renderFindings() {
  const list = $('findings'); list.replaceChildren();
  $('finding-count').textContent = `${snapshot.findings.length} items`;
  if (!snapshot.findings.length) { const p = document.createElement('p'); p.className = 'source-note'; p.textContent = 'No coverage findings in this snapshot.'; list.append(p); }
  for (const finding of snapshot.findings) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'finding-card';
    const kind = document.createElement('span'); kind.className = 'finding-kind'; kind.textContent = finding.type.replaceAll('-', ' ');
    const title = document.createElement('strong'); title.textContent = finding.title;
    const meta = document.createElement('small'); meta.textContent = `${byId.get(`project:${finding.projectId}`)?.label || finding.projectId} · ${finding.evidence}${finding.detail ? ' · ' + finding.detail : ''}`;
    button.append(kind, title, meta);
    button.addEventListener('click', () => {
      mode = finding.type === 'root-unavailable' ? 'github' : 'js'; signalFilter = 'all'; projectSelect.value = `project:${finding.projectId}`; selectedId = projectSelect.value; selectedEdge = null; $('search').value = ''; renderAll();
      const panel = $('inspector'); panel.replaceChildren();
      const title = document.createElement('div'); title.className = 'entity-name'; title.textContent = finding.title; panel.append(title);
      panel.append(detail('Project', byId.get(`project:${finding.projectId}`)?.label || finding.projectId));
      panel.append(detail('Evidence', finding.evidence));
      if (finding.detail) panel.append(actionText('Suggested next step', finding.detail));
      if (finding.type === 'root-unavailable') {
        const root = document.createElement('button'); root.type = 'button'; root.className = 'action-button'; root.textContent = 'Set or review root';
        root.addEventListener('click', () => rootEditor({ id: finding.projectId, label: byId.get(`project:${finding.projectId}`)?.label || finding.projectId })); panel.append(root);
      }
      appendTriage(panel, `finding:${finding.id}`);
    });
    list.append(button);
  }
}
function renderDiscovery() {
  const body = $('discovery'); body.replaceChildren();
  const report = snapshot.discovery;
  if (!report) { $('discovery-note').textContent = 'Not run'; return; }
  const candidates = report.candidates.filter(candidate => candidate.status !== 'configured');
  candidates.sort((a, b) => (a.status === 'unlisted' ? 0 : 1) - (b.status === 'unlisted' ? 0 : 1) || a.path.localeCompare(b.path));
  $('discovery-note').textContent = `${candidates.filter(candidate => candidate.status === 'unlisted').length} unlisted roots · ${candidates.length - candidates.filter(candidate => candidate.status === 'unlisted').length} nested sources${report.truncated ? ' · incomplete search' : ''}`;
  for (const candidate of candidates) {
    const row = document.createElement('tr');
    for (const value of [candidate.path, [candidate.git ? 'Git repo' : null, ...(candidate.manifests || [])].filter(Boolean).join(' · '), candidate.status === 'unlisted' ? 'Not in portfolio' : candidate.status === 'nested-unscanned' ? `Inside ${candidate.projectId}; review importer coverage` : 'Inside unlisted repo']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const action = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = 'Set root';
    button.addEventListener('click', () => { inspectCandidate(candidate); $('inspector').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); });
    action.append(button); row.append(action); body.append(row);
  }
}

function lensEdges() {
  const allowed = mode === 'js' ? new Set(['declares', 'resolved-by']) : mode === 'source' ? new Set(['has-source-imports', 'imports-local', 'imports-external', 'imports-unresolved']) : mode === 'npm' ? new Set(['depends-on', 'contains-workspace', 'sourced-from']) : new Set(['checked-out-at', 'tracks', 'uses-action', 'sourced-from', 'submodule']);
  const result = relations.filter(edge => allowed.has(edge.kind) && (mode !== 'npm' || edge.kind !== 'sourced-from' || byId.get(edge.from)?.kind === 'occurrence'));
  if (mode === 'github') {
    for (const edge of result.filter(edge => edge.kind === 'sourced-from' && byId.get(edge.from)?.kind === 'occurrence')) {
      const occurrence = byId.get(edge.from);
      result.push({ from: `project:${occurrence.projectId}`, to: occurrence.id, kind: 'git package', source: 'lockfile Git URL' });
    }
  }
  return result;
}
function renderEdgeIndex() {
  const edges = snapshot.edges, selected = projectSelect.value === 'all' ? null : projectSelect.value;
  let reachable = null;
  if (selected) {
    reachable = new Set([selected]);
    for (let depth = 0; depth < 3; depth++) {
      const current = new Set(reachable);
      for (const edge of edges) if (current.has(edge.from)) reachable.add(edge.to);
    }
  }
  const query = $('search').value.trim().toLowerCase();
  const matching = edges.filter(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (reachable && !(from?.projectId === selected.slice(8) || to?.projectId === selected.slice(8) || reachable.has(edge.from) && reachable.has(edge.to))) return false;
    if (query && ![from?.label, to?.label, edge.kind, edge.source].some(value => value?.toLowerCase().includes(query))) return false;
    if (signalFilter !== 'all' && !matchesSignal(from) && !matchesSignal(to)) return false;
    return true;
  });
  const pages = Math.max(1, Math.ceil(matching.length / edgesPerPage));
  edgePage = Math.min(edgePage, pages - 1);
  const body = $('edges-table'); body.replaceChildren();
  for (const edge of matching.slice(edgePage * edgesPerPage, (edgePage + 1) * edgesPerPage)) {
    const row = document.createElement('tr');
    for (const value of [byId.get(edge.from)?.label, edge.kind, byId.get(edge.to)?.label, edge.source || 'Recorded graph']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const cell = document.createElement('td'), button = document.createElement('button');
    button.type = 'button'; button.className = 'quiet'; button.textContent = 'Inspect';
    button.addEventListener('click', () => { selectedId = null; selectedEdge = edge; inspectEdge(edge); $('inspector').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); });
    cell.append(button); row.append(cell); body.append(row);
  }
  $('edge-index-note').textContent = `${matching.length.toLocaleString()} matching of ${edges.length.toLocaleString()} recorded edges`;
  $('edge-page-label').textContent = `Page ${edgePage + 1} of ${pages} · ${matching.length ? edgePage * edgesPerPage + 1 : 0}–${Math.min((edgePage + 1) * edgesPerPage, matching.length)} of ${matching.length}`;
  $('edge-prev').disabled = edgePage === 0;
  $('edge-next').disabled = edgePage >= pages - 1;
}
function sourceCoverageNote() {
  if (mode !== 'source') return null;
  const scoped = projectSelect.value === 'all' ? snapshot.coverage : snapshot.coverage.filter(record => `project:${record.projectId}` === projectSelect.value);
  if (!scoped.length || !scoped.every(record => record.sourceFiles === 0)) return null;
  const statuses = [...new Set(scoped.map(record => readableStatus(record.source)))].join(', ');
  return `No JavaScript or TypeScript source files were found under ${projectSelect.value === 'all' ? 'any configured root' : 'this root'} (source coverage: ${statuses} · 0 files). The Source imports lens has nothing to draw. This is a coverage result, not a check that found no imports.`;
}
function directView(edges, query) {
  const all = projectSelect.value === 'all';
  const allRoots = all ? projects.map(project => project.id) : [projectSelect.value];
  const paged = all && !query && signalFilter === 'all';
  const allProjectsShown = paged && showAllProjects;
  const pages = allProjectsShown ? 1 : Math.max(1, Math.ceil(allRoots.length / projectsPerPage));
  projectPage = Math.min(projectPage, pages - 1);
  const roots = paged && !allProjectsShown ? allRoots.slice(projectPage * projectsPerPage, (projectPage + 1) * projectsPerPage) : allRoots;
  const rootSet = new Set(roots);
  const first = edges.filter(edge => rootSet.has(edge.from));
  const firstTargets = new Set(first.map(edge => edge.to));
  const second = edges.filter(edge => firstTargets.has(edge.from) && (mode === 'js' ? edge.kind === 'resolved-by' : mode === 'source' ? edge.kind.startsWith('imports-') : mode === 'npm' ? edge.kind === 'sourced-from' : edge.kind === 'tracks' || edge.kind === 'sourced-from'));
  const children = new Map();
  for (const edge of second) { if (!children.has(edge.from)) children.set(edge.from, []); children.get(edge.from).push(edge); }
  const visibleFirst = first.filter(edge => {
    const chain = [byId.get(edge.from), byId.get(edge.to), ...(children.get(edge.to) || []).map(child => byId.get(child.to))];
    return (!query || chain.some(node => node?.label.toLowerCase().includes(query))) && (signalFilter === 'all' || chain.some(matchesSignal));
  });
  const visibleTargets = new Set(visibleFirst.map(edge => edge.to));
  const visibleSecond = second.filter(edge => visibleTargets.has(edge.from));
  const rootNodes = roots.filter(id => !query && signalFilter === 'all' || visibleFirst.some(edge => edge.from === id) || (query ? byId.get(id)?.label.toLowerCase().includes(query) : matchesSignal(byId.get(id))));
  const keep = new Set([...rootNodes, ...visibleFirst.map(edge => edge.to), ...visibleSecond.map(edge => edge.to)]);
  const depth = new Map(rootNodes.map(id => [id, 0]));
  const projectOf = new Map(rootNodes.map(id => [id, id]));
  for (const edge of visibleFirst) { depth.set(edge.to, 1); if (!projectOf.has(edge.to)) projectOf.set(edge.to, edge.from); }
  for (const edge of visibleSecond) { depth.set(edge.to, 2); if (!projectOf.has(edge.to)) projectOf.set(edge.to, projectOf.get(edge.from)); }
  const message = sourceCoverageNote() || (keep.size ? `Showing every ${mode === 'source' ? 'source file with literal imports' : mode === 'js' ? 'direct JavaScript request' : mode === 'npm' ? 'direct npm / pnpm dependency' : 'GitHub source'} for the visible project scope. Select a node or edge to inspect its evidence.` : 'No direct matches in this lens. Try another project or view.');
  return { nodes: [...keep].map(id => byId.get(id)).filter(Boolean), edges: [...visibleFirst, ...visibleSecond], depth, projectOf, direct: true, directCount: visibleFirst.length, paged, allProjectsShown, pages, rootCount: allRoots.length, totalEdges: first.length + second.length, message };
}
function networkView(query) {
  const edges = lensEdges(), next = new Map();
  if (graphDetail === 'direct') return directView(edges, query);
  for (const edge of edges) { if (!next.has(edge.from)) next.set(edge.from, []); next.get(edge.from).push(edge); }
  for (const list of next.values()) list.sort((a, b) => edgePriority(a) - edgePriority(b) || (byId.get(a.to)?.label || '').localeCompare(byId.get(b.to)?.label || ''));
  const all = projectSelect.value === 'all';
  const allRoots = all ? projects.map(project => project.id) : [projectSelect.value];
  const paged = all && !query && signalFilter === 'all';
  const pages = Math.max(1, Math.ceil(allRoots.length / projectsPerPage));
  projectPage = Math.min(projectPage, pages - 1);
  const roots = paged ? allRoots.slice(projectPage * projectsPerPage, (projectPage + 1) * projectsPerPage) : allRoots;
  const depth = new Map(roots.map(id => [id, 0])), parent = new Map(), queue = [...roots];
  for (let i = 0; i < queue.length; i++) for (const edge of next.get(queue[i]) || []) if (!depth.has(edge.to)) {
    depth.set(edge.to, Math.min(3, depth.get(queue[i]) + 1)); parent.set(edge.to, edge); queue.push(edge.to);
  }
  const keep = new Set();
  if (query || signalFilter !== 'all') {
    const matches = [...depth.keys()].filter(id => (!query || byId.get(id)?.label.toLowerCase().includes(query)) && matchesSignal(byId.get(id))).slice(0, signalFilter === 'all' ? 8 : 12);
    for (const target of matches) {
      let current = target; keep.add(current);
      while (parent.has(current)) { current = parent.get(current).from; keep.add(current); }
      if (signalFilter === 'all') for (const edge of (next.get(target) || []).slice(0, 4)) keep.add(edge.to);
    }
    if (!matches.length) {
      const artifacts = visibleArtifacts();
      const source = signalFilter === 'advisory' ? 'OSV' : signalFilter === 'deprecated' || signalFilter === 'outdated' ? 'npm registry' : null;
      const anyChecked = source === 'OSV' ? artifacts.some(node => checksFor(node).osv?.status === 'checked') : source === 'npm registry' ? artifacts.some(node => checksFor(node).registry?.status === 'checked') : true;
      return { nodes: [], edges: [], depth, paged, pages, rootCount: allRoots.length, totalEdges: edges.length, message: source && !anyChecked ? `${source} has not been checked for this scope. No alert or lifecycle conclusion is available.` : `No ${signalFilter === 'all' ? 'dependency' : signalFilter.replace('-', ' ')} matches in this lens and scope. Try All projects or another lens.` };
    }
  } else if (all) {
    const limits = [0, 15, 15, 10];
    for (const root of roots) keep.add(root);
    let frontier = roots;
    for (let layer = 1; layer <= 3; layer++) {
      const chosen = [], cursors = new Map();
      let progressed = true;
      while (chosen.length < limits[layer] && progressed) {
        progressed = false;
        for (const source of frontier) {
          const list = next.get(source) || [];
          let cursor = cursors.get(source) || 0;
          while (cursor < list.length && keep.has(list[cursor].to)) cursor++;
          cursors.set(source, cursor + 1);
          if (cursor >= list.length) continue;
          keep.add(list[cursor].to); chosen.push(list[cursor].to); progressed = true;
          if (chosen.length >= limits[layer]) break;
        }
      }
      frontier = chosen;
    }
  } else {
    const root = roots[0]; keep.add(root);
    const limits = [1, 14, 17, 12], counts = [1, 0, 0, 0], visit = [root];
    for (let i = 0; i < visit.length; i++) {
      const from = visit[i], layer = Math.min(3, (depth.get(from) || 0) + 1);
      if (depth.get(from) >= 3) continue;
      for (const edge of next.get(from) || []) {
        if (keep.has(edge.to) || counts[layer] >= limits[layer]) continue;
        keep.add(edge.to); counts[layer]++; visit.push(edge.to);
      }
    }
  }
  const visible = edges.filter(edge => keep.has(edge.from) && keep.has(edge.to));
  const message = sourceCoverageNote() || (signalFilter !== 'all' ? `Showing up to 12 ${signalFilter} paths from this snapshot. Select a node for its lookup evidence.` : query ? 'Showing up to 8 matching paths and nearby relationships across the full snapshot.' : all ? 'Showing every project root across pages, with a bounded dependency sample per page. Focus a project or search to trace more paths.' : 'Showing a bounded project path. Search to trace a dependency through the full snapshot.');
  return { nodes: [...keep].map(id => byId.get(id)).filter(Boolean), edges: visible, depth, paged, pages, rootCount: allRoots.length, totalEdges: edges.length, message };
}

const svgNS = 'http://www.w3.org/2000/svg';
function svgElement(tag, attributes = {}) { const element = document.createElementNS(svgNS, tag); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value); return element; }
function drawGraph(view) {
  const svg = $('graph'); svg.replaceChildren();
  $('graph-empty').hidden = view.nodes.length > 0;
  $('graph-empty').textContent = view.nodes.length ? '' : view.message;
  if (!view.nodes.length) { $('graph-note').textContent = '0 visible nodes'; return; }
  const defs = svgElement('defs'), marker = svgElement('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
  marker.append(svgElement('path', { d: 'M0 0 L10 5 L0 10 Z', fill: '#9db8a3' })); defs.append(marker); svg.append(defs);
  const columns = new Map();
  for (const node of view.nodes) { const layer = Math.min(view.depth.get(node.id) ?? 3, 3); if (!columns.has(layer)) columns.set(layer, []); columns.get(layer).push(node); }
  for (const nodes of columns.values()) nodes.sort((a, b) => a.label.localeCompare(b.label));
  const positions = new Map(), width = 230, height = 30, xPositions = [24, 302, 580, 858];
  const titles = view.direct ? mode === 'js' ? ['Project', 'Requested direct dependency', 'Locked occurrence', ''] : mode === 'source' ? ['Project', 'Importing source file', 'Imported file / package', ''] : mode === 'npm' ? ['Project', 'Direct dependency', 'Package source', ''] : ['Project', 'Checkout / action / Git package', 'Repository / source', ''] : mode === 'js' ? ['Project', 'Requested dependency', 'Resolved occurrence', 'Further resolution'] : mode === 'source' ? ['Project', 'Importing source file', 'Imported file / package', 'Further import'] : mode === 'npm' ? ['Project', 'Direct dependency', 'Transitive dependency', 'Further dependency / source'] : ['Project', 'Checkout / action / Git package', 'Repository / source', 'Further source'];
  const title = svgElement('title'); title.textContent = `${mode} dependency graph with ${view.nodes.length} nodes and ${view.edges.length} edges. Use zoom controls and scroll the viewport to explore.`; svg.append(title);
  for (let layer = 0; layer < 4; layer++) {
    if (!titles[layer]) continue;
    const heading = svgElement('text', { x: xPositions[layer], y: 25, class: 'column-title' }); heading.textContent = titles[layer]; svg.append(heading);
    svg.append(svgElement('line', { x1: xPositions[layer], x2: xPositions[layer] + width, y1: 34, y2: 34, class: 'column-rule' }));
  }
  if (view.direct) {
    let top = 55;
    view.groupHeaders = [];
    for (const root of view.nodes.filter(node => node.kind === 'project')) {
      const grouped = [1, 2, 3].map(layer => (columns.get(layer) || []).filter(node => view.projectOf.get(node.id) === root.id));
      const rows = Math.max(1, ...grouped.map(nodes => nodes.length)), span = rows * 36;
      view.groupHeaders.push({ label: root.label, count: view.edges.filter(edge => edge.from === root.id).length, y: top + 10 });
      const contentTop = top + 24;
      positions.set(root.id, { x: xPositions[0], y: contentTop + (span - height) / 2 });
      grouped.forEach((nodes, index) => nodes.forEach((node, row) => positions.set(node.id, { x: xPositions[index + 1], y: contentTop + (span - nodes.length * 36) / 2 + row * 36 + 3 })));
      top += 24 + span + 18;
    }
    view.canvasHeight = Math.max(650, top + 20);
  } else {
    view.canvasHeight = 650;
    for (const [layer, nodes] of columns) {
      const step = Math.min(36, 565 / Math.max(1, nodes.length));
      const top = 57 + (570 - step * (nodes.length - 1) - height) / 2;
      nodes.forEach((node, index) => positions.set(node.id, { x: xPositions[layer], y: top + index * step }));
    }
  }
  svg.setAttribute('viewBox', `0 0 1100 ${view.canvasHeight}`);
  if (view.direct) for (const group of view.groupHeaders) {
    svg.append(svgElement('line', { x1: 24, x2: 1080, y1: group.y - 7, y2: group.y - 7, class: 'project-group-rule' }));
    const heading = svgElement('text', { x: 24, y: group.y + 4, class: 'project-group-title' }); heading.textContent = `${group.label} · ${group.count} direct link${group.count === 1 ? '' : 's'}`; svg.append(heading);
  }
  const focused = selectedId && positions.has(selectedId) ? selectedId : null;
  for (const edge of view.edges) {
    const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
    const x1 = from.x + width, y1 = from.y + height / 2, x2 = to.x, y2 = to.y + height / 2;
    const bend = Math.max(35, (x2 - x1) * .48);
    const active = selectedEdge === edge || focused && (edge.from === focused || edge.to === focused);
    const path = svgElement('path', { d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`, class: `edge${active ? ' active' : focused ? ' dim' : ''}`, 'marker-end': 'url(#arrow)', tabindex: '0', role: 'button', 'aria-label': `${byId.get(edge.from)?.label} to ${byId.get(edge.to)?.label}: ${edge.kind}` });
    const title = svgElement('title'); title.textContent = `${edge.kind} · ${edge.source || 'recorded graph'}`; path.append(title);
    const selectEdge = () => { if (selectedEdge === edge) return clearGraphSelection(); selectedId = null; selectedEdge = edge; drawGraph(view); inspectEdge(edge); };
    path.addEventListener('click', selectEdge); path.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(); } }); svg.append(path);
  }
  for (const node of view.nodes) {
    const flags = signalFlags(node), status = signalFilter !== 'all' && flags[signalFilter] ? signalFilter : ['critical', 'advisory', 'deprecated', 'outdated', 'coverage', 'unknown'].find(key => flags[key]);
    const statuses = Object.entries(flags).filter(([, value]) => value).map(([key]) => key).join(', ');
    const pos = positions.get(node.id), group = svgElement('g', { class: `node ${node.kind}${status ? ` signal-${status}` : ''}${focused === node.id ? ' selected' : focused && !view.edges.some(edge => edge.from === focused && edge.to === node.id || edge.to === focused && edge.from === node.id) ? ' dim' : ''}`, transform: `translate(${pos.x} ${pos.y})`, tabindex: '0', role: 'button', 'aria-label': `${node.kind}: ${displayLabel(node)}${statuses ? `; ${statuses}` : ''}` });
    group.append(svgElement('rect', { width, height, rx: '5' }));
    const shown = displayLabel(node);
    const label = svgElement('text', { x: '9', y: '19' }); label.textContent = shown.length > (status ? 26 : 30) ? shown.slice(0, status ? 24 : 28) + '…' : shown; group.append(label);
    if (status) group.append(svgElement('circle', { class: 'status-marker', cx: width - 10, cy: height / 2, r: 4 }));
    const title = svgElement('title'); title.textContent = `${node.kind} · ${shown}${statuses ? ` · ${statuses}` : ''}`; group.append(title);
    const selectNode = () => { if (selectedId === node.id) return clearGraphSelection(); selectedId = node.id; selectedEdge = null; drawGraph(view); inspectNode(node); };
    group.addEventListener('click', selectNode); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(); } }); svg.append(group);
  }
  const coverageSuffix = mode === 'source' && !view.edges.length && sourceCoverageNote() ? ' · no source files found (coverage, not a clean check)' : '';
  $('graph-note').textContent = (view.direct ? `${view.nodes.filter(node => node.kind === 'project').length} projects · ${view.directCount} direct links · ${view.edges.length} of ${view.totalEdges} direct-view edges shown` : `${view.nodes.length} visible nodes · ${view.edges.length} of ${view.totalEdges} lens edges shown · bounded path view`) + coverageSuffix;
}
function clearGraphSelection() {
  selectedId = null; selectedEdge = null;
  if (currentView) drawGraph(currentView);
  const panel = $('inspector'); panel.replaceChildren();
  const p = document.createElement('p'); p.textContent = currentView?.message || 'Select a node or edge to inspect its evidence.'; panel.append(p);
}
function applyZoom(preserveCenter = false) {
  const stage = $('graph-stage'), svg = $('graph');
  const canvasHeight = currentView?.canvasHeight || 650;
  if (fitZoom) {
    svg.style.width = '100%';
    svg.style.height = currentView?.direct ? `${Math.max(stage.clientHeight || 650, Math.round(canvasHeight * (stage.clientWidth || 1100) / 1100))}px` : '100%';
    $('zoom-level').textContent = currentView?.direct ? 'Fit width' : 'Fit';
    stage.scrollLeft = 0; stage.scrollTop = 0;
    return;
  }
  const oldWidth = parseFloat(svg.style.width) || 1100, oldHeight = parseFloat(svg.style.height) || canvasHeight;
  const centerX = (stage.scrollLeft + (stage.clientWidth || 1100) / 2) / oldWidth;
  const centerY = (stage.scrollTop + (stage.clientHeight || 650) / 2) / oldHeight;
  svg.style.width = `${Math.round(1100 * zoom)}px`;
  svg.style.height = `${Math.round(canvasHeight * zoom)}px`;
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  if (preserveCenter) {
    stage.scrollLeft = Math.max(0, centerX * 1100 * zoom - (stage.clientWidth || 1100) / 2);
    stage.scrollTop = Math.max(0, centerY * canvasHeight * zoom - (stage.clientHeight || 650) / 2);
  } else { stage.scrollLeft = 0; stage.scrollTop = 0; }
}
function changeZoom(factor) {
  const wasFit = fitZoom;
  if (wasFit) {
    const stage = $('graph-stage');
    zoom = currentView?.direct ? (stage.clientWidth || 1100) / 1100 : Math.min((stage.clientWidth || 1100) / 1100, (stage.clientHeight || 650) / 650);
    fitZoom = false;
  }
  zoom = Math.max(.3, Math.min(3, zoom * factor));
  applyZoom(!wasFit);
}
function renderScopeContext() {
  const context = $('scope-context');
  const project = byId.get(projectSelect.value);
  context.hidden = !project;
  if (!project) { context.textContent = ''; return; }
  const checkout = checkoutByProject.get(project.projectId);
  const siblings = (projectsByOrigin.get(checkout?.origin) || []).filter(other => other.id !== project.id);
  const critical = projectCriticalPackages.get(project.projectId)?.size || 0;
  context.textContent = `Checkout: ${checkout?.branch || 'unknown branch'}${checkout?.rootIsRepoSubdirectory ? ' (enclosing repository; project folder is a subdirectory)' : ''} · ${project.rootPath || 'root not configured'} · ${critical} critical package version${critical === 1 ? '' : 's'} in cached checks${siblings.length ? ` · Same remote also scanned as ${siblings.map(other => `${other.label} (${checkoutByProject.get(other.projectId)?.branch || 'detached'})`).join(', ')}` : ''}`;
}
function renderGraph() {
  const query = $('search').value.trim().toLowerCase();
  const view = networkView(query);
  currentView = view;
  renderScopeContext();
  $('graph-detail').value = graphDetail;
  $('graph-pages').hidden = !view.paged;
  if (view.paged) {
    $('page-label').textContent = view.allProjectsShown ? `All ${view.rootCount} projects · scroll graph` : `Projects ${projectPage * projectsPerPage + 1}–${Math.min((projectPage + 1) * projectsPerPage, view.rootCount)} of ${view.rootCount} · page ${projectPage + 1}/${view.pages}`;
    $('page-prev').hidden = !!view.allProjectsShown;
    $('page-next').hidden = !!view.allProjectsShown;
    $('page-prev').disabled = projectPage === 0;
    $('page-next').disabled = projectPage >= view.pages - 1;
    $('page-all').hidden = !view.direct;
    $('page-all').textContent = view.allProjectsShown ? 'Pages of 10' : `Show all ${view.rootCount}`;
  }
  const scope = byId.get(projectSelect.value)?.label || 'All projects';
  $('graph-subtitle').textContent = `${scope} · ${graphDetail === 'direct' ? 'complete direct links' : mode === 'js' ? 'manifest requests and locked resolutions' : mode === 'source' ? 'literal source imports and import maps' : mode === 'npm' ? 'resolved npm / pnpm paths' : 'checkouts, actions, Git packages, and repositories'}`;
  $('scope-hint').textContent = graphDetail === 'direct' ? 'All direct links · scroll to explore' : mode === 'js' ? 'Requested range → locked version' : mode === 'source' ? 'File → local module / external import' : mode === 'npm' ? 'Direct → transitive → source' : 'Checkout / action → repository';
  for (const name of ['js', 'source', 'npm', 'github']) $(`${name}-tab`).setAttribute('aria-selected', String(mode === name));
  drawGraph(view);
  applyZoom();
  if (!selectedId && !selectedEdge) { const panel = $('inspector'); panel.replaceChildren(); const p = document.createElement('p'); p.textContent = view.message; panel.append(p); }
}
function renderAll() { renderSignalBar(); renderGraph(); renderInventory(); renderEdgeIndex(); }
projectSelect.addEventListener('change', () => { graphDetail = projectSelect.value === 'all' ? 'direct' : 'paths'; showAllProjects = false; projectPage = 0; edgePage = 0; selectedId = null; selectedEdge = null; renderAll(); });
$('graph-detail').addEventListener('change', () => { graphDetail = $('graph-detail').value; selectedId = null; selectedEdge = null; renderGraph(); });
$('graph-stage').addEventListener('click', event => { if (!event.target.closest?.('.node, .edge')) clearGraphSelection(); });
$('page-prev').addEventListener('click', () => { projectPage = Math.max(0, projectPage - 1); selectedId = null; selectedEdge = null; renderAll(); });
$('page-next').addEventListener('click', () => { projectPage++; selectedId = null; selectedEdge = null; renderAll(); });
$('page-all').addEventListener('click', () => { showAllProjects = !showAllProjects; projectPage = 0; fitZoom = true; selectedId = null; selectedEdge = null; renderGraph(); });
$('edge-prev').addEventListener('click', () => { edgePage = Math.max(0, edgePage - 1); renderEdgeIndex(); });
$('edge-next').addEventListener('click', () => { edgePage++; renderEdgeIndex(); });
$('search').addEventListener('input', () => { edgePage = 0; selectedId = null; selectedEdge = null; renderAll(); });
for (const name of ['js', 'source', 'npm', 'github']) $(`${name}-tab`).addEventListener('click', () => { mode = name; edgePage = 0; selectedId = null; selectedEdge = null; renderAll(); });
for (const name of ['all', 'critical', 'advisory', 'deprecated', 'outdated', 'unknown', 'coverage']) $(`signal-${name}`).addEventListener('click', () => { signalFilter = name; edgePage = 0; if (name !== 'all') { projectSelect.value = 'all'; graphDetail = 'paths'; } else if (projectSelect.value === 'all') graphDetail = 'direct'; if (name !== 'all' && name !== 'coverage') mode = 'npm'; if (name === 'coverage') mode = 'js'; selectedId = null; selectedEdge = null; $('search').value = ''; renderAll(); });
$('add-project').addEventListener('click', () => { rootEditor(); $('inspector').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); });
$('zoom-out').addEventListener('click', () => changeZoom(1 / 1.25));
$('zoom-in').addEventListener('click', () => changeZoom(1.25));
$('zoom-fit').addEventListener('click', () => { fitZoom = true; applyZoom(); });
$('export').addEventListener('click', () => { const data = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(data), link = document.createElement('a'); link.href = url; link.download = 'supply-chain-snapshot.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
renderCoverage(); renderFindings(); renderDiscovery(); renderAll();
if (localService) fetch('/api/triage', { headers: { 'x-supply-chain-token': localService.token } }).then(response => response.json()).then(state => { triageItems = state.items || {}; }).catch(() => {});
