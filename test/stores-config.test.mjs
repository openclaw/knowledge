import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMembership, effectiveBinding, storesRevision, readStoresSection, parsePolicy } from '../dist/stores-config.js';

test('membership: unassigned agents use isolated defaults; assigned agents use their named store', () => {
  const m = parseMembership({ personal: { agents: ['main', 'research'] } });
  assert.equal(effectiveBinding(m, 'main'), 'named:personal');
  assert.equal(effectiveBinding(m, 'ops'), 'agent:ops');
  assert.deepEqual(m.issues, []);
});

test('membership: duplicate assignment is invalid, never first-match-wins', () => {
  const m = parseMembership({ a: { agents: ['main'] }, b: { agents: ['main', 'ops'] } });
  assert.equal(effectiveBinding(m, 'main'), undefined);
  assert.equal(effectiveBinding(m, 'ops'), 'named:b');
  assert.match(m.issues[0], /both "a" and "b"/);
});

test('membership: a malformed section makes listed agents unavailable instead of isolated', () => {
  const m = parseMembership({ 'Bad Key': { agents: ['main'] } });
  assert.equal(effectiveBinding(m, 'main'), undefined);
  assert.equal(effectiveBinding(m, 'ops'), 'agent:ops');
});

test('revision covers only the stores section and ignores key order', () => {
  const a = { plugins: { entries: { knowledge: { config: { stores: { x: { label: 'X', agents: ['main'] } } } } } }, gateway: { port: 1 } };
  const b = { gateway: { port: 2 }, plugins: { entries: { knowledge: { config: { stores: { x: { agents: ['main'], label: 'X' } } } } } } };
  assert.equal(storesRevision(readStoresSection(a)), storesRevision(readStoresSection(b)));
  assert.equal(storesRevision(readStoresSection({})), storesRevision({}));
});

test('policy gates default on and reject retired config shapes', () => {
  const maintenance = { enabled: true, schedule: '30 3 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  assert.deepEqual(parsePolicy(undefined), { operatorRead: true, writesEnabled: true, maintenance });
  assert.deepEqual(parsePolicy({ writesEnabled: false }), { operatorRead: true, writesEnabled: false, maintenance });
  assert.deepEqual(parsePolicy({ maintenance: { schedule: '*/5 * * * *', timezone: 'UTC' } }).maintenance, { enabled: true, schedule: '*/5 * * * *', timezone: 'UTC' });
  assert.throws(() => parsePolicy({ vault: {} }), /invalid/);
});
