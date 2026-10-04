import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import { parse, stringify } from 'yaml';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { ATTACHMENT_CHUNK_BYTES } from '../dist/attachment-contract.js';
import { storeFixture, toolContext } from './support.mjs';

// Every filesystem change stays inside this disposable service fixture.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-evidence-read-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const f = await storeFixture(base, { policy: { writesEnabled: true, operatorRead: true } });
  return { ...f, base, owner: toolContext(f.api), service: createKnowledgeService(f.api) };
}

// Upload original bytes through real service operations, including chunking.
async function upload(f, value, metadata = {}, context = f.owner) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const input = { requestId: randomUUID(), filename: 'source.txt', mediaType: 'text/plain',
    attribution: 'Synthetic regression fixture', ...metadata };
  let result;
  for (let offset = 0; offset < bytes.length || !result; offset += ATTACHMENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    result = await f.service.attach({ ...input, offset, data: chunk.toString('base64'),
      final: offset + chunk.length === bytes.length }, context);
  }
  assert.equal(result.state, 'complete');
  return result.evidence;
}

// Publish source references instead of constructing internal records.
async function publish(f, attachments, context = f.owner) {
  return f.service.save_page({ requestId: randomUUID(), type: 'note',
    title: 'Passage fixture ' + randomUUID(), body: 'Synthetic note.', attachments }, context);
}

// Build immutable source identity for every continuation.
function inputFor(record, evidence, extra = {}) {
  return { id: record.id, path: evidence.path, sha256: evidence.sha256, ...extra };
}

// Verify the schema, JSON byte budget, and scalar safety on every page.
function checkPage(page, maxChars = 3000) {
  assert.ok(Check(contract.operations.evidence_read.output, page));
  assert.deepEqual(page, JSON.parse(JSON.stringify(page)));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 24 * 1024, 'JSON stays below 24 KiB');
  assert.ok(page.text.length <= maxChars, 'maxChars counts UTF-16 units');
  assert.equal(page.text.isWellFormed(), true, 'no split Unicode scalars');
  assert.deepEqual(page.verification, { hashMatches: true, rangeValid: true });
}

// Bound iteration so a stuck cursor fails instead of hanging the suite.
async function collect(f, input, context = f.owner, service = f.service) {
  const pages = [];
  let cursor, offset = 0;
  for (let count = 0; count < 400; count++) {
    const page = await service.evidence_read({ ...input, ...(cursor ? { cursor } : {}) }, context);
    checkPage(page, input.maxChars ?? 3000); assert.equal(page.offset, offset);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    assert.ok(page.text.length > 0); assert.notEqual(page.nextCursor, cursor);
    offset += page.text.length; cursor = page.nextCursor;
  }
  assert.fail('cursor did not terminate within bounded fixture size');
}


test('short passages expose exact identity, inclusive lines, normalization and completion', async t => {
  const f = await fixture(t), original = 'one 🌱\r\ntwo\r\nthree\r\n';
  const evidence = await upload(f, original), saved = await publish(f, [evidence]);
  const inspected = (await f.service.record({ id: saved.id }, f.owner)).record;
  const whole = await f.service.evidence_read(inputFor(saved, evidence), f.owner);
  checkPage(whole);
  assert.deepEqual(whole.record, { id: saved.id, revision: inspected.revision, hash: inspected.hash });
  assert.deepEqual(whole.source, { filename: 'source.txt', sha256: createHash('sha256').update(original).digest('hex') });
  assert.deepEqual(whole.range, { startLine: 1, endLine: 4 });
  assert.equal(whole.text, 'one 🌱\ntwo\nthree\n');
  assert.equal(whole.offset, 0); assert.equal(whole.nextCursor, null);
  // Explicit inclusive ranges omit the delimiter after their last line.
  for (const [bounds, expected, range] of [
    [{ startLine: 2, endLine: 3 }, 'two\nthree', { startLine: 2, endLine: 3 }],
    [{ endLine: 1 }, 'one 🌱', { startLine: 1, endLine: 1 }],
    [{ startLine: 3 }, 'three\n', { startLine: 3, endLine: 4 }],
    [{ startLine: 4, endLine: 4 }, '', { startLine: 4, endLine: 4 }],
  ]) {
    const page = await f.service.evidence_read(inputFor(saved, evidence, bounds), f.owner);
    checkPage(page); assert.equal(page.text, expected); assert.deepEqual(page.range, range);
    assert.equal(page.nextCursor, null);
  }
  assert.deepEqual(await readFile(path.join(f.root, 'private', evidence.path)), Buffer.from(original));
});

