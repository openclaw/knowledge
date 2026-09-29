import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_DOWNLOAD_CHUNK_BYTES } from '../dist/attachment-contract.js';
import { contract } from '../dist/contract.js';
import { KnowledgeStorage } from '../dist/storage.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { accessFor, apiFor } from './support.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-files-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const api = apiFor(base, config);
  const owner = { source: 'session-action', api, action: { client: { connId: 'files', scopes: ['operator.write'] } } };
  const service = createKnowledgeService(api);
  return { base, root, config, api, owner, service };
}
const draft = attachments => ({ requestId: randomUUID(), title: 'File-backed evidence', type: 'note', body: 'An ordinary page.', attachments });
const uploadInput = (extra = {}) => ({ requestId: randomUUID(), filename: 'original.txt', mediaType: 'text/plain', attribution: 'User-provided original', offset: 0, data: '', final: true, ...extra });
async function upload(f, bytes, metadata = {}) {
  const base = uploadInput(metadata); let result;
  for (let offset = 0; offset < bytes.length || !result; offset += ATTACHMENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    result = await f.service.attach({ ...base, offset, data: chunk.toString('base64'), final: offset + chunk.length === bytes.length }, f.owner);
    assert.ok(Check(contract.operations.attach.output, result));
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  }
  return result.evidence;
}

test('large Unicode source survives chunking, bounded preview, restart, search and byte-exact download', async t => {
  const f = await fixture(t), bytes = Buffer.from('Original 🌱 evidence with Unicode\n'.repeat(6000));
  const evidence = await upload(f, bytes);
  assert.deepEqual(await readFile(path.join(f.root, 'private', evidence.path)), bytes);
  const receipt = await f.service.save_page(draft([evidence]), f.owner);
  const service = createKnowledgeService(f.api), read = await service.record({ id: receipt.id }, f.owner);
  assert.ok(read.record.valid); assert.equal(read.evidence[0].verified, true); assert.equal(read.evidence[0].excerpt.length, 4000);
  assert.equal(read.evidence[0].excerptTruncated, true); assert.ok(Check(contract.operations.record.output, read));
  const chunks = []; let offset = 0;
  do {
    const result = await service.attachment({ id: receipt.id, path: evidence.path, sha256: evidence.sha256, offset }, f.owner);
    assert.ok(Check(contract.operations.attachment.output, result)); chunks.push(Buffer.from(result.data, 'base64')); offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const search = await service.grep({ query: 'ordinary' }, f.owner);
  assert.equal(search.total, 1); assert.ok(Check(contract.operations.grep.output, search));
  assert.deepEqual(search, JSON.parse(JSON.stringify(search)), 'No undefined line locators for whole-file evidence');
  assert.deepEqual(execFileSync('git', ['show', `HEAD:private/${evidence.path}`], { cwd: f.root }), bytes);
});

test('binary/PDF originals are never coerced into UTF-8; media remains outside automatic Git', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 254, 128, 10, 13, 42]);
  const pdf = await upload(f, bytes, { filename: 'scan.pdf', mediaType: 'application/pdf' });
  const media = await upload(f, bytes, { filename: 'photo.png', mediaType: 'image/png' });
  const saved = await f.service.save_page(draft([pdf, media]), f.owner);
  const read = await f.service.record({ id: saved.id }, f.owner);
  assert.ok(read.evidence.every(e => e.verified && !e.excerpt));
  assert.deepEqual(execFileSync('git', ['show', `HEAD:private/${pdf.path}`], { cwd: f.root }), bytes);
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: f.root, encoding: 'utf8' });
  assert.ok(!tracked.includes(media.path));
  assert.deepEqual(await readFile(path.join(f.root, 'private', media.path)), bytes);
});

test('more than twenty sources save and enumerate without truncating stored evidence', async t => {
  const f = await fixture(t), sources = [];
  for (let i = 0; i < 27; i++) sources.push(await upload(f, Buffer.from(`Source ${i}`), { filename: `${i}.txt` }));
  const saved = await f.service.save_page(draft(sources), f.owner);
  const first = await f.service.record({ id: saved.id }, f.owner);
  assert.equal(first.evidenceTotal, 27); assert.equal(first.evidence.length, 20); assert.equal(first.nextEvidenceOffset, 20);
  const second = await f.service.record({ id: saved.id, evidenceOffset: first.nextEvidenceOffset }, f.owner);
  assert.equal(second.evidence.length, 7); assert.equal(second.nextEvidenceOffset, null);
  assert.deepEqual([...first.evidence, ...second.evidence].map(e => e.path), sources.map(e => e.path));
});

