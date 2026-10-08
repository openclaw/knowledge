// Run after tsc: node --expose-gc scripts/measure-record-capacity.mjs.
// Synthetic isolated vaults, real publication/Git/history/index paths; never live data.
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { KnowledgeStorage } from '../dist/storage.js';
import { inspectRecord } from '../dist/inspection.js';
import { createVault, plainAccess } from '../test/support.mjs';

const results = [];
for (const bytes of [40000, 1000000, 4950000]) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-capacity-cost-'));
  try {
    const f = await createVault(base), access = plainAccess(), storage = new KnowledgeStorage(f.config);
    const saved = await storage.save({ requestId: randomUUID(), title: 'Measurement fixture', type: 'concept', body: 'seed' }, access, 'agent');
    const file = path.join(f.root, 'private', saved.path), raw = await readFile(file, 'utf8'), header = raw.slice(0, -4);
    const unit = 'Capacity measurement paragraph with needle and Unicode é.\n';
    await writeFile(file, header + unit.repeat(Math.floor((bytes - Buffer.byteLength(header)) / Buffer.byteLength(unit))));
    global.gc?.(); const startMemory = process.memoryUsage().rss;
    const timings = {};
    const measure = async (label, fn) => { const start = performance.now(), value = await fn(); timings[label] = +(performance.now() - start).toFixed(1); return value; };
    // A fresh storage instance forces the cold catalog and external-edit observation path.
    const cold = new KnowledgeStorage(f.config);
    const scan = await measure('coldScanMs', () => cold.run(access, v => v.scan()));
    await measure('warmScanMs', () => cold.run(access, v => v.scan()));
    const record = scan.records.find(r => r.id === saved.id);
    const receipt = await measure('bodyEditMs', () => cold.editBody({ requestId: randomUUID(), id: saved.id,
      expectedVaultId: f.config.vaultId, expectedRevision: record.revision, expectedHash: record.hash,
      expectedOntologyFingerprint: scan.ontology.fingerprint, start: 0, end: 0, replacement: 'Measured edit.\n', reason: 'Synthetic cost measurement' }, access));
    const page = await measure('recordReadMs', () => cold.run(access, v => inspectRecord(v, { id: saved.id, metadataView: 'none' })));
    const search = await measure('indexedSearchMs', () => cold.search({ query: 'needle' }, access));
    await measure('warmSearchMs', () => cold.search({ query: 'needle' }, access));
    const history = cold.history(access, { id: saved.id });
    const revision = await measure('revisionWindowMs', () => cold.revision(access, history.entries[0].sequence));
    const recovery = await measure('recoveryWindowMs', () => cold.mutation(access, receipt.requestId));
    results.push({ fileBytes: (await stat(file)).size, ...timings, git: receipt.git?.state,
      recordResponseBytes: Buffer.byteLength(JSON.stringify(page)), revisionResponseBytes: Buffer.byteLength(JSON.stringify(revision)),
      recoveryResponseBytes: Buffer.byteLength(JSON.stringify(recovery)), searchHits: search.hits.length,
      rssDeltaBytes: process.memoryUsage().rss - startMemory, peakRssKiB: process.resourceUsage().maxRSS,
      databaseBytes: (await stat(f.config.statePath)).size });
  } finally { await rm(base, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, results }, null, 2));
