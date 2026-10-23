import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { parseCron, nextRun } from '../dist/cron.js';
import { adopt, createVault, hostApi, operatorContext, toolContext } from './support.mjs';

/** Host-like service scheduler with a manual clock. */
function fakeScheduler(start) {
  const jobs = new Map(), scheduler = { version: 1, clock: start, signal: new AbortController().signal,
    now: () => scheduler.clock,
    schedule(job) { jobs.set(job.id, { ...job, at: job.atMs ?? scheduler.clock + job.delayMs }); return { cancel() { jobs.delete(job.id); }, async stop() {} }; },
    async fire(id) { const job = jobs.get(id); assert.ok(job, `job ${id} is scheduled`); jobs.delete(id); scheduler.clock = Math.max(scheduler.clock, job.at); await job.run(); },
    jobs };
  return scheduler;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-maintenance-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const policy = { writesEnabled: true, operatorRead: true, maintenance: { schedule: '0 * * * *', timezone: 'UTC' } };
  const host = hostApi(base, { agents: ['main', 'ops', 'idle'], stores: { team: { label: 'Team', agents: ['ops'] } }, policy });
  const own = await createVault(base, { name: 'own' }), team = await createVault(base, { name: 'team' });
  adopt(host.stateRoot, 'agent:main', own.config); adopt(host.stateRoot, 'named:team', team.config, 'Team');
  const lifecycles = [], logs = [];
  host.api.registerService = s => lifecycles.push(s);
  host.api.logger = { info: m => logs.push(m), warn: m => logs.push(`WARN ${m}`) };
  const boot = async scheduler => {
    lifecycles.length = 0;
    const service = createKnowledgeService(host.api);
    await lifecycles[0].start({ scheduler });
    t.after(() => lifecycles[0]?.stop());
    return service;
  };
  return { host, boot, logs, lifecycles };
}

const remember = (service, context, text) => service.remember({ requestId: randomUUID(), attribution: 'test', excerpt: `User: ${text}`, items: [{ text, kind: 'fact', infer_subject: false }] }, context);
const page = (service, context, title, type = 'company') => service.save_page({ requestId: randomUUID(), title, type, body: 'Page.\n' }, context);

