import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStorage } from '../dist/storage.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { GitHistory } from '../dist/git-history.js';
import { Check } from 'typebox/value';
import { Receipt, GitStatus } from '../dist/mutation-contract.js';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trimEnd();
const draft = () => ({ requestId: randomUUID(), title: 'History', type: 'note', body: 'First bytes.\n' });
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-git-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const access = { scope: { visibility: 'private' }, agentId: 'main', assertCurrent() {} };
  const store = new SqliteIdentityStore(config.statePath);
  const service = new KnowledgeStorage(config, store);
  const read = async id => service.run(access, async vault => (await vault.scan()).records.find(r => r.id === id));
  return { base, root, config, access, store, service, read };
}
const edit = record => ({ requestId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedHash: record.hash, title: record.title, body: 'Second bytes.\n' });

test('default repository, exact grouped content, clean index, actor, and one commit per publication', async t => {
  const f = await fixture(t), input = { ...draft(), source: { text: 'Evidence bytes\n', attribution: 'Source' } };
  const saved = await f.service.save(input, f.access, 'operator');
  assert.ok(Check(Receipt, saved)); assert.equal(saved.git.state, 'committed', JSON.stringify(saved));
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '1');
  const sourceId = (await f.read(saved.id)).metadata.evidence[0].source;
  assert.match(sourceId, /^[a-f0-9]{64}$/);
  assert.deepEqual(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), [`private/${saved.path}`, `private/artifacts/${input.requestId}.txt`, `private/artifacts/sources/${sourceId}.json`].sort());
  assert.equal(execFileSync('git', ['-C', f.root, 'show', `HEAD:private/${saved.path}`], {encoding:'utf8'}), await readFile(path.join(f.root, 'private', saved.path), 'utf8'));
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
  assert.match(git(f.root, 'log', '-1', '--format=%B'), /operator/);
  const next = await f.service.save(edit(await f.read(saved.id)), f.access, 'agent');
  assert.equal(next.git.state, 'committed'); assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
  assert.deepEqual(await new KnowledgeStorage(f.config).save(input, f.access, 'operator'), saved);
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
  assert.ok(Check(GitStatus, f.service.history(f.access, {}).git));
  assert.equal(git(f.root, 'remote'), '');
});

test('missing Git is nonfatal and later availability catches up every version in order', async t => {
  const f = await fixture(t);
  const unavailable = new KnowledgeStorage(f.config, f.store, undefined, new GitHistory(f.root, path.join(f.base, 'missing-git')));
  const input = draft(), first = await unavailable.save(input, f.access, 'agent');
  assert.equal(first.state, 'published'); assert.equal(first.git.state, 'unavailable'); assert.equal(existsSync(path.join(f.root, '.git')), false);
  const record = await unavailable.run(f.access, async vault => (await vault.scan()).records[0]);
  const second = await unavailable.save(edit(record), f.access, 'agent'); assert.equal(second.state, 'published');
  const resumed = f.service.resume(f.access, input.requestId); assert.equal(resumed.git.state, 'committed');
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
  assert.match(git(f.root, 'show', `HEAD^:private/${first.path}`), /First bytes/);
  assert.match(git(f.root, 'show', `HEAD:private/${first.path}`), /Second bytes/);
  assert.equal(f.service.history(f.access, {}).git.pending, 0);
});

test('existing repo staging, unrelated dirty files, and same-path staged bytes survive', async t => {
  const f = await fixture(t), first = await f.service.save(draft(), f.access, 'agent');
  await writeFile(path.join(f.root, 'unrelated.txt'), 'staged content'); git(f.root, 'add', 'unrelated.txt');
  await writeFile(path.join(f.root, 'unrelated.txt'), 'unstaged content');
  const record = await f.read(first.id), full = path.join(f.root, 'private', first.path);
  await writeFile(full, record.raw.replace('First bytes.', 'Manually staged.')); git(f.root, 'add', `private/${first.path}`);
  await writeFile(full, record.raw);
  const receipt = await f.service.save(edit(record), f.access, 'agent'); assert.equal(receipt.git.state, 'committed');
  assert.equal(git(f.root, 'show', ':unrelated.txt'), 'staged content');
  assert.match(git(f.root, 'show', `:private/${first.path}`), /Manually staged/);
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'unstaged content');
  assert.equal(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD'), `private/${first.path}`);
});

