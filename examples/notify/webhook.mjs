#!/usr/bin/env node
// Example webhook consumer for event packets. Separate from scan code and disabled by default: it only runs when
// you invoke it, and it refuses to send unless SCG_WEBHOOK_URL and SCG_WEBHOOK_SECRET are set in your environment.
//
//   node examples/notify/webhook.mjs --packet PRIVATE_PACKET --receipts PRIVATE_RECEIPTS [--suppressions PRIVATE_STATE] [--transitions observed] [--dry-run]
//
// It signs every body with HMAC-SHA256, sends an idempotency key per event, times out, retries a bounded number of
// times on transport or 5xx errors, and records private delivery receipts so a re-run delivers nothing twice.
// It never executes anything found in scan data, advisory text, package metadata, or a model answer: it posts JSON.
import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEVER_DELIVERED = new Set(['unknown']);

export async function readJsonOr(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function sign(secret, body) { return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'); }

export function activeSuppression(state, findingId, now) {
  const entry = state?.items?.[findingId];
  if (!entry) return null;
  if (!['suppressed', 'acknowledged'].includes(entry.status)) return null;
  if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now.getTime()) return { ...entry, expired: true };
  return entry;
}

export async function deliver(packet, { url, secret, receiptsFile, suppressions = null, transitions = ['observed'], fetchImpl = globalThis.fetch, attempts = 3, timeoutMs = 10000, backoffMs = 500, now = new Date(), dryRun = false, log = () => {} } = {}) {
  if (packet?.schemaVersion !== 1) throw new Error('Only event packet schemaVersion 1 is supported');
  if (!dryRun && (!url || !secret)) throw new Error('Set SCG_WEBHOOK_URL and SCG_WEBHOOK_SECRET to deliver; nothing is sent without both');
  const receipts = receiptsFile ? await readJsonOr(receiptsFile, { schemaVersion: 1, destination: null, deliveries: {} }) : { schemaVersion: 1, destination: null, deliveries: {} };
  receipts.destination = url ? new URL(url).host : null;
  const outcome = { delivered: 0, skipped: 0, suppressed: 0, failed: 0, notDeliverable: 0 };
  const save = async () => { if (receiptsFile) { await mkdir(dirname(resolve(receiptsFile)), { recursive: true }); await writeFile(receiptsFile, JSON.stringify(receipts, null, 2) + '\n'); } };
  for (const item of packet.items) {
    const key = item.eventId;
    if (NEVER_DELIVERED.has(item.transition)) { outcome.notDeliverable++; log(`${key}: transition ${item.transition} is never delivered as an alert`); continue; }
    if (!transitions.includes(item.transition)) { outcome.skipped++; continue; }
    if (receipts.deliveries[key]?.status === 'delivered') { outcome.skipped++; log(`${key}: already delivered ${receipts.deliveries[key].deliveredAt}`); continue; }
    const suppression = activeSuppression(suppressions, item.findingId, now);
    if (suppression && !suppression.expired && item.transition !== 'no-longer-observed') {
      receipts.deliveries[key] = { status: 'suppressed', findingId: item.findingId, transition: item.transition, packetHash: packet.packetHash, suppressedBy: suppression.owner || null, reason: suppression.reason || null, expiresAt: suppression.expiresAt || null, recordedAt: now.toISOString() };
      outcome.suppressed++; await save(); continue;
    }
    const body = JSON.stringify({ schemaVersion: 1, packetId: packet.packetId, packetHash: packet.packetHash, policy: packet.policy, generatedAt: packet.generatedAt, event: item, note: 'Evidence for review. Acknowledgement is not resolution; only a later successful scan can establish that a finding is no longer observed.' });
    const receipt = { status: 'pending', findingId: item.findingId, transition: item.transition, packetHash: packet.packetHash, attempts: 0, lastStatusCode: null, lastError: null, deliveredAt: null, ...(suppression?.expired ? { expiredSuppression: { owner: suppression.owner || null, expiresAt: suppression.expiresAt } } : {}) };
    receipts.deliveries[key] = receipt;
    if (dryRun) { receipt.status = 'dry-run'; outcome.delivered++; log(`${key}: would deliver ${body.length} bytes`); await save(); continue; }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      receipt.attempts = attempt;
      try {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-scg-signature': sign(secret, body), 'x-scg-idempotency-key': key, 'x-scg-packet-hash': packet.packetHash, 'user-agent': 'supply-chain-graph-webhook-example/1' }, body, signal: AbortSignal.timeout(timeoutMs) });
        receipt.lastStatusCode = response.status;
        if (response.ok) { receipt.status = 'delivered'; receipt.deliveredAt = new Date().toISOString(); receipt.lastError = null; break; }
        receipt.lastError = `HTTP ${response.status}`;
        if (response.status < 500) break;
      } catch (error) { receipt.lastError = error.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : error.message; }
      if (attempt < attempts) await new Promise(done => setTimeout(done, backoffMs * 2 ** (attempt - 1)));
    }
    if (receipt.status !== 'delivered') { receipt.status = 'failed'; outcome.failed++; log(`${key}: failed after ${receipt.attempts} attempt(s): ${receipt.lastError}`); }
    else { outcome.delivered++; log(`${key}: delivered`); }
    await save();
  }
  await save();
  return { outcome, receipts };
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? null : args[index + 1]; };
  if (!option('packet')) { console.error('Usage: webhook.mjs --packet FILE --receipts FILE [--suppressions FILE] [--transitions observed,no-longer-observed] [--dry-run]'); process.exitCode = 2; return; }
  const packet = JSON.parse(await readFile(option('packet'), 'utf8'));
  const suppressions = option('suppressions') ? JSON.parse(await readFile(option('suppressions'), 'utf8')) : null;
  const { outcome } = await deliver(packet, { url: process.env.SCG_WEBHOOK_URL, secret: process.env.SCG_WEBHOOK_SECRET, receiptsFile: option('receipts'), suppressions, transitions: (option('transitions') || 'observed').split(',').map(value => value.trim()).filter(Boolean), dryRun: args.includes('--dry-run'), log: message => console.error(message) });
  console.error(`Delivered ${outcome.delivered}, skipped ${outcome.skipped}, suppressed ${outcome.suppressed}, failed ${outcome.failed}, never deliverable ${outcome.notDeliverable}.`);
  if (outcome.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
