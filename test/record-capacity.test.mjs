import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { PublicationFiles } from '../dist/publication-files.js';
import { RECORD_MAX_BYTES } from '../dist/limits.js';
import { readText } from '../dist/files.js';
import { inspectRecord } from '../dist/inspection.js';
import { contract } from '../dist/contract.js';
import { textWindow } from '../dist/text-window.js';
import { withinBudget } from '../dist/response-budget.js';

import { capacityFixture } from './capacity-support.mjs';

test('near-limit records scan, publish annotations, retain history and page recovery without large responses', async t => {
  const f = await capacityFixture(t, RECORD_MAX_BYTES - 2000);
  const before = await f.record(); assert.ok(before.valid); assert.ok(Buffer.byteLength(before.raw) > 4900000);
  const changed = await f.storage.annotate({ requestId: randomUUID(), id: before.id, expectedRevision: before.revision,
    expectedHash: before.hash, reason: 'Classify synthetic fixture', annotations: { record_class: 'fixture' } }, f.access, 'agent');
  assert.equal(changed.state, 'published'); assert.equal((await f.record()).body, before.body);
  const head = f.storage.history(f.access, { id: before.id }).entries[0];
  let offset = 0, restored = '';
  do {
    const page = f.storage.revision(f.access, head.sequence, { offset, maxChars: 65536 });
    assert.ok(Check(contract.operations.revision.output, page)); assert.ok(withinBudget(page));
    restored += page.raw; offset = page.content.nextOffset;
  } while (offset !== null);
  assert.equal(restored, (await f.record()).raw);
  const detail = f.storage.mutation(f.access, changed.requestId);
  assert.ok(Check(contract.operations.mutation.output, detail)); assert.ok(withinBudget(detail));
  assert.ok(detail.files[0].content.proposed.nextOffset > 0);
  const next = f.storage.mutation(f.access, changed.requestId, { charOffset: detail.files[0].content.proposed.nextOffset });
  assert.equal(next.files[0].content.proposed.offset, detail.files[0].content.proposed.nextOffset);
  const content = await f.storage.run(f.access, vault => inspectRecord(vault, { id: before.id, metadataView: 'none' }));
  assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 24576); assert.ok(content.content.nextOffset > 0);
});

test('durable bytes accept exact boundary and reject one byte over independently of auxiliary reads', async t => {
  const f = await capacityFixture(t, 1000), previous = await f.record();
  const prefix = previous.raw.slice(0, previous.raw.length - previous.body.length);
  const raw = prefix + 'é'.repeat(Math.floor((RECORD_MAX_BYTES - Buffer.byteLength(prefix)) / 2)) +
    'x'.repeat((RECORD_MAX_BYTES - Buffer.byteLength(prefix)) % 2);
  assert.equal(Buffer.byteLength(raw), RECORD_MAX_BYTES);
  await writeFile(f.file, raw);
  const files = new PublicationFiles(f.root);
  assert.equal(files.read('private/' + previous.path), raw);
  assert.equal((await f.record()).valid, true);
  await assert.rejects(readText(f.root, 'private/' + previous.path), /limit|large|size|bytes/i);
  await writeFile(f.file, raw + 'x');
  assert.throws(() => files.read('private/' + previous.path), /Unsafe/);
  assert.throws(() => files.exclusive('private/oversized.md', raw + 'x'), /byte limit/);
  await assert.rejects(f.scan(), /Unsafe|unavailable|malformed/); // Observation fails closed on unsafe external growth.
  assert.equal((await stat(f.file)).size, RECORD_MAX_BYTES + 1, 'oversized original preserved');
});

test('text windows preserve Unicode and bound JSON escapes', () => {
  const text = '😀\u0000'.repeat(40000); let offset = 0, restored = '';
  do { const page = textWindow(text, offset, 65536); assert.ok(Buffer.byteLength(JSON.stringify(page.text)) <= 24576);
    restored += page.text; offset = page.content.nextOffset; } while (offset !== null);
  assert.equal(restored, text); assert.throws(() => textWindow(text, 1), /Unicode/);
  assert.throws(() => textWindow(text, 0, 1), /Invalid text window/);
});