for (const stage of ['before-git-ref', 'after-git-ref']) test(`checkpoint failure at ${stage} is visible and retries without duplicate commits`, async t => {
  const f = await fixture(t), input = draft();
  const broken = new KnowledgeStorage(f.config, f.store, where => { if (where === stage) throw Error('injected checkpoint failure'); });
  const receipt = await broken.save(input, f.access, 'agent'); assert.equal(receipt.state, 'published'); assert.equal(receipt.git.state, 'pending');
  assert.equal(f.service.resume(f.access, input.requestId).git.state, 'committed');
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
});

test('process death after atomic Git ref update recovers from SQLite rollback without a duplicate', async t => {
  const f = await fixture(t), input = draft();
  const source = `import { KnowledgeStorage } from './dist/storage.js';
    let raw=''; for await(const c of process.stdin) raw+=c;
    const {config,input}=JSON.parse(raw);
    await new KnowledgeStorage(config,undefined,s=>{if(s==='after-git-ref') process.exit(77)}).save(input,{scope:{visibility:'private'},agentId:'main',assertCurrent(){}},'agent');`;
  const code = await new Promise(resolve => { const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['pipe', 'ignore', 'ignore'] }); child.on('close', resolve); child.stdin.end(JSON.stringify({ config: f.config, input })); });
  assert.equal(code, 77);
  assert.equal(f.service.resume(f.access, input.requestId).git.state, 'committed');
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
});

test('external edits are one observed batch; rename and deletion keep per-file history', async t => {
  const f = await fixture(t), a = await f.service.save(draft(), f.access, 'agent'), b = await f.service.save(draft(), f.access, 'agent');
  for (const r of [a,b]) { const p = path.join(f.root, 'private', r.path); await writeFile(p, (await readFile(p, 'utf8')).replace('First bytes.', 'External bytes.')); }
  await f.read(a.id); assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '3');
  assert.equal(git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').length, 2);
  await rename(path.join(f.root, 'private', a.path), path.join(f.root, 'private', a.path + '-renamed.md'));
  await rm(path.join(f.root, 'private', b.path)); await f.read(a.id);
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '4');
  assert.equal(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD'), `private/${a.path}-renamed.md`);
  assert.equal(git(f.root, 'log', '--follow', '--format=%s', '--', `private/${a.path}-renamed.md`).split('\n').length, 3);
});

