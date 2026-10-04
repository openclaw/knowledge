import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { returnedRecords } from '../dist/session-activity.js';
import { dateInterval, timeBounds } from '../dist/temporal-query.js';
import { hostApi, storeFixture, toolContext, operatorContext } from './support.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-chronicle-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const f = await storeFixture(base, { policy: { writesEnabled: true, operatorRead: true } });
  const owner = toolContext(f.api), operator = operatorContext(f.api, ['operator.read']);
  const service = createKnowledgeService(f.api);
  const artifact = 'Source says the review occurred and the task was accepted.\n';
  const evidence = [{ path: 'artifacts/source.txt', sha256: createHash('sha256').update(artifact).digest('hex'), start_line: 1, end_line: 1 }];
  async function put(id, metadata = {}, partition = 'private', body = 'Launch review evidence') {
    const kind = metadata.kind ?? 'page', type = metadata.type ?? 'note';
    const dir = kind === 'claim' ? 'claims' : type === 'meeting' ? 'meetings' : type === 'person' ? 'people' : 'notes';
    await mkdir(path.join(f.root, partition, 'artifacts'), { recursive: true });
    await writeFile(path.join(f.root, partition, 'artifacts/source.txt'), artifact);
    const m = { format: 'knowledge-record-v1', id, revision: 1, kind, type,
      title: id, fields: {}, scope: partition === 'private' ? { visibility: 'private' } : { visibility: 'conversation', sessionId: partition.split('/')[1] },
      recorded_at: '2026-10-04T12:00:00Z', updated_at: '2026-10-04T12:00:00Z', lifecycle: 'active',
      ...(kind === 'claim' ? { claim_kind: 'event', assertion_origin: 'source', attribution: 'Retained source', evidence } : {}), ...metadata };
    const file = path.join(f.root, partition, dir, id + '.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '---\n' + stringify(m) + '---\n' + body);
    return file;
  }
  return { ...f, owner, operator, service, put };
}
const ids = r => r.items.map(x => x.record.id);
const event = (occurred_at, more = {}) => ({ kind: 'claim', occurred_at, ...more });

test('date validation, inclusive UTC days and date-only precision', () => {
  assert.throws(() => dateInterval('2025-02-29'), /real/);
  assert.throws(() => dateInterval('2026-10-04T12:00:00'), /timezone/);
  assert.throws(() => timeBounds({ since: '2026-10-05', until: '2026-10-04' }), /since/);
  assert.equal(dateInterval('2026-10-04').end, Date.parse('2026-10-04T23:59:59.999Z'));
  assert.equal(dateInterval('2026-10-04T12:00:00-07:00').start, Date.parse('2026-10-04T19:00:00Z'));
});

test('late imports distinguish occurrence, recording, update and due dates before search/list pagination', async t => {
  const f = await fixture(t);
  await f.put('meeting_old', { type: 'meeting', fields: { occurred_at: '2020-05-10' } });
  await f.put('event_old', event('2020-05-10', { dependencies: ['meeting_old'] }));
  await f.put('task_due', { ...event('2020-05-10'), claim_kind: 'commitment', due_at: '2026-10-05' });
  await f.put('undated_note', {}, 'private', 'Launch review\n## Timeline\n- **2020-05-10** | Markdown-only date');
  const old = await f.service.timeline({ since: '2020-05-10', until: '2020-05-10' }, f.owner);
  assert.ok(Check(contract.operations.timeline.output, old));
  assert.deepEqual(ids(old).sort(), ['event_old', 'meeting_old', 'task_due']);
  assert.ok(old.items.every(row => row.date === '2020-05-10' && row.precision === 'day'));
  assert.equal((await f.service.timeline({ since: '2026-10-04' }, f.owner)).total, 0);
  assert.equal((await f.service.timeline({ timeField: 'recorded_at', since: '2026-10-04' }, f.owner)).total, 4);
  assert.deepEqual(ids(await f.service.timeline({ timeField: 'due_at', since: '2026-10-05', until: '2026-10-05' }, f.owner)), ['task_due']);
  const search = await f.service.grep({ query: 'launch', since: '2020-05-10', until: '2020-05-10', limit: 1 }, f.owner);
  assert.equal(search.total, 3); assert.equal(search.hits.length, 1);
  assert.equal((await f.service.records({ timeField: 'recorded_at', since: '2026-10-04' }, f.owner)).total, 4);
  assert.equal((await f.service.records({ timeField: 'due_at', until: '2026-10-05' }, f.owner)).total, 1);
  await assert.rejects(f.service.grep({ query: 'launch', since: 'nonsense' }, f.owner));
  await assert.rejects(f.service.records({ since: '2026-02-30' }, f.owner));
});

