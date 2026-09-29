import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, link, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { accessFor, apiFor } from './support.mjs';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { contract } from '../dist/contract.js';
import { keywordExpression } from '../dist/retrieval.js';
import { loadSearch } from '../dist/retrieval-view.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-retrieval-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'), sessionId = randomUUID();
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await mkdir(root); await mkdir(path.join(root, 'private')); await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true };
  const api = apiFor(base, config);
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.read'] } } };
  const service = createKnowledgeService(api), store = new SqliteIdentityStore(config.statePath);
  async function put(id, title, body, metadata = {}, partition = 'private') {
    const scope = partition === 'private' ? { visibility: 'private' } : { visibility: 'conversation', sessionId: partition.split('/')[1] };
    const envelope = { format: 'knowledge-record-v1', id, revision: 1, kind: 'page', title, scope, type: 'note', fields: {}, recorded_at: '2026-09-23T00:00:00Z', updated_at: '2026-09-23T00:00:00Z', lifecycle: 'active', ...metadata };
    const target = path.join(root, partition, 'notes', id + '.md'); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\n${stringify(envelope)}---\n${body}`); return target;
  }
  return { root, base, config, manifest, sessionId, api, owner, operator, service, store, put,
    group: () => { owner.tool.memoryAudience = { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId }; } };
}
const ids = result => result.hits.map(h => h.record.id);
const stable = value => JSON.parse(JSON.stringify(value), (k, v) => ['checkedAt', 'indexedAt'].includes(k) ? undefined : v);

test('UI and tool share FTS title/alias/body retrieval, literal modes and stable citation contracts', async t => {
  const f = await fixture(t);
  await f.put('record_alpha', 'Orchid title', 'A long introduction.\nA distinctive body marker.\n', { aliases: ['Purple flower'], tags: ['botany'] });
  for (const [query, field] of [['orchid', 'title'], ['purple flower', 'aliases'], ['distinctive', 'body']]) {
    const result = await f.service.grep({ query }, f.owner), ui = await f.service.grep({ query }, f.operator);
    assert.ok(Check(contract.operations.grep.output, result)); assert.deepEqual(stable(result), stable(ui));
    assert.equal(result.index.state, 'ready'); assert.equal(result.index.lag, false); assert.equal(result.total, 1); assert.deepEqual(result.hits[0].matches, [field]);
    const current = (await f.service.record({ id: 'record_alpha' }, f.owner)).record;
    assert.equal(result.hits[0].citation.hash, current.hash); assert.equal(result.hits[0].citation.revision, current.revision);
  }
  assert.equal((await f.service.grep({ query: 'orchid nonexistent', mode: 'all' }, f.owner)).total, 0);
  assert.equal((await f.service.grep({ query: 'orchid nonexistent', mode: 'any' }, f.owner)).total, 1);
  assert.equal((await f.service.grep({ query: 'distinctive body', mode: 'phrase' }, f.owner)).total, 1);
  assert.equal((await f.service.grep({ query: 'body distinctive', mode: 'phrase' }, f.owner)).total, 0);
  assert.equal((await f.service.grep({ query: 'flower', tag: 'wrong' }, f.owner)).total, 0);
  assert.equal((await f.service.grep({ query: 'flower', tag: 'botany', kind: 'page', type: 'note' }, f.owner)).total, 1);
});

test('exact ID/name/alias lookup normalizes names, exposes ambiguity and never selects arbitrarily', async t => {
  const f = await fixture(t);
  await f.put('record_alpha', 'Full Name', 'Body', { aliases: [' Shared Alias ', 'Ｃａｆｅ'] });
  await f.put('record_beta', 'Someone else', 'Body', { aliases: ['shared alias'] });
  for (const query of ['record_alpha', ' full   NAME ', 'cafe']) {
    const result = await f.service.lookup({ query }, f.owner);
    assert.ok(Check(contract.operations.lookup.output, result)); assert.equal(result.outcome, 'found'); assert.deepEqual(ids(result), ['record_alpha']);
  }
  assert.equal((await f.service.lookup({ query: 'Full' }, f.owner)).outcome, 'missing');
  assert.equal((await f.service.lookup({ query: 'RECORD_ALPHA' }, f.owner)).outcome, 'missing');
  const ambiguous = await f.service.lookup({ query: 'shared alias', limit: 1 }, f.owner);
  assert.equal(ambiguous.outcome, 'ambiguous'); assert.equal(ambiguous.total, 2); assert.equal(ambiguous.nextOffset, 1);
});

test('all saved records are discoverable regardless of legacy approval metadata; lifecycle filters still apply', async t => {
  const f = await fixture(t);
  await f.put('accepted_one', 'Orbit', 'short text');
  await f.put('candidate_one', 'Orbit', 'orbit '.repeat(1000), { acceptance: 'candidate' });
  await f.put('historical_one', 'Orbit', 'orbit history', { lifecycle: 'superseded' });
  const after = await f.service.grep({ query: 'orbit' }, f.owner);
  assert.deepEqual(ids(after).sort(), ['accepted_one', 'candidate_one']);
  assert.ok(after.hits.every(hit => !Object.hasOwn(hit.record, 'acceptance')));
  assert.deepEqual(ids(await f.service.grep({ query: 'orbit', lifecycle: 'superseded' }, f.owner)), ['historical_one']);
  assert.equal((await f.service.grep({ query: 'orbit', lifecycle: 'all' }, f.owner)).total, 3);
  assert.equal((await f.service.lookup({ query: 'candidate_one' }, f.owner)).outcome, 'found');
  assert.equal((await f.service.records({}, f.owner)).total, 2);
  assert.equal((await f.service.records({ lifecycle: 'all' }, f.owner)).total, 3);
});

test('scope isolates results, counts, exact identity, snippets, corpus statistics and cached projections', async t => {
  const f = await fixture(t), shared = `conversations/${f.sessionId}`;
  await f.put('shared_first', 'Comet', 'shared text', {}, shared);
  await f.put('shared_second', 'Other', 'comet tail', {}, shared);
  await f.put('private_record', 'PRIVATE SENTINEL', 'comet '.repeat(1000));
  await f.service.grep({ query: 'comet' }, f.owner); // private projection exists
  f.group(); const before = await f.service.grep({ query: 'comet' }, f.owner);
  await f.put('private_second', 'PRIVATE SECOND', 'comet '.repeat(2000));
  const after = await createKnowledgeService(f.api).grep({ query: 'comet' }, f.owner);
  assert.deepEqual(stable(after), stable(before)); assert.doesNotMatch(JSON.stringify(after), /PRIVATE|private_record|private_second/);
  assert.equal((await f.service.lookup({ query: 'PRIVATE SENTINEL' }, f.owner)).outcome, 'missing');
  await f.put('foreign_scope', 'PRIVATE SENTINEL', 'comet', { scope: { visibility: 'private' } }, shared);
  assert.doesNotMatch(JSON.stringify(await f.service.grep({ query: 'comet' }, f.owner)), /PRIVATE/);
});

test('invalid, duplicate, broken evidence and unavailable dependent records cannot leak through retrieval', async t => {
  const f = await fixture(t);
  const good = await f.put('duplicate_one', 'DUPLICATE SENTINEL', 'secretword');
  await writeFile(path.join(path.dirname(good), 'duplicate.md'), await readFile(good));
  await f.put('invalid_one', 'INVALID SENTINEL', 'secretword', { type: 'unrecognized' });
  await f.put('broken_evidence', 'EVIDENCE SENTINEL', 'secretword', { evidence: [{ path: 'artifacts/missing.txt', sha256: '0'.repeat(64), start_line: 1, end_line: 1 }] });
  await f.put('dependent_one', 'DEPENDENT SENTINEL', 'secretword', { dependencies: ['invalid_one'] });
  await f.put('dependent_two', 'TRANSITIVE SENTINEL', 'secretword', { dependencies: ['dependent_one'] });
  const result = await f.service.grep({ query: 'secretword' }, f.owner);
  assert.equal(result.total, 0); assert.equal(result.coverage.complete, false); assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
  for (const query of ['duplicate_one', 'INVALID SENTINEL', 'EVIDENCE SENTINEL', 'DEPENDENT SENTINEL']) assert.equal((await f.service.lookup({ query }, f.owner)).outcome, 'missing');
});

test('observed withdrawals persist across stale-file reappearance, restart and projection rebuild', async t => {
  const f = await fixture(t), target = await f.put('withdrawn_one', 'Withdraw this', 'secretword');
  const stale = await readFile(target, 'utf8');
  await f.put('dependent_one', 'Derived prose', 'secretword', { dependencies: ['withdrawn_one'] });
  assert.equal((await f.service.grep({ query: 'secretword' }, f.owner)).total, 2);
  await writeFile(target, stale.replace('lifecycle: active', 'lifecycle: withdrawn'));
  // Any normal scoped scan records the operational safeguard, not only search.
  await f.service.records({}, f.owner);
  await writeFile(target, stale);
  f.store.withDatabase(db => { for (const row of db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'").all()) db.exec(`DROP TABLE ${row.name}`); });
  const service = createKnowledgeService(f.api);
  const result = await service.grep({ query: 'secretword', lifecycle: 'all' }, f.owner);
  assert.equal(result.total, 0); assert.equal((await service.lookup({ query: 'withdrawn_one', lifecycle: 'all' }, f.owner)).outcome, 'missing');
});

test('external edits, rename, deletion, malformed replacement and ontology changes replace the projection', async t => {
  const f = await fixture(t); let target = await f.put('editable_one', 'Oldname', 'oldword');
  const before = await f.service.grep({ query: 'oldword' }, f.owner);
  await writeFile(target, (await readFile(target, 'utf8')).replace('oldword', 'newword'));
  await rename(target, target + '-renamed.md'); target += '-renamed.md';
  assert.equal((await f.service.grep({ query: 'oldword' }, f.owner)).total, 0);
  const changed = await f.service.grep({ query: 'newword' }, f.owner);
  assert.notEqual(changed.index.snapshot, before.index.snapshot); assert.match(changed.hits[0].citation.path, /renamed/); assert.equal(changed.hits[0].citation.revision, 2);
  await writeFile(target, 'malformed newword');
  assert.equal((await f.service.grep({ query: 'newword' }, f.owner)).total, 0);
  await f.put('editable_two', 'Newname', 'newword');
  assert.equal((await f.service.grep({ query: 'newword' }, f.owner)).total, 1);
  await writeFile(path.join(f.root, 'private', 'ontology.yaml'), 'not: a valid ontology');
  assert.equal((await f.service.grep({ query: 'newword' }, f.owner)).total, 0);
  await rm(path.join(f.root, 'private', 'ontology.yaml')); await rm(path.join(f.root, 'private', 'notes', 'editable_two.md'));
  assert.equal((await f.service.grep({ query: 'newword' }, f.owner)).total, 0);
});

test('failed index updates return unavailable, not empty/stale; exact lookup and listing still work; retry rebuilds', async t => {
  const f = await fixture(t), target = await f.put('editable_one', 'Known identity', 'oldword');
  assert.equal((await f.service.grep({ query: 'oldword' }, f.owner)).total, 1);
  f.store.withDatabase(db => db.exec("CREATE TRIGGER fail_keyword BEFORE INSERT ON keyword_state_v1 BEGIN SELECT RAISE(ABORT,'injected indexing failure'); END"));
  await writeFile(target, (await readFile(target, 'utf8')).replace('oldword', 'newword'));
  const failed = await f.service.grep({ query: 'oldword' }, f.owner);
  assert.ok(Check(contract.operations.grep.output, failed)); assert.equal(failed.index.state, 'unavailable'); assert.equal(failed.total, null); assert.deepEqual(failed.hits, []);
  assert.equal((await f.service.lookup({ query: 'Known identity' }, f.owner)).outcome, 'found'); assert.equal((await f.service.records({}, f.owner)).total, 1);
  f.store.withDatabase(db => db.exec('DROP TRIGGER fail_keyword'));
  assert.equal((await f.service.grep({ query: 'newword' }, f.owner)).total, 1);
  assert.equal((await f.service.grep({ query: 'oldword' }, f.owner)).total, 0);
});

test('identity mismatch and revoked authority reject retrieval without cached fallback', async t => {
  const f = await fixture(t); await f.put('private_record', 'PRIVATE SENTINEL', 'secretword');
  await f.service.grep({ query: 'secretword' }, f.owner);
  const revoked = { ...f.owner, tool: { ...f.owner.tool, assertInvocationCurrent() { throw Error('revoked'); } } };
  for (const op of ['grep', 'lookup']) await assert.rejects(f.service[op]({ query: 'secretword' }, revoked), /revoked/);
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify({ ...f.manifest, generation: 1, publicationId: randomUUID() }));
  for (const op of ['grep', 'lookup']) await assert.rejects(f.service[op]({ query: 'secretword' }, f.owner), /identity/);
});

test('hardlinks and symlinks cannot import another scope into the keyword corpus', async t => {
  const f = await fixture(t), target = await f.put('private_record', 'PRIVATE SENTINEL', 'secretword');
  const shared = path.join(f.root, 'conversations', f.sessionId); await mkdir(shared, { recursive: true });
  await link(target, path.join(shared, 'hardlink.md')); await symlink(target, path.join(shared, 'symlink.md'));
  f.group(); const result = await f.service.grep({ query: 'secretword' }, f.owner);
  assert.equal(result.total, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('bounded contextual snippets have truthful original Markdown lines', async t => {
  const f = await fixture(t), body = `${'Introduction\n'.repeat(100)}rareword <script>alert('unsafe')</script>\n${'tail 😀\n'.repeat(200)}`;
  const target = await f.put('snippet_record', 'Long record', body), raw = await readFile(target, 'utf8');
  const result = await f.service.grep({ query: 'rareword' }, f.owner), hit = result.hits[0], snippet = hit.snippet;
  assert.equal(snippet.field, 'body'); assert.match(snippet.text, /rareword/); assert.ok(snippet.text.length <= 480); assert.equal(snippet.truncated, true);
  assert.equal(snippet.text, body.slice(snippet.start, snippet.end));
  assert.ok(raw.split('\n').slice(snippet.startLine - 1, snippet.endLine).join('\n').includes(snippet.text));
  assert.ok(Check(contract.operations.grep.output, result));
});

test('FTS operators are literal words, malformed/oversized input is rejected, Unicode terms work', async t => {
  const f = await fixture(t); await f.put('unicode_record', 'Café project', 'alpha OR beta 東京');
  assert.equal((await f.service.grep({ query: 'cafe' }, f.owner)).total, 1);
  assert.equal((await f.service.grep({ query: '東京' }, f.owner)).total, 1);
  assert.equal(keywordExpression({ query: 'alpha OR beta' }), '"alpha" AND "OR" AND "beta"');
  for (const query of ['', '   ', '***', 'a '.repeat(65), 'a'.repeat(501)]) await assert.rejects(f.service.grep({ query }, f.owner), /input|tokens/);
  for (const query of ['"', 'column:missing', 'NEAR(alpha)', 'alpha\") OR 1=1 --']) {
    if (query === '"') { await assert.rejects(f.service.grep({ query }, f.owner)); continue; }
    assert.equal((await f.service.grep({ query }, f.owner)).index.state, 'ready');
  }
  for (const field of [{ scope: 'private' }, { agentId: 'main' }, { lifecycle: 'withdrawn' }, { mode: 'regex' }]) assert.equal(Check(contract.operations.grep.input, { query: 'cafe', ...field }), false);
});

test('ranking emphasizes titles, deterministic pagination and scoped index reuse', async t => {
  const f = await fixture(t); await f.put('title_record', 'Needle', 'text'); await f.put('body_record', 'Other', 'needle');
  const first = await f.service.grep({ query: 'needle', limit: 1 }, f.owner);
  assert.deepEqual(ids(first), ['title_record']); assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  const next = await f.service.grep({ query: 'needle', limit: 1, offset: 1 }, f.owner);
  assert.deepEqual(ids(next), ['body_record']); assert.equal(next.nextOffset, null); assert.equal(next.index.snapshot, first.index.snapshot); assert.equal(next.index.indexedAt, first.index.indexedAt);
});

test('native search client passes explicit typed mode and filters to the shared operations', async () => {
  const calls = [], feature = { invoke: async (name, input) => { calls.push({ name, input }); return {}; } };
  const state = { query: 'name', mode: 'phrase', lifecycle: 'active', kind: 'page', type: 'person', tag: 'team', offset: 20 };
  await loadSearch(feature, state); await loadSearch(feature, { ...state, mode: 'exact' });
  assert.equal(calls[0].name, 'grep'); assert.equal(calls[0].input.mode, 'phrase'); assert.equal(calls[0].input.acceptance, undefined); assert.equal(calls[0].input.offset, 20);
  assert.equal(calls[1].name, 'lookup'); assert.equal(calls[1].input.mode, undefined);
  for (const { name, input } of calls) assert.ok(Check(contract.operations[name].input, input));
});

test('published pages are immediately searchable without approval; restored generations cannot serve a newer index', async t => {
  const f = await fixture(t), api = { ...f.api, pluginConfig: { operatorRead: true, writesEnabled: true } }, service = createKnowledgeService(api);
  const receipt = await service.save_page({ requestId: randomUUID(), title: 'Fresh publication', type: 'note', body: 'newlypublishedword', source: { text: 'Original source\nSecond line', attribution: 'User note' } }, f.owner);
  assert.equal(receipt.state, 'published'); assert.equal(receipt.indexed, false); assert.match(receipt.message, /pending/);
  const indexed = await service.grep({ query: 'newlypublishedword' }, f.owner);
  assert.equal(indexed.index.state, 'ready'); assert.equal(indexed.total, 1); assert.equal(indexed.hits[0].citation.hash, receipt.hash);
  assert.equal(indexed.hits[0].evidence.length, 1); assert.equal(indexed.hits[0].evidence[0].start_line, 1); assert.equal(indexed.hits[0].attribution, 'User note');
  assert.equal((await service.lookup({ query: receipt.id }, f.owner)).outcome, 'found');
  const raw = (await service.record({ id: receipt.id, view: 'raw' }, f.owner)).record.raw;
  assert.doesNotMatch(raw, /acceptance:/);
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify(f.manifest));
  for (const op of ['grep', 'lookup']) await assert.rejects(service[op]({ query: 'newlypublishedword' }, f.owner), /identity/);
});

test('empty conversations return a ready empty scope without materializing a directory', async t => {
  const f = await fixture(t); await f.put('private_record', 'PRIVATE', 'privateword'); f.group();
  const result = await f.service.grep({ query: 'privateword' }, f.owner);
  assert.equal(result.index.state, 'ready'); assert.equal(result.total, 0); assert.equal(result.coverage.complete, true);
  assert.equal((await f.service.lookup({ query: 'PRIVATE' }, f.owner)).outcome, 'missing');
  await assert.rejects(readFile(path.join(f.root, 'conversations', f.sessionId)), { code: 'ENOENT' });
});


test('editing a legacy page removes approval metadata through journaled publication and preserves authored material', async t => {
  const f = await fixture(t);
  await f.put('legacy_record', 'Legacy page', 'Original body', { acceptance: 'candidate', custom_note: 'Preserve me' });
  const api = { ...f.api, pluginConfig: { operatorRead: true, writesEnabled: true } }, service = createKnowledgeService(api);
  const previous = (await service.record({ id: 'legacy_record', includeMetadata: true }, f.owner)).record;
  const receipt = await service.save_page({ requestId: randomUUID(), id: previous.id, expectedRevision: previous.revision, expectedHash: previous.hash, title: previous.title, body: previous.body }, f.owner);
  assert.equal(receipt.state, 'published');
  const current = (await service.record({ id: previous.id, view: 'raw', includeMetadata: true }, f.owner)).record;
  assert.doesNotMatch(current.raw, /acceptance:/);
  assert.equal(current.metadata.custom_note, 'Preserve me');
  assert.equal(current.revision, previous.revision + 1);
  assert.equal((await service.grep({ query: 'Original body' }, f.owner)).total, 1);
  for (const op of ['grep', 'lookup']) assert.equal(Check(contract.operations[op].input, { query: 'Legacy', acceptance: 'candidate' }), false);
});

test('an index built before row tracking is repopulated, never left empty and ready', async t => {
  const f = await fixture(t);
  await f.put('upgrade_note_1', 'Upgrade sentinel', 'lanternword body');
  assert.equal((await f.service.grep({ query: 'lanternword' }, f.owner)).total, 1);
  // Simulate the previous version: FTS rows and a matching state row, no tracking table.
  f.store.withDatabase(db => { for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'keyword_rows_v1_%'").all()) db.exec(`DROP TABLE ${name}`); });
  assert.equal((await f.service.grep({ query: 'lanternword' }, f.owner)).total, 1);
});