test('scope isolation: shared reads checkpoint neither private files nor private pending jobs', async t => {
  const f = await fixture(t);
  const offline = new KnowledgeStorage(f.config, f.store, undefined, new GitHistory(f.root, path.join(f.base, 'missing-git')));
  const secret = await offline.save(draft(), f.access, 'agent');
  const shared = { scope: { visibility: 'conversation', sessionId: randomUUID() }, assertCurrent() {} };
  const receipt = await f.service.save(draft(), shared, 'agent'); assert.equal(receipt.git.state, 'committed');
  assert.doesNotMatch(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD'), /private/);
  assert.equal(f.service.history(shared, {}).git.pending, 0);
  assert.equal(f.service.history(f.access, {}).mutations[0].git.state, 'unavailable');
  assert.equal(f.service.resume(f.access, secret.requestId).git.state, 'committed');
});

test('read-only stores never initialize Git; parent repositories are not adopted', async t => {
  const f = await fixture(t);
  await new KnowledgeStorage({ ...f.config, writesEnabled: false }).run(f.access, v => v.scan());
  assert.equal(existsSync(path.join(f.root, '.git')), false);
  git(f.base, 'init', '--quiet');
  const saved = await f.service.save(draft(), f.access, 'agent'); assert.equal(saved.git.state, 'committed');
  assert.equal(git(f.root, 'rev-parse', '--show-toplevel'), realpathSync(f.root));
  assert.equal(git(f.base, 'ls-files'), '');
});

test('repository lock and detached HEAD report history gaps without rejecting published writes', async t => {
  const f = await fixture(t), first = await f.service.save(draft(), f.access, 'agent');
  const record = await f.read(first.id);
  git(f.root, 'checkout', '--detach', '--quiet');
  const input = edit(record), saved = await f.service.save(input, f.access, 'agent');
  assert.equal(saved.state, 'published'); assert.equal(saved.git.state, 'pending');
  git(f.root, 'checkout', '--quiet', 'main');
  await writeFile(path.join(f.root, '.git', 'index.lock'), 'someone else');
  assert.equal(f.service.resume(f.access, input.requestId).git.state, 'pending');
  assert.equal(await readFile(path.join(f.root, '.git', 'index.lock'), 'utf8'), 'someone else');
  await rm(path.join(f.root, '.git', 'index.lock'));
  assert.equal(f.service.resume(f.access, input.requestId).git.state, 'committed');
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
});

test('Git uses exact publication bytes despite a subsequent editor write and never invokes hooks', async t => {
  const f = await fixture(t), first = await f.service.save(draft(), f.access, 'agent');
  const record = await f.read(first.id), marker = path.join(f.base, 'hook-ran');
  await mkdir(path.join(f.root, '.git', 'hooks'), {recursive:true});
  await writeFile(path.join(f.root, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, {mode:0o755});
  const { writeFileSync } = await import('node:fs');
  const service = new KnowledgeStorage(f.config, f.store, stage => {
    if (stage === 'before-git-ref') writeFileSync(path.join(f.root, 'private', first.path), record.raw.replace('First bytes.', 'Later external write.'));
  });
  const saved = await service.save(edit(record), f.access, 'agent');
  assert.equal(saved.git.state, 'committed');
  assert.match(git(f.root, 'show', `HEAD:private/${first.path}`), /Second bytes/);
  assert.match(await readFile(path.join(f.root, 'private', first.path), 'utf8'), /Later external write/);
  assert.equal(existsSync(marker), false);
  await f.read(first.id);
  assert.match(git(f.root, 'show', `HEAD:private/${first.path}`), /Later external write/);
});

test('unsafe Git directory is a visible nonfatal checkpoint failure and is never followed', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.root, '.git'));
  const saved = await f.service.save(draft(), f.access, 'agent');
  assert.equal(saved.state, 'published'); assert.equal(saved.git.state, 'pending');
  assert.equal(existsSync(path.join(outside, 'HEAD')), false);
});

test('read-side Git observes safe malformed Markdown and ontology without following unsafe files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'private', 'broken.md'), 'No record envelope\n');
  await writeFile(path.join(f.root, 'private', '.extra.md'), 'Hidden note\n');
  await writeFile(path.join(f.root, 'private', 'ontology.yaml'), 'broken: [yaml\n');
  await symlink(path.join(f.root, 'vault.json'), path.join(f.root, 'private', 'unsafe.md'));
  const result = await f.service.run(f.access, v => v.scan());
  assert.ok(result.issues.length);
  assert.deepEqual(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n'), ['private/.extra.md', 'private/broken.md', 'private/ontology.yaml']);
  assert.equal(f.service.history(f.access, {}).git.state, 'committed');
});

test('observation re-resolves source descriptors when an external edit adds a record citation', async t => {
  const { describeSource } = await import('../dist/source-descriptors.js');
  const f = await fixture(t), saved = await f.service.save({ ...draft(), source: { text: 'Evidence bytes\n', attribution: 'Source' } }, f.access, 'agent');
  // Settle every stamp so observation caches this record's dependencies.
  t.mock.method(Date, 'now', () => 4102444800000);
  const { source: first, ...origin } = (await f.read(saved.id)).metadata.evidence[0];
  await f.read(saved.id);
  const second = describeSource({ ...origin, attribution: 'Second origin' });
  assert.notEqual(second.id, first);
  await writeFile(path.join(f.root, 'private', second.path), second.raw);
  const file = path.join(f.root, 'private', saved.path), raw = await readFile(file, 'utf8');
  // Add a citation and keep the first, so every cached descriptor stamp still matches.
  assert.ok(raw.includes(`  - source: ${first}\n`));
  await writeFile(file, raw.replace(`  - source: ${first}\n`, `  - source: ${second.id}\n  - source: ${first}\n`));
  assert.deepEqual((await f.read(saved.id)).metadata.evidence.map(e => e.attribution), ['Second origin', 'Source']);
  assert.ok(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes(`private/${second.path}`), 'new dependency observed despite the warm cache');
});