test('empty source is a complete empty passage', async t => {
  const f = await fixture(t), evidence = await upload(f, ''), saved = await publish(f, [evidence]);
  const page = await f.service.evidence_read(inputFor(saved, evidence), f.owner);
  checkPage(page); assert.equal(page.text, ''); assert.equal(page.offset, 0);
  assert.deepEqual(page.range, { startLine: 1, endLine: 1 }); assert.equal(page.nextCursor, null);
});

test('long Unicode lines paginate in UTF-16 units without scalar splits or range leakage', async t => {
  const f = await fixture(t), passage = 'a'.repeat(255) + '🌱' + '界é🧪'.repeat(900);
  const evidence = await upload(f, 'before\r\n' + passage + '\r\nafter must not leak');
  const saved = await publish(f, [evidence]), input = inputFor(saved, evidence, { startLine: 2, endLine: 2, maxChars: 256 });
  const first = await f.service.evidence_read(input, f.owner);
  checkPage(first, 256); assert.equal(first.text, 'a'.repeat(255)); assert.ok(first.nextCursor);
  const restarted = createKnowledgeService(f.api);
  const omitted = await restarted.evidence_read(inputFor(saved, evidence, { cursor: first.nextCursor, maxChars: 256 }), f.owner);
  const repeated = await restarted.evidence_read({ ...input, cursor: first.nextCursor }, f.owner);
  assert.deepEqual(omitted, repeated, 'omitted bounds survive service restart');
  assert.equal(omitted.offset, 255); assert.ok(omitted.text.startsWith('🌱'));
  const pages = await collect(f, input, f.owner, restarted);
  assert.equal(pages.map(page => page.text).join(''), passage); assert.ok(pages.length > 2);
  assert.ok(pages.every(page => page.range.startLine === 2 && page.range.endLine === 2));
  assert.equal(pages.at(-1).nextCursor, null);
});

test('streaming normalizes boundary-spanning CRLF and decodes split UTF-8 scalars', async t => {
  const f = await fixture(t), firstLine = 'x'.repeat(65535);
  const evidence = await upload(f, firstLine + '\r\n🌱 end\r\n'), saved = await publish(f, [evidence]);
  const pages = await collect(f, inputFor(saved, evidence));
  assert.equal(pages.map(page => page.text).join(''), firstLine + '\n🌱 end\n');
  assert.deepEqual(pages.at(-1).range, { startLine: 1, endLine: 3 });
  // A four-byte scalar starts in the last byte of a decoder input chunk.
  const split = 'y'.repeat(65535) + '🧪';
  const splitEvidence = await upload(f, split), splitSaved = await publish(f, [splitEvidence]);
  const splitPages = await collect(f, inputFor(splitSaved, splitEvidence));
  assert.equal(splitPages.map(page => page.text).join(''), split);
});

test('escaped text and multibyte filename retain JSON framing headroom', async t => {
  const f = await fixture(t), original = String.fromCharCode(1).repeat(6500) + '界🌱'.repeat(100);
  const evidence = await upload(f, original, { filename: '源'.repeat(65) + '.txt' });
  const saved = await publish(f, [evidence]);
  const pages = await collect(f, inputFor(saved, evidence, { maxChars: 3000 }));
  assert.equal(pages.map(page => page.text).join(''), original); assert.ok(pages.length > 1);
});


test('invalid schema bounds and nonexistent or reversed line ranges fail closed', async t => {
  const f = await fixture(t), evidence = await upload(f, 'one\ntwo'), saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence);
  for (const extra of [{ maxChars: 255 }, { maxChars: 3001 }, { maxChars: 256.5 },
    { startLine: 0 }, { endLine: -1 }, { startLine: 1.5 }, { cursor: '' },
    { cursor: 'x'.repeat(2001) }, { sha256: 'invalid' }, { extra: true }]) {
    assert.equal(Check(contract.operations.evidence_read.input, { ...input, ...extra }), false);
    await assert.rejects(f.service.evidence_read({ ...input, ...extra }, f.owner), /Invalid evidence passage input/i);
  }
  for (const extra of [{ startLine: 2, endLine: 1 }, { startLine: 3 }, { endLine: 3 }]) {
    await assert.rejects(f.service.evidence_read({ ...input, ...extra }, f.owner), /range/i);
  }
});

