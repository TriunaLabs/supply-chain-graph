const OSV_URL = 'https://api.osv.dev/v1/querybatch';
const NPM_URL = 'https://registry.npmjs.org/';

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const failure = error => error instanceof Error ? error.message : String(error);

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function newerStableTag(installed, latest) {
  const parts = value => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(value || '');
  const current = parts(installed), target = parts(latest);
  if (!current || !target) return null;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(target[i]) - Number(current[i]);
    if (difference) return difference > 0;
  }
  return false;
}

async function queryOsv(artifacts, packages, checkedAt, fetchImpl) {
  for (const batch of chunks(artifacts, 200)) {
    try {
      const results = new Map(batch.map(artifact => [artifact.id, new Map()]));
      let pending = batch.map(artifact => ({ artifact, token: null }));
      for (let page = 0; pending.length; page++) {
        if (page >= 20) throw new Error('OSV pagination limit reached');
        const queries = pending.map(({ artifact, token }) => ({ package: { ecosystem: 'npm', name: artifact.name }, version: artifact.version, ...(token ? { page_token: token } : {}) }));
        const payload = await fetchJson(fetchImpl, OSV_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries }) });
        if (!Array.isArray(payload.results) || payload.results.length !== pending.length) throw new Error('Unexpected OSV batch response');
        const next = [];
        payload.results.forEach((result, index) => {
          const artifact = pending[index].artifact;
          for (const item of result.vulns || []) if (item.id) results.get(artifact.id).set(item.id, { id: item.id, modified: item.modified || null });
          if (result.next_page_token) next.push({ artifact, token: result.next_page_token });
        });
        pending = next;
      }
      for (const artifact of batch) packages[artifact.id].osv = { status: 'checked', checkedAt, advisories: [...results.get(artifact.id).values()].sort((a, b) => a.id.localeCompare(b.id)) };
    } catch (error) {
      for (const artifact of batch) packages[artifact.id].osv = { status: 'error', checkedAt, reason: failure(error) };
    }
  }
}

async function queryNpm(artifacts, packages, checkedAt, fetchImpl) {
  const byName = new Map();
  for (const artifact of artifacts) {
    if (!byName.has(artifact.name)) byName.set(artifact.name, []);
    byName.get(artifact.name).push(artifact);
  }
  const names = [...byName.keys()];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++], group = byName.get(name);
      try {
        const metadata = await fetchJson(fetchImpl, NPM_URL + encodeURIComponent(name), { headers: { accept: 'application/vnd.npm.install-v1+json' } });
        for (const artifact of group) {
          const version = metadata.versions?.[artifact.version];
          if (!version) {
            packages[artifact.id].registry = { status: 'unavailable', checkedAt, reason: 'Installed version was not present in public npm metadata.' };
            continue;
          }
          const latestTag = metadata['dist-tags']?.latest || null;
          packages[artifact.id].registry = { status: 'checked', checkedAt, latestTag, newerLatestTag: newerStableTag(artifact.version, latestTag), deprecated: version.deprecated || null };
        }
      } catch (error) {
        const reason = failure(error), status = reason === 'HTTP 404' ? 'unavailable' : 'error';
        for (const artifact of group) packages[artifact.id].registry = { status, checkedAt, reason: status === 'unavailable' ? 'Package was not found in the public npm registry.' : reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
}

export async function enrichSnapshot(snapshot, { projectId = null, fetchImpl = globalThis.fetch, checkOsv = true, checkNpm = true } = {}) {
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) throw new Error('A supply-chain snapshot is required');
  if (projectId && !snapshot.nodes.some(node => node.kind === 'project' && node.projectId === projectId)) throw new Error(`Unknown project ID: ${projectId}`);
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const artifactIds = projectId ? new Set(snapshot.edges.filter(edge => edge.kind === 'resolves-to' && nodeById.get(edge.from)?.projectId === projectId).map(edge => edge.to)) : null;
  const artifacts = snapshot.nodes.filter(node => node.kind === 'artifact' && node.ecosystem === 'npm' && node.name && node.version && (!artifactIds || artifactIds.has(node.id)));
  const checkedAt = new Date().toISOString();
  const available = new Set(snapshot.nodes.filter(node => node.kind === 'artifact' && node.ecosystem === 'npm').map(node => node.id));
  const packages = Object.fromEntries(Object.entries(snapshot.enrichment?.packages || {}).filter(([id]) => available.has(id)));
  for (const artifact of artifacts) packages[artifact.id] = { ...(packages[artifact.id] || {}) };
  const nonRegistry = new Set(snapshot.edges.filter(edge => edge.kind === 'resolves-to' && ['github-git', 'local'].includes(nodeById.get(edge.from)?.sourceKind)).map(edge => edge.to));
  const eligible = artifacts.filter(artifact => !nonRegistry.has(artifact.id));
  for (const artifact of artifacts) if (nonRegistry.has(artifact.id)) {
    const result = { status: 'unavailable', checkedAt, reason: 'Git or local source; public package name and version cannot verify the installed code.' };
    if (checkOsv) packages[artifact.id].osv = result;
    if (checkNpm) packages[artifact.id].registry = result;
  }
  await Promise.all([
    checkOsv ? queryOsv(eligible, packages, checkedAt, fetchImpl) : Promise.resolve(),
    checkNpm ? queryNpm(eligible, packages, checkedAt, fetchImpl) : Promise.resolve()
  ]);
  return { ...snapshot, enrichment: { schemaVersion: 1, attemptedAt: checkedAt, packages } };
}
