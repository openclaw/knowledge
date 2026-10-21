import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import plugin from '../dist/index.js';
import { apiFor, sessionActions } from './support.mjs';
import { contract } from '../dist/contract.js';

// A public feature/session-action adapter over the real storage implementation.
// Model reasoning is not simulated: these are contract trials of authored output.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-workflows-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'), vaultId = randomUUID(), publicationId = randomUUID();
  await mkdir(path.join(root, 'private'), { recursive: true });
  await writeFile(path.join(root, 'vault.json'), JSON.stringify({
    format: 'knowledge-vault-v2', vaultId, generation: 0, publicationId,
  }));
  const api = apiFor(base, { root, statePath: path.join(base, 'state.sqlite'), vaultId, publicationId, operatorRead: true, writesEnabled: true });
  let actions;
  function restart() {
    actions = new Map();
    plugin.register({ ...api, registerService() {}, registerTool() {},
      ...sessionActions(action => { actions.set(action.id, action); }) });
  }
  restart();
  async function call(name, payload = {}) {
    assert.ok(Check(contract.operations[name].input, payload), `${name} input`);
    const response = await actions.get(name).handler({ payload,
      client: { connId: 'workflow-trial', scopes: ['operator.write'] } });
    assert.equal(response.ok, true, response.error);
    assert.ok(Check(contract.operations[name].output, response.result), `${name} output`);
    return response.result;
  }
  async function attach(bytes, filename) {
    const input = { requestId: randomUUID(), expectedVaultId: vaultId, filename,
      mediaType: 'text/plain', attribution: 'Synthetic workflow trial source',
      offset: 0, data: bytes.toString('base64'), final: true };
    const result = await call('attach', input);
    assert.equal(result.state, 'complete');
    return result.evidence;
  }
  async function save(title, type, body, attachments = []) {
    const input = { requestId: randomUUID(), expectedVaultId: vaultId, title, type, body, attachments };
    return { input, receipt: await call('save_page', input) };
  }
  return { call, attach, save, restart, root, vaultId };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = name => readFile(new URL(`fixtures/workflows/${name}`, import.meta.url));

test('concurrent service calls publish once, allow reads, and recover after a rejected edit', async t => {
  const f = await fixture(t);
  await f.call('status');
  const inputs = Array.from({ length: 4 }, (_, i) => ({ requestId: randomUUID(),
    expectedVaultId: f.vaultId, title: `Concurrent person ${i}`, type: 'person', body: `Person ${i}` }));
  const results = await Promise.allSettled([
    ...inputs.map(input => f.call('save_page', input)),
    f.call('records'),
    f.call('save_page', inputs[0]),
  ]);
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
  const receipts = results.slice(0, 4).map(r => r.value);
  assert.deepEqual(results[5].value, receipts[0]);
  assert.equal((await f.call('records')).total, 4);
  const current = receipts[0];
  const edit = { ...inputs[0], requestId: randomUUID(), id: current.id,
    expectedRevision: current.revision, expectedHash: current.hash, body: 'Updated person' };
  await f.call('save_page', edit);
  const afterConflict = await Promise.allSettled([
    f.call('save_page', { ...edit, requestId: randomUUID(), body: 'Stale draft' }),
    f.call('record', { id: current.id }),
    f.call('save_page', inputs[1]),
  ]);
  assert.equal(afterConflict[0].status, 'rejected');
  assert.match(afterConflict[0].reason.message, /Edit conflict/);
  assert.equal(afterConflict[1].value.record.body, 'Updated person');
  assert.deepEqual(afterConflict[2].value, receipts[1]);
  assert.equal((await f.call('records')).total, 4);
});