test('malformed, cross-source, cross-record and changed-range cursors are rejected', async t => {
  const f = await fixture(t), evidence = await upload(f, 'head\n' + '🌱'.repeat(700) + '\ntail');
  const other = await upload(f, 'other source'.repeat(100)), saved = await publish(f, [evidence, other]);
  const otherRecord = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { startLine: 2, endLine: 2, maxChars: 256 });
  const first = await f.service.evidence_read(input, f.owner), cursor = first.nextCursor;
  assert.ok(cursor);
  for (const invalid of ['!', 'e30', Buffer.from('null').toString('base64url'), cursor + '=', cursor.slice(0, -1)]) {
    await assert.rejects(f.service.evidence_read({ ...input, cursor: invalid }, f.owner), /cursor/i);
  }
  for (const changed of [{ startLine: 1 }, { endLine: 3 }, { id: otherRecord.id },
    { path: other.path, sha256: other.sha256 }]) {
    await assert.rejects(f.service.evidence_read({ ...input, cursor, ...changed }, f.owner), /cursor/i);
  }
  // Cursors select positions, never authority: malformed offsets and positions
  // halfway through a surrogate pair must fail even with valid source identity.
  const position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  for (const changed of [{ offset: -1 }, { offset: 1.5 }, { offset: 100000 },
    { offset: 257 }, { start: 0 }, { end: 1 }, { unexpected: true }]) {
    const forged = Buffer.from(JSON.stringify({ ...position, ...changed })).toString('base64url');
    await assert.rejects(f.service.evidence_read({ ...input, cursor: forged }, f.owner), /cursor|range|Unicode/i);
  }
});

test('only a source referenced by the authorized record can be read', async t => {
  const f = await fixture(t), evidence = await upload(f, 'referenced'), unreferenced = await upload(f, 'not attached');
  const saved = await publish(f, [evidence]), empty = await publish(f, []);
  for (const input of [inputFor(saved, unreferenced), inputFor(empty, evidence),
    inputFor({ id: 'not-a-record' }, evidence), inputFor(saved, evidence, { sha256: '0'.repeat(64) }),
    inputFor(saved, evidence, { path: 'artifacts/../../vault.json' }),
    inputFor(saved, evidence, { path: path.join(f.root, 'private', evidence.path) })]) {
    await assert.rejects(f.service.evidence_read(input, f.owner), /unavailable|Invalid/i);
  }
  const noAuthority = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: undefined } };
  await assert.rejects(f.service.evidence_read(inputFor(saved, evidence), noAuthority), /authority|unavailable/i);
});

