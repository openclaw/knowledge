import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestScript = path.join(root, 'skills/knowledge-source-ingest/scripts/source-manifest.mjs');
const discrawlScript = path.join(root, 'skills/knowledge-source-ingest/scripts/discrawl-normalize.mjs');
const run = (script, args, options = {}) => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', ...options });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-source-ingest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function snapshot(dir, name, rows, start, end, observed, completeness = 'complete') {
  const input = path.join(dir, name + '.jsonl');
  const output = path.join(dir, name + '.manifest.jsonl.gz');
  const summary = path.join(dir, name + '.summary.json');
  return writeFile(input, jsonl(rows)).then(() => {
    run(manifestScript, ['snapshot', '--provider', 'discord', '--source-key', 'discord:guild:channel',
      '--coverage-start', start, '--coverage-end', end, '--observed-at', observed,
      '--completeness', completeness, '--input', input, '--output', output, '--summary', summary]);
    return { output, summary };
  });
}

async function gunzip(filename, output) {
  await pipeline(createReadStream(filename), createGunzip(), createWriteStream(output));
}

test('source manifests are deterministic, content-private, and produce overlap-aware plans', async t => {
  const dir = await fixture(t);
  const old = await snapshot(dir, 'old', [
    { id: 'a', occurred_at: '2026-09-25T01:00:00-07:00', payload: { text: 'same' } },
    { id: 'b', occurred_at: '2026-09-26T01:00:00-07:00', payload: { text: 'old' } },
    { id: 'c', occurred_at: '2026-09-27T01:00:00-07:00', payload: { text: 'deleted' } },
    { id: 'x', occurred_at: '2026-09-22T01:00:00-07:00', payload: { text: 'outside' } },
    { id: 'z', payload: { text: 'no date' } },
  ], '2026-09-21T00:00:00-07:00', '2026-09-28T00:00:00-07:00', '2026-09-28T00:05:00-07:00');
  const current = await snapshot(dir, 'current', [
    { id: 'a', occurred_at: '2026-09-25T08:00:00Z', payload: { text: 'same' } },
    { id: 'b', occurred_at: '2026-09-26T08:00:00Z', payload: { text: 'new' } },
    { id: 'd', occurred_at: '2026-09-29T08:00:00Z', payload: { text: 'added' } },
  ], '2026-09-25T00:00:00-07:00', '2026-10-01T00:00:00-07:00', '2026-10-01T00:05:00-07:00');
  const plan = path.join(dir, 'plan.json');
  run(manifestScript, ['plan', '--current', current.output, '--previous', old.output, '--output', plan]);
  const result = JSON.parse(await readFile(plan, 'utf8'));
  assert.deepEqual(result.items.added, ['d']);
  assert.deepEqual(result.items.changed, ['b']);
  assert.deepEqual(result.items.unchanged, ['a']);
  assert.deepEqual(result.items.deleted, ['c']);
  assert.deepEqual(result.items.unresolved_missing, ['z']);
  assert.deepEqual(result.coverage.covered, [{ start: '2026-09-25T07:00:00.000Z', end: '2026-09-28T07:00:00.000Z' }]);
  assert.deepEqual(result.coverage.uncovered, [{ start: '2026-09-28T07:00:00.000Z', end: '2026-10-01T07:00:00.000Z' }]);
  const plain = path.join(dir, 'manifest.txt');
  await gunzip(current.output, plain);
  const bytes = await readFile(plain, 'utf8');
  assert.doesNotMatch(bytes, /same|new|added/);
  const summary = JSON.parse(await readFile(current.summary, 'utf8'));
  assert.match(summary.manifest_sha256, /^[a-f0-9]{64}$/);
  const repeated = await snapshot(dir, 'current-repeat', [
    { id: 'd', occurred_at: '2026-09-29T08:00:00Z', payload: { text: 'added' } },
    { id: 'b', occurred_at: '2026-09-26T08:00:00Z', payload: { text: 'new' } },
    { id: 'a', occurred_at: '2026-09-25T08:00:00Z', payload: { text: 'same' } },
  ], '2026-09-25T00:00:00-07:00', '2026-10-01T00:00:00-07:00', '2026-10-01T00:05:00-07:00');
  assert.deepEqual(await readFile(repeated.output), await readFile(current.output));
});