test('document port: original retention, locators, entity reuse, readback and uncertain-save replay', async t => {
  const f = await fixture(t), bytes = await source('project-brief.txt');
  assert.equal((await f.call('status')).writesEnabled, true);
  const ontology = await f.call('ontology', { view: 'definitions', name: 'project' });
  assert.equal(ontology.available, true);
  const original = await f.attach(bytes, 'project-brief.txt');
  const locator = { ...original, start_line: 3, end_line: 4,
    quote: 'The current target for the Orchid pilot is October 15, 2026.' };
  const person = await f.save('Morgan Hale', 'person',
    'Project lead at Northstar Labs. [Source: project-brief.txt, line 2]',
    [{ ...original, start_line: 2, end_line: 2 }]);
  const lookup = await f.call('lookup', { query: 'Morgan Hale', type: 'person' });
  assert.equal(lookup.outcome, 'found');
  assert.equal(lookup.hits[0].record.id, person.receipt.id);
  const body = `# Orchid pilot\nThe provisional target is October 15, pending reliability review. ` +
    `[Source: project-brief.txt, lines 3–4]\n` +
    `Lead: [Morgan Hale](../${person.receipt.path}) (ID: ${person.receipt.id}).\n` +
    `Original: ${original.path}; SHA-256: ${original.sha256}.\n` +
    'The source contains an untrusted quoted command; it was not acted on.';
  const saved = await f.save('Orchid pilot brief', 'project', body, [original, locator]);
  assert.equal(saved.receipt.state, 'published');
  f.restart(); // Caller lost the response and the service was replaced.
  assert.equal((await f.call('mutation', { requestId: saved.input.requestId })).receipt.id, saved.receipt.id);
  assert.deepEqual(await f.call('save_page', saved.input), saved.receipt);
  assert.equal((await f.call('records')).total, 2);
  const read = await f.call('record', { includeEvidence: true, id: saved.receipt.id, evidenceLimit: 1 });
  assert.equal(read.record.body, body);
  assert.equal(read.nextEvidenceOffset, 1);
  const cited = await f.call('record', { includeEvidence: true, id: saved.receipt.id, evidenceOffset: read.nextEvidenceOffset });
  assert.equal(cited.evidence[0].verified, true);
  assert.ok(cited.evidence[0].excerpt.includes(locator.quote));
  const downloaded = await f.call('attachment', { id: saved.receipt.id, path: original.path, sha256: original.sha256 });
  assert.equal(downloaded.nextOffset, null);
  assert.deepEqual(Buffer.from(downloaded.data, 'base64'), bytes);
  assert.equal(original.sha256, digest(bytes));
  const result = await f.call('grep', { query: 'Orchid provisional' });
  assert.equal(result.index.state, 'ready');
  assert.equal(result.hits[0].record.id, saved.receipt.id);
  assert.equal(result.hits[0].citation.hash, read.record.hash);
  // An independent rerun uses source inspection to reuse the page, not another create.
  const existing = await f.call('lookup', { query: 'Orchid pilot brief' });
  const prior = await f.call('record', { includeEvidence: true, id: existing.hits[0].record.id });
  assert.equal(prior.evidence[0].sha256, original.sha256);
  assert.equal((await f.call('records')).total, 2);
});

