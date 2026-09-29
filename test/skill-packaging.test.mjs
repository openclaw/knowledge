import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { contract } from '../dist/contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['knowledge-capture', 'knowledge-correct', 'knowledge-entities', 'knowledge-ingest', 'knowledge-meeting-ingest', 'knowledge-recall', 'knowledge-source-ingest'];

test('packaged skills have discoverable metadata and self-contained readable references', async () => {
  execFileSync(process.execPath, ['scripts/sync-skill-references.mjs', '--check'], { cwd: root });
  const manifest = JSON.parse(await readFile(path.join(root, 'openclaw.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.skills, ['./skills']);
  const skills = (await readdir(path.join(root, 'skills'))).filter(n => n.startsWith('knowledge-')).sort();
  assert.deepEqual(skills, names);
  const tools = new Set(Object.values(contract.operations).flatMap(op => op.tool ? [op.tool.name] : []));
  assert.deepEqual([...manifest.contracts.tools].sort(), [...tools].sort());
  assert.ok(tools.has('knowledge_recall'));
  for (const name of names) {
    const dir = path.join(root, 'skills', name);
    const pending = ['SKILL.md'], seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const contents = await readFile(path.join(dir, file), 'utf8');
      if (file === 'SKILL.md') {
        const frontmatter = parse(contents.match(/^---\n([\s\S]*?)\n---/)[1]);
        assert.equal(frontmatter.name, name);
        assert.ok(frontmatter.description.length > 0 && frontmatter.description.length <= 1024);
      }
      for (const [, link] of contents.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = path.normalize(path.join(path.dirname(file), link));
        assert.ok(!target.startsWith('..') && !path.isAbsolute(target), `${name}: reference escapes skill bundle`);
        pending.push(target);
      }
      for (const [tool] of contents.matchAll(/\bknowledge_[a-z_]+\b/g)) {
        assert.ok(tools.has(tool), `Unavailable tool ${tool} in ${name}/${file}`);
      }
    }
  }
});

test('npm payload includes all skill entrypoints, references and upstream attribution', () => {
  // No lifecycle writes or network required to inspect the shipping payload.
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: root, encoding: 'utf8' }));
  const files = new Set(result[0].files.map(f => f.path));
  for (const name of names) {
    assert.ok(files.has(`skills/${name}/SKILL.md`));
    assert.ok(files.has(`skills/${name}/references/conventions.md`));
    if (name !== 'knowledge-recall') assert.ok(files.has(`skills/${name}/references/publication.md`));
    if (name === 'knowledge-source-ingest') {
      assert.ok(files.has(`skills/${name}/references/source-manifest.md`));
      assert.ok(files.has(`skills/${name}/scripts/source-manifest.mjs`));
      assert.ok(files.has(`skills/${name}/scripts/discrawl-normalize.mjs`));
    }
  }
  assert.ok(files.has('THIRD_PARTY_NOTICES.md'));
  assert.ok(files.has('docs/WORKFLOWS.md'));
  assert.ok(files.has('scripts/sync-skill-references.mjs'));
  assert.ok(![...files].some(file => file.startsWith('test/')));
});