test('large full-record keyword matches keep ranking and label non-localized previews', async t => {
  const f = await capacityFixture(t, 100000), current = await f.record();
  const prefix = current.raw.slice(0, -current.body.length);
  await writeFile(f.file, prefix + 'Opening context.\n' + 'filler '.repeat(14000) + '\nneedle café exact phrase');
  const result = await f.storage.search({ query: 'needle cafe', mode: 'all' }, f.access);
  assert.equal(result.index.state, 'ready'); assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0].matches, ['body']); assert.equal(result.hits[0].snippet.matchLocated, false);
  assert.match(result.hits[0].snippet.text, /^Opening context/); assert.doesNotMatch(result.hits[0].snippet.text, /needle/);
  assert.ok(Number.isFinite(result.hits[0].score));
  assert.equal((await f.storage.search({ query: 'exact phrase', mode: 'phrase' }, f.access)).hits.length, 1);
  assert.equal((await f.storage.search({ query: 'phrase exact', mode: 'phrase' }, f.access)).hits.length, 0);
  const mixed = await f.storage.search({ query: 'Capacity needle' }, f.access);
  assert.deepEqual(mixed.hits[0].matches, ['title', 'body']);
});

test('publication keeps auxiliary and descriptor limits through staging and retained copies', async t => {
  const f = await capacityFixture(t, 1000), files = new PublicationFiles(f.root);
  const cases = [ ['private/ontology.yaml', 65536], ['private/artifacts/inline.md', 65536],
    ['private/artifacts/sources/' + 'a'.repeat(64) + '.json', 8192] ];
  for (const [target, limit] of cases) {
    const before = 'x'.repeat(limit), after = 'y'.repeat(limit);
    files.exclusive(target, before); assert.equal(files.read(target), before);
    const change = { path: target, before, after, stage: target + '.stage', backup: target + '.before' };
    files.publish(change, () => {}); assert.equal(files.read(target), after);
    assert.throws(() => files.exclusive(target + '.other', before + 'x', target.includes('/sources/') ? 'source-descriptor' : 'auxiliary'), /byte limit/);
    await writeFile(pathFor(f, target), after + 'x');
    assert.throws(() => files.read(target), /Unsafe/);
    assert.throws(() => files.publish(change, () => {}), /Unsafe/);
    await writeFile(pathFor(f, target), after);
    await writeFile(pathFor(f, change.backup), before + 'x');
    assert.throws(() => files.publish(change, () => {}), /Unsafe/);
    const fresh = { ...change, path: target + '.fresh', before: null, stage: target + '.fresh-stage', backup: target + '.fresh-before' };
    // Use another canonical destination of the same role and a staged oversize payload.
    fresh.path = target.includes('/sources/') ? target.replace('aaaa', 'bbbb') : target.replace('ontology.yaml', 'other.yaml');
    if (fresh.path === target) fresh.path = target.replace('inline.md', 'other.md');
    await writeFile(pathFor(f, fresh.stage), after + 'x');
    assert.throws(() => files.publish(fresh, () => {}), /Unsafe/);
    await writeFile(pathFor(f, fresh.stage), after);
    files.publish(fresh, () => {}); assert.equal(files.read(fresh.path), after);
  }
  // The root manifest has the auxiliary ceiling, despite being outside the scope.
  assert.throws(() => files.exclusive('vault.json', 'x'.repeat(65537)), /byte limit/);
});

/** Synthetic vault-relative path for direct adversarial fixture edits. */
function pathFor(f, relative) { return f.root + '/' + relative; }

test('NUL before repeated matches cannot bypass the bounded search preview', async t => {
  const f = await capacityFixture(t, 1000), current = await f.record();
  const prefix = current.raw.slice(0, -current.body.length);
  await writeFile(f.file, prefix + 'intro\0' + 'needle '.repeat(12000));
  const result = await f.storage.search({ query: 'needle' }, f.access);
  assert.equal(result.index.state, 'ready'); assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].snippet.matchLocated, false);
  assert.deepEqual(result.hits[0].matches, ['body']);
});