test('day/week queries honor IANA zones and retain literal date-only dates', async t => {
  const f = await fixture(t);
  await f.put('event_instant', event('2026-10-04T01:30:00Z'));
  await f.put('event_calendar', event('2026-10-04'));
  await f.put('event_monday', event('2026-09-28'));
  const west = await f.service.chronicle_day({ date: '2026-10-03', timezone: 'America/Los_Angeles' }, f.owner);
  assert.deepEqual(ids(west), ['event_instant']);
  assert.deepEqual(ids(await f.service.chronicle_day({ date: '2026-10-04', timezone: 'America/Los_Angeles' }, f.owner)), ['event_calendar']);
  const week = await f.service.chronicle_day({ date: '2026-10-04', week: true }, f.owner);
  assert.equal(week.total, 3); assert.ok(Check(contract.operations.chronicle_day.output, week));
  await assert.rejects(f.service.chronicle_day({ date: '2026-02-30' }, f.owner));
  await assert.rejects(f.service.chronicle_day({ date: '2026-10-04', timezone: 'Not/AZone' }, f.owner));
});

test('one shared source-event claim folds its meeting while preserving separate events and entity scope', async t => {
  const f = await fixture(t);
  await f.put('person_alice', { type: 'person' }); await f.put('person_bobby', { type: 'person' });
  await f.put('meeting_shared', { type: 'meeting', fields: { occurred_at: '2020-05-10' } });
  await f.put('event_shared', event('2020-05-10', { entities: ['person_alice', 'person_bobby'], source_page: 'meeting_shared', source_event: true, dependencies: ['meeting_shared'] }));
  await f.put('event_followup', event('2020-05-11', { entities: ['person_alice'], source_page: 'meeting_shared', dependencies: ['meeting_shared'] }));
  const all = await f.service.chronicle_since({ since: '2020-05-01' }, f.owner);
  assert.deepEqual(ids(all), ['event_shared', 'event_followup']);
  assert.deepEqual(ids(await f.service.timeline({ entity: 'person_bobby' }, f.owner)), ['event_shared']);
  assert.deepEqual(ids(await f.service.timeline({ kind: 'meeting' }, f.owner)), ['meeting_shared']);
  const last = await f.service.chronicle_last_seen({ entity: 'person_alice', occurredOnOrBefore: '2020-05-10' }, f.owner);
  assert.ok(Check(contract.operations.chronicle_last_seen.output, last)); assert.equal(last.last.record.id, 'event_shared');
  assert.equal((await f.service.chronicle_last_seen({ entity: 'missing_entity' }, f.owner)).last, null);
});

test('scope, withdrawn dependencies, fixture exclusion and historical eligibility precede counts', async t => {
  const f = await fixture(t), sessionId = randomUUID(), partition = 'conversations/' + sessionId;
  await f.put('event_private', event('2020-05-10'));
  await f.put('event_shared', event('2020-05-10'), partition);
  await f.put('event_fixture', event('2020-05-10', { record_class: 'fixture' }), partition);
  await f.put('event_superseded', event('2020-05-10', { lifecycle: 'superseded' }), partition);
  await f.put('event_expired', event('2020-05-10', { expires_at: '2020-06-01T00:00:00Z' }), partition);
  await f.put('withdrawn_page', { lifecycle: 'withdrawn' }, partition);
  await f.put('event_hidden', event('2020-05-10', { dependencies: ['withdrawn_page'] }), partition);
  const group = toolContext(f.api, 'main', { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId });
  await f.service.timeline({}, f.owner);
  const result = await f.service.timeline({}, group);
  assert.deepEqual(ids(result), ['event_shared']);
  assert.doesNotMatch(JSON.stringify(result), /event_private|event_hidden|event_fixture/);
  assert.equal((await f.service.timeline({ eligibility: "include_inactive" }, group)).total, 3);
  assert.equal((await f.service.timeline({ entity: 'withdrawn_page', eligibility: "include_inactive" }, group)).total, 0);
});

test('pagination detects edits, external changes reconcile, partial index loss rebuilds', async t => {
  const f = await fixture(t);
  await f.put('event_first', event('2020-01-01'));
  const second = await f.put('event_second', event('2020-01-02'));
  const page = await f.service.timeline({ order: 'asc', limit: 1 }, f.owner);
  assert.equal(page.nextOffset, 1);
  assert.deepEqual(ids(await f.service.timeline({ order: 'asc', offset: page.nextOffset, snapshot: page.snapshot, limit: 1 }, f.owner)), ['event_second']);
  const raw = await readFile(second, 'utf8');
  await writeFile(second, raw.replace('2020-01-02', '2019-01-02'));
  await assert.rejects(f.service.timeline({ offset: 1, snapshot: page.snapshot }, f.owner), /changed/);
  const revised = await f.service.timeline({ order: 'asc' }, f.owner);
  assert.deepEqual(ids(revised), ['event_second', 'event_first']);
  const db = new DatabaseSync(f.config.statePath);
  t.after(() => db.close());
  db.exec('DROP TABLE temporal_dates_v1');
  assert.deepEqual(ids(await f.service.timeline({ order: 'asc' }, f.owner)), ids(revised));
  await rm(second);
  assert.equal((await f.service.timeline({}, f.owner)).total, 1);
});