test('upload resumes across reload, exact chunks replay, divergent chunks and metadata fail closed', async t => {
  const f = await fixture(t), base = uploadInput({ data: Buffer.from('first').toString('base64'), final: false });
  const first = await f.service.attach(base, f.owner);
  const service = createKnowledgeService(f.api);
  assert.deepEqual(await service.attach(base, f.owner), first);
  await assert.rejects(service.attach({ ...base, data: Buffer.from('other').toString('base64') }, f.owner), /differs/);
  await assert.rejects(service.attach({ ...base, filename: 'changed.txt' }, f.owner), /different metadata/);
  await assert.rejects(service.attach({ ...base, offset: 10 }, f.owner), /offset/);
  const final = { ...base, offset: 5, data: Buffer.from('second').toString('base64'), final: true };
  const completed = await service.attach(final, f.owner);
  assert.deepEqual(await service.attach(final, f.owner), completed);
  assert.deepEqual(await readFile(path.join(f.root, 'private', completed.evidence.path)), Buffer.from('firstsecond'));
  assert.equal((await service.records({}, f.owner)).total, 0, 'Uploading is independent of page publication');
});

test('attachment authority, record-scoped reads, tampering, paths and links are enforced', async t => {
  const f = await fixture(t), readOnly = { ...f.owner, action: { client: { scopes: ['operator.read'] } } };
  await assert.rejects(f.service.attach(uploadInput(), readOnly), /authority/);
  await assert.rejects(f.service.attach(uploadInput({ filename: '../escape' }), f.owner), /Invalid/);
  await assert.rejects(f.service.attach(uploadInput({ expectedVaultId: randomUUID() }), f.owner), /vault changed/);
  const evidence = await upload(f, Buffer.from('private original'));
  await assert.rejects(f.service.attachment({ id: 'not-a-record', path: evidence.path, sha256: evidence.sha256 }, f.owner), /unavailable/);
  await assert.rejects(f.service.save_page(draft([{ ...evidence, path: 'artifacts/../../private-file' }]), f.owner), /Unsafe/);
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  const file = path.join(f.root, 'private', evidence.path);
  await writeFile(file, 'tampered');
  assert.equal((await f.service.record({ id: saved.id }, f.owner)).evidence[0].verified, false);
  await assert.rejects(f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner), /hash/);
  await rm(file); await symlink(path.join(f.base, 'outside'), file);
  await assert.rejects(f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner), /Unsafe/);
  await rm(file); await writeFile(path.join(f.base, 'outside'), 'private original'); await link(path.join(f.base, 'outside'), file);
  await assert.rejects(f.service.attachment({ id: saved.id, path: evidence.path, sha256: evidence.sha256 }, f.owner), /Unsafe/);
});

test('source files are independent of the catalog scan byte budget; legacy large text is retained', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(9 * 1024 * 1024, 65);
  const evidence = await upload(f, bytes);
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  assert.equal((await f.service.record({ id: saved.id }, f.owner)).record.valid, true);
  const source = { text: 'Legacy source\n'.repeat(8000), attribution: 'Older client' };
  assert.ok(Check(contract.operations.save_page.input, { ...draft([]), source }));
  const legacy = await f.service.save_page({ ...draft([]), source }, f.owner);
  const record = await f.service.record({ id: legacy.id }, f.owner);
  assert.equal(record.evidence[0].sha256, createHash('sha256').update(source.text).digest('hex'));
  assert.deepEqual(await readFile(path.join(f.root, 'private', record.evidence[0].path)), Buffer.from(source.text));
});

for (const stage of ['attachment-after-link', 'attachment-before-receipt']) test(`file installation interruption at ${stage} recovers without overwriting the original`, async t => {
  const f = await fixture(t), input = uploadInput({ data: Buffer.from('Original bytes').toString('base64') });
  const config = f.config;
  const storage = new KnowledgeStorage(config, new SqliteIdentityStore(config.statePath), where => { if (where === stage) throw Error('interrupted'); });
  await assert.rejects(storage.attach(input, accessFor(f.owner, true)), /interrupted/);
  const resumed = await createKnowledgeService(f.api).attach(input, f.owner);
  assert.equal(resumed.state, 'complete');
  assert.deepEqual(await readFile(path.join(f.root, 'private', resumed.evidence.path)), Buffer.from('Original bytes'));
  assert.deepEqual(await f.service.attach(input, f.owner), resumed);
});

