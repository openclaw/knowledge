import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recentActivity } from '../dist/recent.js';

// Recent reads a projection of published plans. It must follow publications
// made after it was built, and repair removals it did not see.
test('Recent projection follows later publications and removed requests', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE history(sequence INTEGER PRIMARY KEY, scope TEXT,id TEXT,hash TEXT,revision INTEGER,provenance TEXT,at TEXT);
    CREATE TABLE mutations(scope TEXT,request TEXT,intent TEXT,state TEXT,plan TEXT,receipt TEXT, PRIMARY KEY(scope,request));`);
  const at = '2026-10-01T00:00:00Z', active = [];
  const publish = (request, id, state = 'published') => {
    const record = { id, title: id, kind: 'claim', type: 'fact', path: `claims/${id}.md`, lifecycle: 'active', revision: 1, valid: true, hash: id.padEnd(64, '0'), raw: '', body: 'x', metadata: { recorded_at: at, updated_at: at, claim_kind: 'fact' } };
    active.push(record);
    db.prepare('INSERT INTO history(scope,id,hash,revision,provenance,at) VALUES (?,?,?,?,?,?)').run('private', id, record.hash, 1, 'agent', at);
    db.prepare('INSERT INTO mutations VALUES (?,?,?,?,?,?)').run('private', request, 'i', state, JSON.stringify({ actor: 'agent', record }), JSON.stringify({ id, at }));
  };
  const ids = () => recentActivity(db, 'private', active, { limit: 20 }).items.map(item => [item.id, item.change]);
  publish('r1', 'a');
  assert.deepEqual(ids(), [['a', 'created']]);
  publish('r2', 'b');
  publish('r3', 'c', 'accepted');
  assert.deepEqual(ids(), [['c', 'observed'], ['b', 'created'], ['a', 'created']], 'later publication projected; unpublished stays an observation');
  db.prepare("UPDATE mutations SET state='published' WHERE request='r3'").run();
  assert.deepEqual(ids(), [['c', 'created'], ['b', 'created'], ['a', 'created']], 'a request published after projection is picked up');
  db.prepare("DELETE FROM mutations WHERE request='r2'").run();
  assert.deepEqual(ids(), [['c', 'created'], ['b', 'observed'], ['a', 'created']], 'a removed request leaves the projection');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recent_records_v1").get().n, 2);
});
