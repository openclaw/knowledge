import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { apiFor } from './support.mjs';

async function fixture(t, extraConfig = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-relink-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true, ...extraConfig };
  const api = apiFor(base, config), service = createKnowledgeService(api);
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.write'] } } };
  const page = (title, type = 'project', extra = {}) => service.save_page({ requestId: randomUUID(), title, type, body: 'Page.\n', ...extra }, owner);
  // Saved unlinked: inference is off, as when the subject page did not exist yet.
  const remember = (text, kind = 'fact') => service.remember({ requestId: randomUUID(), attribution: 'user in test session, 2026-10-20', excerpt: `User: ${text}`, items: [{ text, kind, infer_subject: false }] }, owner);
  const relink = async input => { const out = await service.relink(input, owner); assert.ok(Check(contract.operations.relink.output, out)); return out; };
  const entities = async id => (await service.record({ id, includeMetadata: true }, owner)).record.metadata.entities;
  return { service, owner, operator, page, remember, relink, entities };
}

test('relink links unique mentions, leaves ambiguous and unnamed claims, and a repeat pass links nothing', async t => {
  const f = await fixture(t);
  const atlas = (await f.remember('Atlas Labs moved its launch to March.')).items[0].id;
  const both = (await f.remember('Atlas Labs and Nimbus Works signed a pact.')).items[0].id;
  const none = (await f.remember('I prefer short replies.', 'preference')).items[0].id;
  const meeting = (await f.remember('Discussed pricing in Weekly Sync.')).items[0].id;
  assert.equal(await f.entities(atlas), undefined);
  const atlasPage = await f.page('Atlas Labs', 'company'), nimbus = await f.page('Nimbus Works', 'company');
  await f.page('Weekly Sync', 'meeting');

  const preview = await f.relink({ dryRun: true });
  assert.deepEqual([preview.dryRun, preview.scanned, preview.linked, preview.ambiguous, preview.noSubject], [true, 4, 1, 1, 2]);
  assert.equal(await f.entities(atlas), undefined, 'A dry run publishes nothing');
  assert.deepEqual(preview.examples.find(e => e.outcome === 'linked'), { id: atlas, title: 'Atlas Labs moved its launch to March.', outcome: 'linked', tier: 'mention', subject: { id: atlasPage.id, title: 'Atlas Labs' } });

  const run = await f.relink({});
  assert.deepEqual([run.linked, run.ambiguous, run.noSubject, run.failed, run.nextCursor], [1, 1, 2, 0, null]);
  assert.deepEqual(await f.entities(atlas), [atlasPage.id]);
  assert.equal(await f.entities(both), undefined, 'Two named entities stay unlinked');
  assert.equal(await f.entities(none), undefined);
  assert.equal(await f.entities(meeting), undefined, 'A meeting page is not a claim subject');
  const read = await f.service.record({ id: atlas, includeMetadata: true }, f.owner);
  assert.equal(read.record.body, 'Atlas Labs moved its launch to March.');
  assert.equal(read.record.lifecycle, 'active');
  assert.equal(read.record.revision, 2);
  const claims = await f.service.connections({ id: atlasPage.id, direction: 'claims' }, f.owner);
  assert.deepEqual(claims.connections.map(c => c.record.id), [atlas]);

  const again = await f.relink({});
  assert.deepEqual([again.scanned, again.linked, again.failed], [3, 0, 0], 'Linked claims leave the candidate set; nothing new links');
  assert.ok(nimbus.id);
});

test('relink uses a recorded source entity page, pages with a cursor, and only runs through agent tools', async t => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await f.remember(`Orbit Garden note ${i}.`)).items[0].id);
  const orbit = await f.page('Orbit Garden');
  const first = await f.relink({ limit: 2 });
  assert.equal(first.scanned, 2); assert.equal(first.linked, 2); assert.ok(first.nextCursor);
  const second = await f.relink({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.scanned, 1); assert.equal(second.linked, 1); assert.equal(second.nextCursor, null);
  for (const id of ids) assert.deepEqual(await f.entities(id), [orbit.id]);
  await assert.rejects(f.service.relink({}, f.operator), /through chat and agent tools/);
  await assert.rejects(f.service.relink({ dryRun: true }, f.operator), /through chat and agent tools/);

  // A claim annotated with an entity source page links through the page tier,
  // even when its text names nothing.
  const quiet = (await f.remember('Nothing named here.')).items[0].id;
  const r = (await f.service.record({ id: quiet }, f.owner)).record;
  await f.service.annotate({ requestId: randomUUID(), id: quiet, expectedRevision: r.revision, expectedHash: r.hash, reason: 'Recorded source', annotations: { source_page: orbit.id } }, f.owner);
  const out = await f.relink({});
  assert.equal(out.examples.find(e => e.id === quiet).tier, 'page');
  assert.deepEqual(await f.entities(quiet), [orbit.id]);
});

test('relink ignores claims that knowledge_remember did not save', async t => {
  const f = await fixture(t);
  await f.page('Atlas Labs', 'company');
  const fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  const upload = await f.service.attach({ requestId: randomUUID(), filename: 'source.txt', mediaType: 'text/plain', attribution: 'Synthetic', offset: 0, data: Buffer.from('Atlas Labs shipped.').toString('base64'), final: true }, f.owner);
  const authored = await f.service.create_claim({ requestId: randomUUID(), expectedOntologyFingerprint: fingerprint, title: 'Shipped', body: 'Atlas Labs shipped.', claim_kind: 'event', assertion_origin: 'source', attribution: 'Synthetic', evidence: [{ ...upload.evidence, start_line: 1, end_line: 1 }] }, f.owner);
  const out = await f.relink({});
  assert.equal(out.scanned, 0);
  assert.equal(await f.entities(authored.id), undefined, 'Deliberately unlinked authored claims are not maintenance targets');
});
