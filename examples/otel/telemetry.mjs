// Opt-in, dependency-free tracing for the pipeline. Spans carry run and trace IDs, stage names, durations, counts,
// coverage states, and coarse error codes. They never carry paths, repository or project names, package names,
// versions, advisory text, source text, tokens, packet bodies, or proposal bodies: attribute keys are allowlisted and
// string values are constrained, so a caller cannot smuggle one in by accident. Nothing is exported unless an OTLP
// endpoint is configured explicitly; with no endpoint the spans stay in memory for the caller to inspect or discard.
import { randomBytes } from 'node:crypto';

export const stages = ['scan', 'discovery', 'parse', 'enrich', 'evaluate', 'packet', 'proposal.check', 'decision.check', 'delivery'];
const coverageStates = new Set(['checked-and-none', 'checked-with-results', 'failed', 'unqueried', 'unsupported', 'stale', 'fresh', 'unknown']);
const token = /^[a-z][a-z0-9_-]{0,39}$/;

// Exactly these keys are exported. Everything else is dropped and counted in scg.dropped_attributes.
const allowed = {
  'scg.stage': value => stages.includes(value),
  'scg.run_id': value => /^[0-9a-f]{16,32}$/.test(value),
  'scg.outcome': value => ['ok', 'error', 'skipped', 'rejected', 'authorized', 'not-authorized'].includes(value),
  'scg.error.code': value => typeof value === 'string' && token.test(value),
  'scg.gate': value => ['pass', 'fail', 'not-configured'].includes(value),
  'scg.freshness': value => ['fresh', 'stale', 'unknown'].includes(value),
  'scg.duration_ms': value => Number.isInteger(value) && value >= 0
};
const allowedPrefixes = {
  'scg.count.': value => Number.isInteger(value) && value >= 0,
  'scg.coverage.': value => Number.isInteger(value) && value >= 0,
  'scg.flag.': value => typeof value === 'boolean'
};
const keyOk = key => typeof key === 'string' && /^scg\.[a-z0-9_.-]{1,48}$/.test(key) && !/\.\./.test(key);

export function sanitizeAttributes(input = {}) {
  const kept = {}; let dropped = 0;
  for (const [key, value] of Object.entries(input)) {
    const direct = allowed[key];
    const prefix = Object.keys(allowedPrefixes).find(candidate => key.startsWith(candidate));
    const rule = direct || (prefix ? allowedPrefixes[prefix] : null);
    if (keyOk(key) && rule && rule(value) && (prefix ? coverageOk(key, prefix) : true)) kept[key] = value;
    else dropped++;
  }
  if (dropped) kept['scg.dropped_attributes'] = dropped;
  return kept;
}
// scg.coverage.<check>.<state> may only name a known coverage state.
function coverageOk(key, prefix) {
  if (prefix !== 'scg.coverage.') return true;
  const parts = key.slice(prefix.length).split('.');
  return parts.length === 2 && ['osv', 'registry'].includes(parts[0]) && coverageStates.has(parts[1]);
}

// Errors become coarse codes: an errno or ERR_ code, an HTTP status, or "error". Never the message.
export function errorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return code.toLowerCase();
  const status = /HTTP (\d{3})/.exec(error?.message || '')?.[1];
  if (status) return `http_${status}`;
  if (error?.name === 'TimeoutError') return 'timeout';
  if (typeof error?.exitCode === 'number') return `exit_${error.exitCode}`;
  return 'error';
}

export function createTelemetry({ endpoint = process.env.SCG_OTEL_ENDPOINT || null, headers = {}, serviceName = 'supply-chain-graph', runId = randomBytes(8).toString('hex'), fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (endpoint && !/^https?:\/\//.test(endpoint)) throw new Error('SCG_OTEL_ENDPOINT must be an explicit http(s) URL');
  const traceId = randomBytes(16).toString('hex');
  const spans = [];
  const span = async (stage, attributes, work) => {
    if (!stages.includes(stage)) throw new Error(`Unknown stage "${stage}"; use one of ${stages.join(', ')}`);
    const start = now();
    const record = { name: `scg.${stage}`, spanId: randomBytes(8).toString('hex'), startMs: start, endMs: null, status: 'ok', attributes: sanitizeAttributes({ 'scg.stage': stage, 'scg.run_id': runId, ...attributes }) };
    spans.push(record);
    try {
      const outcome = await work(extra => Object.assign(record.attributes, sanitizeAttributes(extra)));
      record.attributes['scg.outcome'] = record.attributes['scg.outcome'] || 'ok';
      return outcome;
    } catch (error) {
      record.status = 'error';
      record.attributes['scg.outcome'] = 'error';
      record.attributes['scg.error.code'] = errorCode(error);
      throw error;
    } finally {
      record.endMs = now();
      record.attributes['scg.duration_ms'] = Math.max(0, record.endMs - record.startMs);
    }
  };
  const payload = () => ({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }, { key: 'scg.run_id', value: { stringValue: runId } }] },
      scopeSpans: [{ scope: { name: 'supply-chain-graph/examples/otel', version: '1' }, spans: spans.map(record => ({
        traceId, spanId: record.spanId, name: record.name, kind: 1,
        startTimeUnixNano: String(BigInt(record.startMs) * 1000000n), endTimeUnixNano: String(BigInt(record.endMs ?? record.startMs) * 1000000n),
        status: { code: record.status === 'ok' ? 1 : 2 },
        attributes: Object.entries(record.attributes).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } }))
      })) }]
    }]
  });
  const flush = async () => {
    const body = payload();
    if (!endpoint) return { exported: false, spans: spans.length, body };
    const response = await fetchImpl(new URL('/v1/traces', endpoint).toString(), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { exported: response.ok, status: response.status, spans: spans.length, body };
  };
  return { runId, traceId, span, flush, spans, payload };
}