test('conversation uploads and downloads cannot reach private originals or receipts', async t => {
  const f = await fixture(t), sessionId = randomUUID();
  const group = { source: 'tool', api: f.api, tool: { agentId: 'main',
    memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group-files', sessionId },
    assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const input = uploadInput({ data: Buffer.from('PRIVATE').toString('base64') });
  const privateFile = await f.service.attach(input, f.owner), privatePage = await f.service.save_page(draft([privateFile.evidence]), f.owner);
  await assert.rejects(f.service.attachment({ id: privatePage.id, path: privateFile.evidence.path, sha256: privateFile.evidence.sha256 }, group), /unavailable/);
  const sharedFile = await f.service.attach({ ...input, data: Buffer.from('SHARED').toString('base64') }, group);
  assert.notEqual(sharedFile.evidence.sha256, privateFile.evidence.sha256);
  const sharedPage = await f.service.save_page(draft([sharedFile.evidence]), group);
  assert.equal((await f.service.record({ id: sharedPage.id }, f.owner)).record, null);
  assert.equal((await f.service.record({ id: sharedPage.id }, group)).evidence[0].excerpt, 'SHARED');
  assert.deepEqual(await readFile(path.join(f.root, 'private', privateFile.evidence.path)), Buffer.from('PRIVATE'));
});

// Exercise the public SDK boundary, not just the storage service. Base64 must
// fit host JSON validation on both upload and download.
test('native feature adapter accepts full-size upload and download chunks', async t => {
  const f = await fixture(t), actions = new Map();
  const { default: plugin } = await import('../dist/index.js');
  plugin.register({ ...f.api, id: "knowledge", registerService() {}, registerTool() {},
    registerSessionAction(action) { actions.set(action.id, action); } });
  const invoke = async (name, payload) => {
    const response = await actions.get(name).handler({ ...f.owner.action, payload });
    assert.equal(response.ok, true, response.error);
    return response.result;
  };
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 255);
  const uploaded = await invoke('attach', uploadInput({ filename: 'boundary.bin',
    mediaType: 'application/octet-stream', data: bytes.toString('base64') }));
  const saved = await invoke('save_page', draft([uploaded.evidence]));
  const chunks = []; let offset = 0;
  do {
    const downloaded = await invoke('attachment', { id: saved.id, path: uploaded.evidence.path, sha256: uploaded.evidence.sha256, offset });
    const chunk = Buffer.from(downloaded.data, 'base64');
    assert.ok(chunk.length <= ATTACHMENT_DOWNLOAD_CHUNK_BYTES);
    chunks.push(chunk); offset = downloaded.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});


test('agent download JSON survives the dynamic-tool response budget with continuation intact', async t => {
  const f = await fixture(t), factories = new Map(), sessionId = randomUUID();
  const { default: plugin } = await import('../dist/index.js');
  plugin.register({ ...f.api, id: 'knowledge', registerService() {}, registerSessionAction() {},
    registerTool(factory, options) { factories.set(options.name, factory); } });
  const tool = factories.get('knowledge_attachment')({ agentId: 'main', sessionId,
    sessionKey: 'agent:main:download-budget', memoryAudience: { kind: 'owner-private', agentId: 'main' },
    assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} });
  const bytes = Buffer.from('Original 🌱 evidence\n'.repeat(10000));
  const evidence = await upload(f, bytes, { filename: '源'.repeat(65) + '.txt', mediaType: 'x'.repeat(200) });
  const saved = await f.service.save_page(draft([evidence]), f.owner);
  const chunks = []; let offset = 0;
  do {
    const response = await tool.execute(randomUUID(), { id: saved.id, path: evidence.path, sha256: evidence.sha256, offset });
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(text.length < 64000, `Tool JSON needs framing headroom: ${text.length}`);
    const downloaded = JSON.parse(text.slice(0, 64000));
    const chunk = Buffer.from(downloaded.data, 'base64');
    assert.equal(downloaded.offset, offset);
    assert.equal(downloaded.sha256, evidence.sha256);
    assert.ok(chunk.length > 0 && chunk.length <= ATTACHMENT_DOWNLOAD_CHUNK_BYTES);
    assert.equal(downloaded.nextOffset, offset + chunk.length < bytes.length ? offset + chunk.length : null);
    chunks.push(chunk); offset = downloaded.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});
