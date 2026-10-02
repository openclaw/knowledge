import assert from 'node:assert/strict';
import test from 'node:test';
import { readLocation, locationParams } from '../dist/page-location.js';

test('page addresses round-trip stable identity, filters, pagination and encoded text', () => {
  const input = {agent:'research',vault:'store-123',record:'record-123',view:'browse',kind:'claim',type:'belief',q:'A & B / café',filter:'road map',history:'1',origin:'user_belief',offset:'50',back:'0,20,40',upper:'84',before:'30'};
  const url = new URL('https://example.test/console/plugin?plugin=knowledge&id=overview');
  for (const [key,value] of Object.entries(locationParams(readLocation(input)))) url.searchParams.set(`p.${key}`,value);
  const restored = Object.fromEntries([...url.searchParams].filter(([key])=>key.startsWith('p.')).map(([key,value])=>[key.slice(2),value]));
  assert.deepEqual(restored,input);
});

test('malformed URL filters never produce out-of-contract pagination or cursor input', () => {
  for (const offset of ['-1','501','1e2','NaN','1.5','9007199254740992']) assert.equal(readLocation({offset}).offset,0);
  assert.equal(readLocation({upper:'3',before:'4'}).cursor,undefined);
  assert.equal(readLocation({view:'invalid',kind:'invalid',history:'true',origin:'invalid'}).tab,'recent');
  assert.deepEqual(locationParams(readLocation({record:'x'.repeat(97),q:'x'.repeat(201)})),{});
});

test('settings addresses and missing optional parameters use explicit defaults', () => {
  assert.deepEqual(locationParams(readLocation({view:'settings',section:'vocab',agent:'main',vault:'one'})),{agent:'main',vault:'one',view:'settings',section:'vocab'});
  assert.deepEqual(locationParams(readLocation()),{});
});

test('Browse back trail survives remount and rejects invalid or looping cursors', () => {
  assert.deepEqual(readLocation({offset:'40',back:'0,20'}).back,[0,20]);
  for (const back of ['40','0,40','20,0','0,0','-1','1e1','0,500','0,x','9'.repeat(2100)]) assert.deepEqual(readLocation({offset:'40',back}).back,[]);
  assert.deepEqual(readLocation({offset:'0',back:'0,20'}).back,[]);
});
