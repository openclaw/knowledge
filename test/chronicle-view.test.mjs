import assert from 'node:assert/strict';
import test from 'node:test';
import { temporalSelectionError, temporalQuery } from '../dist/chronicle-view.js';
const selection = (changes = {}) => ({since:'',until:'',entity:'',timeField:'occurred_at',...changes});

test('temporal UI accepts only real explicit calendar dates or timezone-bearing timestamps', () => {
  for (const since of ['2026-10-04','2024-02-29','2026-10-04T12:30:00-07:00']) assert.equal(temporalSelectionError(selection({since})),'');
  for (const since of ['yesterday','2026-02-29','2026-10-04T12:30:00','2026-10-04T24:30:00Z']) assert.match(temporalSelectionError(selection({since})),/Since must/);
  assert.match(temporalSelectionError(selection({since:'2026-10-05',until:'2026-10-04'})),/Since must not be after Until/);
  assert.equal(temporalSelectionError(selection({since:'2026-10-04T23:59:59Z',until:'2026-10-04'})),'');
});

test('shared text search date predicates omit blanks and do not leak timeline entity or snapshot', () => {
  assert.deepEqual(temporalQuery(selection()),{timeField:'occurred_at'});
  assert.deepEqual(temporalQuery(selection({timeField:'due_at',since:'2026-10-04',entity:'person-1',snapshot:'old'})),{timeField:'due_at',since:'2026-10-04'});
});