test('normal publication is visible without a watcher and UI/tool contracts agree', async t => {
  const f = await fixture(t);
  const receipt = await f.service.save_page({ requestId: randomUUID(), title: 'Historical launch review', body: 'Historical meeting notes', type: 'meeting', fields: { occurred_at: '2020-05-10' } }, f.owner);
  const a = await f.service.chronicle_day({ date: '2020-05-10' }, f.owner);
  const b = await f.service.chronicle_day({ date: '2020-05-10' }, f.operator);
  assert.deepEqual(ids(a), [receipt.id]); assert.deepEqual(ids(a), ids(b));
  assert.equal(a.snapshot, b.snapshot);
  assert.ok(Check(contract.operations.chronicle_day.output, a));
});


test('partial projection recovery rebuilds every scope, not just the first reader', async t => {
  const f = await fixture(t), sessionId = randomUUID();
  await f.put('person_private', { type: 'person' });
  await f.put('event_private', event('2020-01-01', { entities: ['person_private'] }));
  await f.put('person_shared', { type: 'person' }, 'conversations/' + sessionId);
  await f.put('event_shared', event('2020-01-01', { entities: ['person_shared'] }), 'conversations/' + sessionId);
  const group = toolContext(f.api, 'main', { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId });
  assert.equal((await f.service.timeline({ entity: 'person_private' }, f.owner)).total, 1);
  assert.equal((await f.service.timeline({ entity: 'person_shared' }, group)).total, 1);
  const db = new DatabaseSync(f.config.statePath); t.after(() => db.close());
  for (const table of ['temporal_dates_v1', 'temporal_entities_v1']) {
    db.exec('DROP TABLE ' + table);
    assert.equal((await f.service.timeline({ entity: 'person_private' }, f.owner)).total, 1);
    assert.equal((await f.service.timeline({ entity: 'person_shared' }, group)).total, 1);
  }
});

test('high precision storage dates remain queryable and equivalent source instants fold', async t => {
  const f = await fixture(t);
  await f.put('note_precise', { recorded_at: '2026-10-04T12:00:00.123456Z', updated_at: '2026-10-04T12:00:00.123456Z' });
  for (const timeField of ['recorded_at', 'updated_at']) {
    assert.equal((await f.service.timeline({ timeField, since: '2026-10-04' }, f.owner)).total, 1);
    assert.equal((await f.service.records({ timeField, since: '2026-10-04' }, f.owner)).total, 1);
    assert.equal((await f.service.grep({ query: 'launch', timeField, since: '2026-10-04' }, f.owner)).total, 1);
  }
  await f.put('meeting_offset', { type: 'meeting', fields: { occurred_at: '2020-01-01T12:00:00Z' } });
  await f.put('event_offset', event('2020-01-01T05:00:00-07:00', { source_page: 'meeting_offset', source_event: true, dependencies: ['meeting_offset'] }));
  assert.deepEqual(ids(await f.service.timeline({}, f.owner)), ['event_offset']);
  const sessionId = randomUUID(), sessionKey = 'agent:main:chronicle-test';
  const caller = { ...f.owner, toolCallId: randomUUID(), tool: { ...f.owner.tool, sessionId, sessionKey } };
  const last = await f.service.chronicle_last_seen({ entity: 'meeting_offset' }, caller);
  const activity = await f.service.session_activity({ sessionId, sessionKey }, f.operator);
  assert.equal(activity.items[0].operation, 'chronicleLastSeen');
  assert.equal(activity.items[0].id, 'event_offset');
  assert.deepEqual(returnedRecords(last), [{ id: 'event_offset', revision: last.last.record.revision }]);
  await assert.rejects(f.service.chronicle_since({}, f.owner), /Invalid/);
});

test('unprovisioned operator temporal reads stay empty without creating storage', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-chronicle-empty-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const f = hostApi(base, { policy: { operatorRead: true } }), service = createKnowledgeService(f.api), operator = operatorContext(f.api, ['operator.read']);
  for (const [op, input] of [['timeline', {}], ['chronicle_day', { date: '2026-10-04' }], ['chronicle_since', { since: '2026-10-04' }], ['chronicle_last_seen', { entity: 'person_missing' }]]) {
    const result = await service[op](input, operator);
    assert.ok(Check(contract.operations[op].output, result));
    assert.equal(op === 'chronicle_last_seen' ? result.last : result.total, op === 'chronicle_last_seen' ? null : 0);
  }
  assert.equal((await service.status({}, operator)).store, 'unprovisioned');
  await assert.rejects(service.chronicle_day({ date: '2026-10-04', timezone: 'Not/AZone' }, operator));
  await assert.rejects(service.timeline({ since: '2026-02-30' }, operator));
  await assert.rejects(service.chronicle_since({}, operator));
});

