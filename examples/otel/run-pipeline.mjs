#!/usr/bin/env node
// Example: run scan -> evaluate -> packet (-> check-proposal -> check-decision) with one span per stage.
//
//   node examples/otel/run-pipeline.mjs --config PRIVATE_CONFIG --private PRIVATE_DIR [--policy FILE] [--enrich] [--proposal FILE --decision FILE]
//
// Set SCG_OTEL_ENDPOINT to export spans over OTLP/HTTP JSON; without it the run prints the span summary to stderr and
// sends nothing. Span attributes are counts, coverage states, outcomes, durations, and coarse error codes only.
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTelemetry } from './telemetry.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = resolve(base, 'scripts/supply-chain.mjs');

function runCli(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { if (code === 0 || code === 3) done({ code, stderr }); else { const error = new Error(`CLI exited ${code}`); error.exitCode = code; error.stderr = stderr; reject(error); } });
  });
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const countBy = (items, key) => items.reduce((counts, item) => { counts[item[key]] = (counts[item[key]] || 0) + 1; return counts; }, {});

export async function runPipeline({ config, privateDir, policy = resolve(base, 'contracts/policy.default.json'), enrich = false, proposal = null, decision = null, telemetry = createTelemetry() }) {
  await mkdir(privateDir, { recursive: true });
  const snapshotFile = resolve(privateDir, 'snapshot.json'), resultFile = resolve(privateDir, 'policy-result.json'), packetFile = resolve(privateDir, 'packet.json');
  const snapshot = await telemetry.span('scan', {}, async set => {
    await runCli(['scan', '--config', config, '--out', snapshotFile]);
    const data = await readJson(snapshotFile);
    set({ 'scg.count.projects': data.coverage.length, 'scg.count.nodes': data.nodes.length, 'scg.count.edges': data.edges.length, 'scg.count.findings': data.findings.length, 'scg.flag.discovery': Boolean(data.discovery) });
    return data;
  });
  if (enrich) await telemetry.span('enrich', {}, async set => {
    await runCli(['enrich', '--snapshot', snapshotFile, '--out', snapshotFile]);
    await runCli(['advisory-details', '--snapshot', snapshotFile, '--out', snapshotFile]);
    const data = await readJson(snapshotFile);
    const entries = Object.values(data.enrichment?.packages || {});
    set({ 'scg.count.osv_checked': entries.filter(entry => entry.osv?.status === 'checked').length, 'scg.count.osv_failed': entries.filter(entry => entry.osv?.status === 'error').length });
  });
  const result = await telemetry.span('evaluate', {}, async set => {
    const { code } = await runCli(['evaluate', '--snapshot', snapshotFile, '--policy', policy, '--out', resultFile]);
    const data = await readJson(resultFile);
    const attributes = { 'scg.gate': data.gate.status, 'scg.freshness': data.freshness.state, 'scg.count.findings': data.summary.findings, 'scg.count.actionable': data.summary.actionable, 'scg.count.needs_review': data.summary.needsReview, 'scg.count.informational': data.summary.informational, 'scg.flag.gate_failed': code === 3 };
    for (const [check, totals] of Object.entries(data.checks.totals)) for (const [state, count] of Object.entries(totals)) attributes[`scg.coverage.${check}.${state}`] = count;
    set(attributes);
    return data;
  });
  const packet = await telemetry.span('packet', {}, async set => {
    await runCli(['packet', '--result', resultFile, '--policy', policy, '--out', packetFile]);
    const data = await readJson(packetFile);
    set({ 'scg.count.items': data.items.length, 'scg.count.evidence': data.evidenceIds.length, ...Object.fromEntries(Object.entries(countBy(data.items, 'transition')).map(([key, value]) => [`scg.count.transition_${key.replace(/-/g, '_')}`, value])) });
    return data;
  });
  let proposalOk = null, authorized = null;
  if (proposal) proposalOk = await telemetry.span('proposal.check', {}, async set => {
    const { code } = await runCli(['check-proposal', '--proposal', proposal, '--packet', packetFile]).catch(error => error.exitCode === 1 ? { code: 1 } : Promise.reject(error));
    set({ 'scg.outcome': code === 0 ? 'ok' : 'rejected', 'scg.flag.proposal_accepted': code === 0 });
    return code === 0;
  });
  if (proposal && decision) authorized = await telemetry.span('decision.check', {}, async set => {
    const { code } = await runCli(['check-decision', '--decision', decision, '--proposal', proposal, '--packet', packetFile]).catch(error => error.exitCode === 1 ? { code: 1 } : Promise.reject(error));
    set({ 'scg.outcome': code === 0 ? 'authorized' : 'not-authorized', 'scg.flag.authorized': code === 0 });
    return code === 0;
  });
  const exported = await telemetry.flush();
  return { snapshot, result, packet, proposalOk, authorized, exported, telemetry };
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? null : args[index + 1]; };
  if (!option('config') || !option('private')) { console.error('Usage: run-pipeline.mjs --config FILE --private DIR [--policy FILE] [--enrich] [--proposal FILE --decision FILE]'); process.exitCode = 2; return; }
  const telemetry = createTelemetry();
  try {
    const run = await runPipeline({ config: option('config'), privateDir: option('private'), policy: option('policy') || undefined, enrich: args.includes('--enrich'), proposal: option('proposal'), decision: option('decision'), telemetry });
    console.error(`${run.telemetry.spans.length} spans for run ${run.telemetry.runId}: ${run.telemetry.spans.map(span => `${span.name} ${span.attributes['scg.outcome']} ${span.attributes['scg.duration_ms']}ms`).join(', ')}`);
    console.error(run.exported.exported ? `Exported to the configured OTLP endpoint (HTTP ${run.exported.status}).` : 'No OTLP endpoint configured; nothing was exported.');
  } catch (error) {
    await telemetry.flush().catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