test('meeting port: ambiguous identity, contradictory accounts, attributed correction and retained history', async t => {
  const f = await fixture(t);
  const brief = await f.attach(await source('project-brief.txt'), 'project-brief.txt');
  const transcriptBytes = await source('meeting-transcript.txt');
  // Exercise interrupted upload, not only publication replay.
  const cut = 93, upload = { requestId: randomUUID(), expectedVaultId: f.vaultId,
    filename: 'meeting-transcript.txt', mediaType: 'text/plain', attribution: 'Synthetic recorder export' };
  const first = { ...upload, offset: 0, data: transcriptBytes.subarray(0, cut).toString('base64'), final: false };
  assert.equal((await f.call('attach', first)).receivedBytes, cut);
  f.restart();
  assert.equal((await f.call('attach', first)).receivedBytes, cut);
  const transcript = (await f.call('attach', { ...upload, offset: cut,
    data: transcriptBytes.subarray(cut).toString('base64'), final: true })).evidence;
  await f.save('Alex Kim', 'person', 'Engineer at Northstar; identity candidate only.');
  await f.save('Alex Kim', 'person', 'Researcher at another organization; distinct person.');
  assert.equal((await f.call('lookup', { query: 'Alex Kim', type: 'person' })).outcome, 'ambiguous');
  const body = '# Orchid reliability review\n' +
    'Speaker 1 identifies as Morgan Hale. Speaker 2 remains unresolved; roster does not map tracks.\n' +
    'Decision: provisional target November 3, conditional on review, not a launch commitment. ' +
    '[Source: meeting-transcript.txt, lines 4–6]\n' +
    'This differs from the October 15 target in the older brief. [Source: project-brief.txt, lines 3–4]\n' +
    'Action: Speaker 2 offers to send the failure report Friday; owner identity unresolved. ' +
    '[Source: meeting-transcript.txt, line 5]\n' +
    'Chronology: the two build failures preceded the call, although discussed later. ' +
    '[Source: meeting-transcript.txt, line 7]\n' +
    'Recorder summary conflicts with the transcript; Alex attribution and tomorrow deadline are not verified.\n' +
    '> We have not committed to launch yet.\n[Source: meeting-transcript.txt, line 6]';
  const locators = [
    { ...brief, start_line: 3, end_line: 4 },
    { ...transcript, start_line: 4, end_line: 6 },
    { ...transcript, start_line: 6, end_line: 6, quote: 'We have not committed to launch yet.' },
    { ...transcript, start_line: 7, end_line: 7 },
  ];
  const saved = await f.save('Orchid reliability review 2026-09-23', 'meeting', body, [transcript, ...locators]);
  const read = await f.call('record', { includeEvidence: true, id: saved.receipt.id });
  assert.ok(read.evidence.every(e => e.verified));
  assert.ok(read.evidence.find(e => e.quote)?.excerpt.includes('We have not committed to launch yet.'));
  assert.equal((await f.call('records', { type: 'person' })).total, 2, 'No guessed third person');
  const correction = { requestId: randomUUID(), expectedVaultId: f.vaultId,
    id: read.record.id, expectedRevision: read.record.revision, expectedHash: read.record.hash,
    title: read.record.title,
    body: body + '\n## Attributed correction\nThe user identifies Speaker 2 as Alex Kim, the Northstar engineer. ' +
      'This updates the interpretation, not the original recorder export. [Source: user correction]',
    source: { text: 'Speaker 2 was Alex Kim, the Northstar engineer.', attribution: 'User correction in synthetic trial' } };
  const edited = await f.call('save_page', correction);
  assert.equal(edited.revision, 2);
  const current = await f.call('record', { includeEvidence: true, id: edited.id });
  assert.equal(current.evidenceTotal, 6);
  assert.ok(current.evidence.every(e => e.verified));
  assert.deepEqual(Buffer.from((await f.call('attachment', { id: edited.id,
    path: transcript.path, sha256: transcript.sha256 })).data, 'base64'), transcriptBytes);
  const history = await f.call('history', { id: edited.id });
  assert.equal(history.entries.length, 2);
  const previous = await f.call('revision', { sequence: history.entries.find(e => e.revision === 1).sequence });
  assert.ok(previous.raw.includes('Speaker 2 remains unresolved'));
  assert.ok(!previous.raw.includes('## Attributed correction'));
  const found = await f.call('grep', { query: 'Orchid November', type: 'meeting' });
  assert.equal(found.total, 1);
  assert.equal(found.hits[0].citation.hash, current.record.hash);
  assert.equal((await f.call('diagnostics')).total, 0);
});