test('private and conversation passages cannot share access or continuation cursors', async t => {
  const f = await fixture(t), sessionId = randomUUID();
  const group = toolContext(f.api, 'main', { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:passages', sessionId });
  const otherGroup = toolContext(f.api, 'main', { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:other-passages', sessionId: randomUUID() });
  const evidence = await upload(f, 'PRIVATE '.repeat(100)), saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { maxChars: 256 }), first = await f.service.evidence_read(input, f.owner);
  assert.ok(first.nextCursor);
  for (const context of [group, otherGroup]) {
    await assert.rejects(f.service.evidence_read({ ...input, cursor: first.nextCursor }, context), /unavailable/i);
  }
  const shared = await upload(f, 'SHARED '.repeat(100), {}, group), sharedSaved = await publish(f, [shared], group);
  const sharedInput = inputFor(sharedSaved, shared, { maxChars: 256 });
  const sharedPage = await f.service.evidence_read(sharedInput, group);
  checkPage(sharedPage, 256); assert.ok(sharedPage.text.startsWith('SHARED'));
  await assert.rejects(f.service.evidence_read(sharedInput, f.owner), /unavailable/i);
  await assert.rejects(f.service.evidence_read(sharedInput, otherGroup), /unavailable/i);
  await assert.rejects(f.service.evidence_read({ ...sharedInput, cursor: first.nextCursor }, group), /cursor/i);
  // Retain record/source identity but author valid conversation metadata.
  // Simply copying private metadata is correctly rejected before cursor checks.
  const record = (await f.service.record({ id: saved.id, view: 'raw' }, f.owner)).record;
  const scopeRoot = path.join(f.root, 'conversations', sessionId);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(record.raw);
  assert.ok(frontmatter);
  const metadata = parse(frontmatter[1]);
  metadata.scope = { visibility: 'conversation', sessionId };
  const scopedRaw = '---\n' + stringify(metadata) + '---\n' + record.raw.slice(frontmatter[0].length);
  for (const [relative, bytes] of [[record.path, scopedRaw], [evidence.path, Buffer.from('PRIVATE '.repeat(100))]]) {
    const target = path.join(scopeRoot, relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  assert.equal((await f.service.evidence_read(input, group)).text, first.text);
  await assert.rejects(f.service.evidence_read({ ...input, cursor: first.nextCursor }, group), /cursor/i);
});


test('every continuation rechecks live invocation and audience authority', async t => {
  const f = await fixture(t), evidence = await upload(f, 'live authority '.repeat(100)), saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { maxChars: 256 }), first = await f.service.evidence_read(input, f.owner);
  for (const method of ['assertInvocationCurrent', 'assertMemoryAudienceCurrent']) {
    const revoked = { ...f.owner, tool: { ...f.owner.tool, [method]() { throw Error('authority revoked'); } } };
    await assert.rejects(f.service.evidence_read({ ...input, cursor: first.nextCursor }, revoked), /revoked/);
  }
  const next = await f.service.evidence_read({ ...input, cursor: first.nextCursor }, f.owner);
  assert.equal(next.offset, first.text.length);
});

test('withdrawal blocks new and continuing reads even after stale record restoration', async t => {
  const f = await fixture(t), evidence = await upload(f, 'withdraw me '.repeat(100)), saved = await publish(f, [evidence]);
  const before = (await f.service.record({ id: saved.id, view: 'raw' }, f.owner)).record;
  const input = inputFor(saved, evidence, { maxChars: 256 }), first = await f.service.evidence_read(input, f.owner);
  await f.service.withdraw({ requestId: randomUUID(), id: saved.id, expectedRevision: before.revision,
    expectedHash: before.hash, reason: 'Synthetic withdrawal' }, f.owner);
  for (const cursor of [undefined, first.nextCursor]) {
    await assert.rejects(f.service.evidence_read({ ...input, ...(cursor ? { cursor } : {}) }, f.owner), /unavailable/i);
  }
  // Durable tombstones must dominate an externally restored pre-withdrawal file.
  await writeFile(path.join(f.root, 'private', before.path), before.raw);
  const restarted = createKnowledgeService(f.api);
  await assert.rejects(restarted.evidence_read({ ...input, cursor: first.nextCursor }, f.owner), /unavailable/i);
  assert.deepEqual(await readFile(path.join(f.root, 'private', evidence.path)), Buffer.from('withdraw me '.repeat(100)));
});

test('source tampering beyond the requested range invalidates first and continuation pages', async t => {
  const f = await fixture(t), original = 'a'.repeat(700) + '\nTAIL';
  const evidence = await upload(f, original), saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence, { startLine: 1, endLine: 1, maxChars: 256 });
  const first = await f.service.evidence_read(input, f.owner), file = path.join(f.root, 'private', evidence.path);
  await writeFile(file, original.slice(0, -4) + 'FAIL');
  for (const extra of [{}, { cursor: first.nextCursor }]) {
    await assert.rejects(f.service.evidence_read({ ...input, ...extra }, f.owner), /hash|unavailable/i);
  }
  await writeFile(file, original);
  assert.equal((await f.service.evidence_read({ ...input, cursor: first.nextCursor }, f.owner)).offset, 256);
});

test('binary and malformed UTF-8 are rejected even beyond a selected passage', async t => {
  const f = await fixture(t);
  const cases = [
    [Buffer.from('%PDF-1.7 plain ASCII'), { filename: 'scan.pdf', mediaType: 'application/pdf' }],
    [Buffer.from('good first line\nrest\u0000binary'), {}],
    [Buffer.concat([Buffer.from('good first line\n'), Buffer.from([0xc0, 0xaf])]), {}],
    [Buffer.concat([Buffer.from('good first line\n'), Buffer.from([0xf0, 0x9f, 0x8c])]), {}],
  ];
  for (const [bytes, metadata] of cases) {
    const evidence = await upload(f, bytes, metadata), saved = await publish(f, [evidence]);
    await assert.rejects(f.service.evidence_read(inputFor(saved, evidence, { startLine: 1, endLine: 1 }), f.owner), /text|binary|encoded|encoding|UTF-8/i);
  }
});

test('symlinks, hardlinks and linked parent directories cannot expose retained bytes', async t => {
  const f = await fixture(t), original = 'link isolation '.repeat(100);
  const evidence = await upload(f, original), saved = await publish(f, [evidence]);
  const input = inputFor(saved, evidence), file = path.join(f.root, 'private', evidence.path);
  const outside = path.join(f.base, 'outside.txt'); await writeFile(outside, original);
  await rm(file); await symlink(outside, file);
  await assert.rejects(f.service.evidence_read(input, f.owner), /Unsafe|unavailable|link/i);
  await rm(file); await link(outside, file);
  await assert.rejects(f.service.evidence_read(input, f.owner), /Unsafe|unavailable|link/i);
  await rm(file); await writeFile(file, original);
  // An ordinary final file under a linked directory is unsafe as well.
  const directory = path.dirname(file), moved = path.join(f.base, 'moved-artifacts');
  await rename(directory, moved); await symlink(moved, directory);
  await assert.rejects(f.service.evidence_read(input, f.owner), /Unsafe|unavailable|link/i);
  assert.equal(await readFile(outside, 'utf8'), original);
});


test('missing optional filename uses a retained basename longer than 200 characters', async t => {
  const f = await fixture(t), original = 'Legacy retained source without filename metadata.';
  const uploaded = await upload(f, original);
  // Upload names are capped at 200, but pre-existing retained Evidence paths
  // permit longer basenames. Construct that valid legacy source in the temp vault.
  const filename = 'legacy-'.repeat(32) + '.txt';
  assert.ok(filename.length > 200 && Buffer.byteLength(filename) <= 255);
  const { filename: omitted, ...evidence } = uploaded;
  assert.equal(omitted, 'source.txt');
  evidence.path = path.posix.join(path.posix.dirname(uploaded.path), filename);
  await rename(path.join(f.root, 'private', uploaded.path), path.join(f.root, 'private', evidence.path));
  const saved = await publish(f, [evidence]);
  const page = await f.service.evidence_read(inputFor(saved, evidence), f.owner);
  assert.equal(page.source.filename, filename, 'fallback basename is not truncated');
  assert.equal(page.source.sha256, evidence.sha256);
  assert.equal(page.text, original); assert.equal(page.nextCursor, null);
  checkPage(page);
});

// Annotation sources remain scoped to the record that explicitly cites them.
test('annotation-only identity and attribution sources are readable', async t => {
  const f = await fixture(t), evidence = await upload(f, 'Annotation-only retained source.');
  const saved = await publish(f, []), candidate = await publish(f, []);
  for (const annotations of [
    { identity: { status: 'partial', context: 'Synthetic unresolved identity', candidates: [
      { id: candidate.id, basis: 'Synthetic candidate', evidence: [evidence] }] } },
    { attribution_confidence: { level: 'medium', basis: 'Synthetic attribution', evidence: [evidence] } },
  ]) {
    const before = (await f.service.record({ id: saved.id }, f.owner)).record;
    await f.service.annotate({ requestId: randomUUID(), id: saved.id, expectedRevision: before.revision,
      expectedHash: before.hash, reason: 'Synthetic annotation coverage', annotations }, f.owner);
    const result = await f.service.evidence_read(inputFor(saved, evidence), f.owner);
    checkPage(result); assert.equal(result.text, 'Annotation-only retained source.');
  }
  await assert.rejects(f.service.evidence_read(inputFor(candidate, evidence), f.owner), /unavailable/);
});

test('ranged UTF-8 sources need no recognized extension or media type', async t => {
  const f = await fixture(t), uploaded = await upload(f, 'first\nsecond\nthird');
  const { filename, mediaType, ...evidence } = uploaded;
  evidence.path = path.posix.join(path.posix.dirname(uploaded.path), 'transcript');
  evidence.start_line = 1; evidence.end_line = 2;
  await rename(path.join(f.root, 'private', uploaded.path), path.join(f.root, 'private', evidence.path));
  const saved = await publish(f, [evidence]);
  const inspected = await f.service.record({ id: saved.id, includeEvidence: true }, f.owner);
  assert.equal(inspected.evidence[0].verified, true);
  const result = await f.service.evidence_read(inputFor(saved, evidence, { startLine: 1, endLine: 2 }), f.owner);
  checkPage(result); assert.equal(result.text, 'first\nsecond'); assert.equal(result.nextCursor, null);
});
