import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayAliases } from '../dist/knowledge-presentation.js';

test('display aliases hide account keys, merged titles and labelled variants of known names', () => {
  const aliases = ['Jacob', 'jacobtomlinson', 'discord:171650257380179968', 'Jacob (Windows-node standup participant)',
    'Jacob (August 21 security standup participant)', 'Jacob Tomlinson (Discord identity reference)'];
  assert.deepEqual(displayAliases('Jacob Tomlinson', aliases, ['Jacob (August 21 security standup participant)']), ['Jacob', 'jacobtomlinson']);
});

test('a labelled alias with an unknown base name is kept', () => {
  assert.deepEqual(displayAliases('Gideon', ['Shakker', 'Gideon (Control UI)', 'Sam (guest)'], []), ['Shakker', 'Sam (guest)']);
});