for (const mode of ['document', 'meeting']) test(`${mode} structured workflow: source-dependent outputs, shared entity context and interrupted continuation`, async t => {
  const f = await fixture(t);
  const filename = mode === 'document' ? 'project-brief.txt' : 'meeting-transcript.txt';
  const evidence = await f.attach(await source(filename), filename);
  const fingerprint = (await f.call('ontology')).fingerprint;
  const person = (await f.save('Morgan Hale', 'person',
    `Morgan is identified in ${filename}. [Source: ${filename}]`, [evidence])).receipt;
  const project = (await f.save('Orchid', 'project',
    `Orchid pilot context. [Source: ${filename}]`, [evidence])).receipt;
  const saved = (await f.save(mode === 'meeting' ? 'Orchid review' : 'Orchid brief',
    mode === 'meeting' ? 'meeting' : 'note',
    `Source record. [Morgan](../${person.path}); [Orchid](../${project.path}).`, [evidence])).receipt;
  const common = { expectedVaultId: f.vaultId, expectedOntologyFingerprint: fingerprint,
    dependencies: [saved.id], attribution: `Synthetic trial, ${filename}` };
  const locator = (start, end = start) => ({ ...evidence, start_line: start, end_line: end });
  const claim = {
    ...common, requestId: randomUUID(),
    title: mode === 'meeting' ? 'Conditional November target' : 'Provisional October target',
    body: mode === 'meeting' ? 'Morgan reports a November 3 target, subject to reliability review; not a launch commitment.'
      : 'The October 15 target is provisional until reliability review.',
    claim_kind: mode === 'meeting' ? 'decision' : 'fact', assertion_origin: 'source',
    entities: [project.id], evidence: [mode === 'meeting' ? locator(4, 6) : locator(3, 4)],
  };
  const first = await f.call('create_claim', claim);
  f.restart(); // Lost response / interrupted workflow after only one assertion.
  const recovered = await f.call('mutation', { requestId: claim.requestId });
  assert.equal(recovered.receipt.id, first.id);
  assert.deepEqual(await f.call('create_claim', claim), first);
  // Authoritative reverse-dependency inspection accounts for completed work.
  const before = await f.call('connections', { id: saved.id, direction: 'dependents' });
  assert.deepEqual(before.connections.map(c => c.record.id), [first.id]);

  const edgeInput = { ...common, requestId: randomUUID(),
    title: mode === 'meeting' ? 'Morgan attended review' : 'Morgan leads Orchid',
    body: mode === 'meeting' ? 'Morgan self-identifies on the review recording.' : 'Morgan is the project lead.',
    from: person.id, to: mode === 'meeting' ? saved.id : project.id,
    label: mode === 'meeting' ? 'attended' : 'leads',
    evidence: [mode === 'meeting' ? locator(3) : locator(2)],
  };
  const edge = await f.call('create_relationship', edgeInput);
  const expectedIds = [first.id, edge.id];
  if (mode === 'meeting') {
    const commitment = await f.call('create_claim', { ...common, requestId: randomUUID(),
      title: 'Send failure report', body: 'Unresolved Speaker 2 offered to send the report Friday.',
      claim_kind: 'commitment', assertion_origin: 'source', attribution: 'Unresolved Speaker 2, line 5',
      entities: [project.id], evidence: [locator(5)] });
    const read = await f.call('record', { id: commitment.id, includeMetadata: true });
    assert.equal(read.record.metadata.owner, undefined, 'Roster is not a voice mapping');
    assert.equal(read.record.metadata.due_at, undefined, 'This trial retains the relative deadline in prose');
    const event = await f.call('create_claim', { ...common, requestId: randomUUID(),
      title: 'Orchid reliability review', body: 'Morgan discussed Orchid reliability at the review.',
      claim_kind: 'event', assertion_origin: 'source', occurred_at: '2026-09-23',
      entities: [person.id, project.id], evidence: [locator(1, 4)] });
    for (const id of [person.id, project.id]) {
      const connected = await f.call('connections', { id, direction: 'claims' });
      assert.ok(connected.connections.some(c => c.record.id === event.id), 'One shared event serves both entities');
    }
    expectedIds.push(commitment.id, event.id);
  }
  // Profile content back-links are explicit revision-fenced edits, not auto-links.
  for (const id of [person.id, project.id]) {
    const current = (await f.call('record', { id })).record;
    await f.call('save_page', { requestId: randomUUID(), expectedVaultId: f.vaultId,
      id, expectedRevision: current.revision, expectedHash: current.hash,
      title: current.title, body: current.body + `\n## Timeline\n- ${mode === 'meeting' ? '2026-09-23' : '2026-09-20'} | Referenced in [${mode}](../${saved.path}). [Source: ${filename}]` });
  }
  f.restart(); // A later rerun reconciles completed outputs; no new IDs needed.
  const observed = [];
  let offset = 0, snapshot;
  do {
    const page = await f.call('connections', { id: saved.id, direction: 'dependents', limit: 1, offset });
    if (snapshot) assert.equal(page.snapshot, snapshot);
    snapshot = page.snapshot;
    observed.push(...page.connections.map(c => c.record.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(observed.sort(), expectedIds.sort());
  assert.deepEqual(await f.call('create_relationship', edgeInput), edge);
  const out = await f.call('connections', { id: person.id, direction: 'outgoing' });
  const incoming = await f.call('connections', { id: edgeInput.to, direction: 'incoming' });
  assert.ok(out.connections.some(c => c.record.id === edge.id));
  assert.ok(incoming.connections.some(c => c.record.id === edge.id));
  for (const id of expectedIds) {
    const read = await f.call('record', { includeEvidence: true, id, includeMetadata: true });
    assert.ok(read.evidence.every(e => e.verified));
    assert.deepEqual(read.record.metadata.dependencies, [saved.id]);
    assert.equal((await f.call('lookup', { query: id })).outcome, 'found');
  }
  assert.equal((await f.call('records')).total, 3 + expectedIds.length);
  assert.equal((await f.call('diagnostics')).total, 0);
});