test('source summaries are page-local, deduplicated, snapshot fenced and lifecycle aware', async t => {
  const f = await fixture(t);
  await f.put('person_alice', { type: 'person' });
  await f.put('meeting_shared', { type: 'meeting', title: 'Shared source', fields: { occurred_at: '2020-05-10' } });
  await f.put('event_current', event('2020-05-10', { entities: ['person_alice'], source_page: 'meeting_shared' }));
  await f.put('event_previous', event('2020-05-09', { lifecycle: 'superseded', superseded_by: 'event_current', entities: ['person_alice'], source_page: 'meeting_shared' }));
  const input = { entity: 'person_alice', includeSources: true, eligibility: 'include_inactive', limit: 1 };
  const first = await f.service.timeline(input, f.owner);
  assert.equal(first.sources.length, 1); assert.equal(first.sources[0].title, 'Shared source');
  assert.equal(first.items[0].record.lifecycle, 'active');
  assert.ok(Check(contract.operations.timeline.output, first));
  const second = await f.service.timeline({ ...input, offset: first.nextOffset, snapshot: first.snapshot }, f.owner);
  assert.equal(second.items[0].record.lifecycle, 'superseded');
  assert.equal(second.items[0].record.supersededBy, 'event_current');
  assert.equal(second.sources.length, 1); assert.equal(second.nextOffset, null);
  await assert.rejects(f.service.timeline({ ...input, includeSources: false, snapshot: first.snapshot }, f.owner), /restart/);
  const both = await f.service.timeline({ ...input, limit: 100 }, f.owner);
  assert.equal(both.sources.length, 1);
  assert.equal((await f.service.timeline({ entity: 'person_alice' }, f.owner)).sources, undefined);
  const last = await f.service.chronicle_last_seen({ entity: 'person_alice', occurredOnOrBefore: '2020-05-09', eligibility: 'include_inactive', includeSources: true }, f.owner);
  assert.equal(last.last.record.id, 'event_previous'); assert.equal(last.sources[0].id, 'meeting_shared');
  assert.deepEqual(last.selection, { timeField: 'occurred_at', onOrBefore: '2020-05-09', eligibility: 'include_inactive' });
  assert.ok(Check(contract.operations.chronicle_last_seen.output, last));
  for (const bad of [{ historical: true }, { asOf: '2020-01-01' }]) {
    await assert.rejects(f.service.chronicle_last_seen({ entity: 'person_alice', ...bad }, f.owner), /Invalid/);
  }
  await assert.rejects(f.service.timeline({ historical: true }, f.owner), /Invalid/);
});

test('temporal source summaries fit the full response budget and never skip rows', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 35; i++) {
    const n = String(i).padStart(3, '0');
    await f.put('meeting_' + n, { type: 'meeting', title: '🌱'.repeat(90), fields: { occurred_at: '2020-05-10' } });
    await f.put('event_' + n, event('2020-05-10', { source_page: 'meeting_' + n, source_event: true }), 'private', '🌱'.repeat(1000));
  }
  const input = { includeSources: true, limit: 100 };
  let page = await f.service.timeline(input, f.owner), all = [];
  assert.ok(page.nextOffset !== null);
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1024);
    assert.equal(page.sources.length, page.items.length);
    assert.ok(page.sources.every(s => page.items.some(i => i.sourcePage === s.id)));
    all.push(...ids(page));
    if (page.nextOffset === null) break;
    page = await f.service.timeline({ ...input, offset: page.nextOffset, snapshot: page.snapshot }, f.owner);
  }
  assert.equal(all.length, 35); assert.equal(new Set(all).size, 35);
});

test('query freshness distinguishes reused scans and query execution without legacy query fields', async t => {
  const f = await fixture(t); await f.put('event_current', event('2020-05-10'));
  for (const [method, input] of [['timeline', {}], ['records', {}], ['lookup', { query: 'event_current' }], ['grep', { query: 'launch' }]]) {
    const result = await f.service[method](input, f.owner);
    assert.equal(result.checkedAt, undefined);
    assert.ok(Date.parse(result.freshness.queriedAt) >= Date.parse(result.freshness.scannedAt));
    assert.ok(Check(contract.operations[method].output, result));
    if (method === 'grep') { assert.ok(result.freshness.indexedAt); assert.equal(result.index.indexedAt, undefined); }
  }
});