test('newest prior observation wins independent of argument order and partial snapshots do not prove deletion', async t => {
  const dir = await fixture(t);
  const older = await snapshot(dir, 'older', [{ id: 'a', occurred_at: '2026-09-26T00:00:00Z', payload: { n: 1 } }],
    '2026-09-25T00:00:00Z', '2026-09-27T00:00:00Z', '2026-09-27T01:00:00Z');
  const newer = await snapshot(dir, 'newer', [{ id: 'a', occurred_at: '2026-09-26T00:00:00Z', payload: { n: 2 } }],
    '2026-09-25T00:00:00Z', '2026-09-27T00:00:00Z', '2026-09-27T02:00:00Z');
  const current = await snapshot(dir, 'partial', [], '2026-09-25T00:00:00Z', '2026-09-27T00:00:00Z', '2026-09-27T03:00:00Z', 'partial');
  const plan = path.join(dir, 'plan.json');
  run(manifestScript, ['plan', '--current', current.output, '--previous', newer.output, '--previous', older.output, '--output', plan]);
  const result = JSON.parse(await readFile(plan, 'utf8'));
  assert.deepEqual(result.items.deleted, []);
  assert.deepEqual(result.items.unresolved_missing, ['a']);
});

test('duplicate stable IDs reject a snapshot', async t => {
  const dir = await fixture(t), input = path.join(dir, 'duplicate.jsonl');
  await writeFile(input, jsonl([{ id: 'a', payload: 1 }, { id: 'a', payload: 2 }]));
  assert.throws(() => run(manifestScript, ['snapshot', '--provider', 'x', '--source-key', 'y',
    '--coverage-start', '2026-09-01T00:00:00Z', '--coverage-end', '2026-09-02T00:00:00Z',
    '--input', input, '--output', path.join(dir, 'out.jsonl')]), /Duplicate item id/);
});

test('Discrawl adapter resolves a stable channel and emits deterministic attachment state', async t => {
  const dir = await fixture(t), dbPath = path.join(dir, 'discrawl.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE channels(id TEXT,guild_id TEXT,name TEXT); CREATE TABLE members(guild_id TEXT,user_id TEXT,username TEXT,global_name TEXT,display_name TEXT,nick TEXT,bot INTEGER); CREATE TABLE messages(id TEXT,guild_id TEXT,channel_id TEXT,author_id TEXT,message_type TEXT,created_at TEXT,edited_at TEXT,deleted_at TEXT,content TEXT,normalized_content TEXT,reply_to_message_id TEXT,pinned INTEGER,has_attachments INTEGER); CREATE TABLE message_attachments(message_id TEXT,attachment_id TEXT,content_sha256 TEXT,fetch_status TEXT);');
  db.prepare('INSERT INTO channels VALUES(?,?,?)').run('20','10','maintainers');
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?)').run('10','40','handle','Global Name','Display Name','Nick',0);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('30','10','20','40','default','2026-09-27T10:00:00Z',null,null,'hello','hello',null,0,1);
  db.prepare('INSERT INTO message_attachments VALUES(?,?,?,?)').run('30','b','bb','fetched');
  db.prepare('INSERT INTO message_attachments VALUES(?,?,?,?)').run('30','a','aa','fetched');
  db.close();
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  const fake = path.join(bin, 'discrawl');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ database_path: dbPath })}'\n`);
  await chmod(fake, 0o755);
  const output = path.join(dir, 'messages.jsonl');
  const stderr = run(discrawlScript, ['--config', path.join(dir, 'config.yaml'), '--channel', '#maintainers',
    '--since', '2026-09-27T00:00:00Z', '--before', '2026-09-28T00:00:00Z', '--output', output],
    { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(stderr, '');
  const row = JSON.parse((await readFile(output, 'utf8')).trim());
  assert.equal(row.id, '30');
  assert.equal(row.payload.author_name, 'Display Name');
  assert.equal(row.payload.author_username, 'handle');
  assert.equal(row.payload.author_bot, 0);
  assert.equal(row.payload.attachments, 'a:aa:fetched|b:bb:fetched');
});

test('Discrawl adapter exposes usable help without requiring paired arguments', () => {
  const help = run(discrawlScript, ['--help']);
  assert.match(help, /Usage: node discrawl-normalize\.mjs/);
  assert.match(help, /half-open \[since,before\)/);
});