test('cron expressions evaluate in the configured time zone and skip impossible slots', () => {
  const daily = parseCron('30 3 * * *', 'America/Los_Angeles');
  assert.equal(new Date(nextRun(daily, Date.parse('2026-10-20T12:00:00Z'))).toISOString(), '2026-10-21T10:30:00.000Z');
  // Spring forward: 02:30 does not exist on 2026-03-08 in Los Angeles.
  const early = parseCron('30 2 * * *', 'America/Los_Angeles');
  assert.equal(new Date(nextRun(early, Date.parse('2026-03-08T08:00:00Z'))).toISOString(), '2026-03-09T09:30:00.000Z');
  // Fall back: 01:30 repeats on 2026-11-01 and runs once.
  const repeat = parseCron('30 1 * * *', 'America/Los_Angeles'), first = nextRun(repeat, Date.parse('2026-11-01T07:00:00Z'));
  assert.equal(new Date(first).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(new Date(nextRun(repeat, first)).toISOString(), '2026-11-02T09:30:00.000Z');
  // Spring forward makes that civil day 23h. A restricted day must still be tested at local midnight.
  assert.equal(new Date(nextRun(parseCron('0 0 * * 1', 'America/Los_Angeles'), Date.parse('2026-03-07T08:00:00Z'))).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(new Date(nextRun(parseCron('15 0 * * 1-5', 'America/Los_Angeles'), Date.parse('2026-03-07T08:00:00Z'))).toISOString(), '2026-03-09T07:15:00.000Z');
  assert.equal(new Date(nextRun(parseCron('0 0 9 * *', 'America/Los_Angeles'), Date.parse('2026-03-08T07:00:00Z'))).toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(new Date(nextRun(parseCron('0 0 * * 1', 'Europe/Paris'), Date.parse('2026-03-28T23:00:00Z'))).toISOString(), '2026-03-29T22:00:00.000Z');
  // Fall back does not skip the next Monday midnight.
  assert.equal(new Date(nextRun(parseCron('0 0 * * 1', 'America/Los_Angeles'), Date.parse('2026-10-31T07:00:00Z'))).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(new Date(nextRun(parseCron('*/15 9-17 * * 1-5', 'UTC'), Date.parse('2026-10-24T12:00:00Z'))).toISOString(), '2026-10-26T09:00:00.000Z');
  assert.throws(() => parseCron('61 * * * *', 'UTC'), /Invalid cron field/);
  assert.throws(() => parseCron('* * * *', 'UTC'), /five fields/);
  assert.throws(() => parseCron('* * * * *', 'Mars/Base'), /Unknown time zone/);
});

test('a scheduled pass links across every store and partition, skips unprovisioned stores, repeats as a no-op, and catches up after a miss', async t => {
  const f = await fixture(t), start = Date.parse('2026-10-20T10:20:00Z');
  const scheduler = fakeScheduler(start), service = await f.boot(scheduler);
  assert.equal(scheduler.jobs.get('knowledge-maintenance').at, Date.parse('2026-10-20T11:00:00Z'));

  const main = toolContext(f.host.api, 'main'), ops = toolContext(f.host.api, 'ops');
  const group = toolContext(f.host.api, 'main', { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: randomUUID() });
  const a = (await remember(service, main, 'Atlas Labs moved its launch to March.')).items[0].id;
  const b = (await remember(service, ops, 'Nimbus Works hired a CFO.')).items[0].id;
  const c = (await remember(service, group, 'Atlas Labs joined the group call.')).items[0].id;
  const atlas = await page(service, main, 'Atlas Labs'), nimbus = await page(service, ops, 'Nimbus Works');
  // A page in another store or partition is never a target.
  await page(service, ops, 'Atlas Labs');
  const groupAtlas = await page(service, group, 'Atlas Labs');

  await scheduler.fire('knowledge-maintenance');
  const status = await service.maintenance_status({}, operatorContext(f.host.api));
  assert.ok(Check(contract.operations.maintenance_status.output, status));
  const byBinding = Object.fromEntries(status.lastRun.vaults.map(v => [v.binding, v]));
  assert.deepEqual(Object.keys(byBinding).sort(), ['agent:idle', 'agent:main', 'named:team']);
  assert.deepEqual([byBinding['agent:main'].outcome, byBinding['agent:main'].partitions, byBinding['agent:main'].linked], ['ok', 2, 2]);
  assert.deepEqual([byBinding['named:team'].outcome, byBinding['named:team'].linked, byBinding['named:team'].label], ['ok', 1, 'Team']);
  assert.equal(byBinding['agent:idle'].outcome, 'skipped');
  assert.equal(status.lastRun.trigger, 'scheduled'); assert.equal(status.lastRun.slot, '2026-10-20T11:00:00.000Z'); assert.equal(status.lastRun.linked, 3);
  assert.equal(status.nextRunAt, '2026-10-20T12:00:00.000Z');
  const entities = async (ctx, id) => (await service.record({ id, includeMetadata: true }, ctx)).record.metadata.entities;
  assert.deepEqual(await entities(main, a), [atlas.id]);
  assert.deepEqual(await entities(ops, b), [nimbus.id]);
  assert.deepEqual(await entities(group, c), [groupAtlas.id], 'Conversation claims link only within their own partition');
  const history = await service.history({ id: a }, main);
  assert.match(JSON.stringify(history), /maintenance/);
  await assert.rejects(service.maintenance_status({}, main), /operators only/);

  await scheduler.fire('knowledge-maintenance');
  const again = await service.maintenance_status({}, operatorContext(f.host.api));
  assert.equal(again.lastRun.linked, 0, 'A repeat pass links nothing new');
  assert.equal(again.lastRun.slot, '2026-10-20T12:00:00.000Z');

  // The Gateway is down across the 13:00 slot; the next start catches up once.
  await f.lifecycles[0].stop();
  const later = fakeScheduler(Date.parse('2026-10-20T13:40:00Z')), restarted = await f.boot(later);
  const catchUp = later.jobs.get('knowledge-maintenance');
  assert.equal(catchUp.at, later.clock + 60_000);
  await later.fire('knowledge-maintenance');
  const caught = await restarted.maintenance_status({}, operatorContext(f.host.api));
  assert.deepEqual([caught.lastRun.trigger, caught.lastRun.slot, caught.nextRunAt], ['catch-up', '2026-10-20T13:00:00.000Z', '2026-10-20T14:00:00.000Z']);
});

test('disabled maintenance, invalid schedules and write-disabled installs schedule nothing', async t => {
  for (const [maintenance, writesEnabled, expected] of [[{ enabled: false }, true, /^$/], [{ schedule: 'not a cron' }, true, /five fields/], [{}, false, /^$/]]) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-maintenance-off-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const host = hostApi(base, { policy: { writesEnabled, operatorRead: true, maintenance } }), lifecycles = [];
    host.api.registerService = s => lifecycles.push(s); host.api.logger = { info() {}, warn() {} };
    const service = createKnowledgeService(host.api), scheduler = fakeScheduler(Date.now());
    await lifecycles[0].start({ scheduler }); t.after(() => lifecycles[0].stop());
    assert.equal(scheduler.jobs.size, 0);
    const status = await service.maintenance_status({}, operatorContext(host.api));
    assert.equal(status.nextRunAt, null);
    assert.match(status.configError ?? '', expected);
  }
});
