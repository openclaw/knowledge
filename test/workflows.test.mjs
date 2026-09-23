import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import plugin from '../dist/index.js';
import { contract } from '../dist/contract.js';

// A public feature/session-action adapter over the real storage implementation.
// Model reasoning is not simulated: these are contract trials of authored output.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-workflows-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'), vaultId = randomUUID(), publicationId = randomUUID();
  await mkdir(path.join(root, 'private'), { recursive: true });
  await writeFile(path.join(root, 'vault.json'), JSON.stringify({
    format: 'knowledge-vault-v1', vaultId, agentId: 'main', generation: 0, publicationId,
  }));
  const pluginConfig = { vault: { root, statePath: path.join(base, 'state.sqlite'),
    agentId: 'main', vaultId, publicationId, operatorRead: true, writesEnabled: true } };
  let actions;
  function restart() {
    actions = new Map();
    plugin.register({ id: 'knowledge', pluginConfig, registerService() {}, registerTool() {},
      registerSessionAction(action) { actions.set(action.id, action); } });
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
  const read = await f.call('record', { id: saved.receipt.id, evidenceLimit: 1 });
  assert.equal(read.record.body, body);
  assert.equal(read.nextEvidenceOffset, 1);
  const cited = await f.call('record', { id: saved.receipt.id, evidenceOffset: read.nextEvidenceOffset });
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
  const prior = await f.call('record', { id: existing.hits[0].record.id });
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
  const read = await f.call('record', { id: saved.receipt.id });
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
  const current = await f.call('record', { id: edited.id });
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
