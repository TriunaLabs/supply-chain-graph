const OSV_DETAIL = 'https://api.osv.dev/v1/vulns/';

function compact(record) {
  const affected = (record.affected || []).filter(item => item.package?.name && item.package?.ecosystem).map(item => ({
    ecosystem: item.package.ecosystem,
    name: item.package.name,
    severity: item.ecosystem_specific?.severity || item.database_specific?.severity || null,
    fixedBoundaries: [...new Set((item.ranges || []).flatMap(range => range.type === 'SEMVER' || range.type === 'ECOSYSTEM' ? (range.events || []).map(event => event.fixed).filter(Boolean) : []))]
  }));
  return {
    status: 'checked',
    modified: record.modified || null,
    summary: record.summary || null,
    severity: record.database_specific?.severity || affected.find(item => item.severity)?.severity || null,
    affected
  };
}

export async function addAdvisoryDetails(snapshot, { fetchImpl = globalThis.fetch } = {}) {
  const ids = new Map();
  for (const entry of Object.values(snapshot.enrichment?.packages || {})) for (const advisory of entry.osv?.status === 'checked' ? entry.osv.advisories || [] : []) ids.set(advisory.id, advisory.modified || null);
  const details = { ...(snapshot.enrichment?.advisories || {}) };
  const pending = [...ids].filter(([id, modified]) => details[id]?.status !== 'checked' || details[id].modified !== modified);
  const checkedAt = new Date().toISOString();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const [id, modified] = pending[next++];
      try {
        const response = await fetchImpl(OSV_DETAIL + encodeURIComponent(id), { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        details[id] = { ...compact(await response.json()), modified, checkedAt };
      } catch (error) { details[id] = { status: 'error', modified, checkedAt, reason: error instanceof Error ? error.message : String(error) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
  return { ...snapshot, enrichment: { ...snapshot.enrichment, advisories: Object.fromEntries([...ids.keys()].map(id => [id, details[id]])) } };
}
