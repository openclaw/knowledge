import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Check } from 'typebox/value';
import { normalizeOpenAIStrictCompatSchema } from 'openclaw/plugin-sdk/provider-tools';
import { projectRuntimeToolInputSchema } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { validateJsonSchemaValue } from 'openclaw/plugin-sdk/json-schema-runtime';
import { BatchInput } from '../dist/ingestion-contract.js';

const evidence = { path: 'sources/meeting.txt', sha256: 'a'.repeat(64) };
const batch = items => ({
  requestId: '00000000-0000-0000-0000-000000000001',
  expectedVaultId: '00000000-0000-0000-0000-000000000002',
  expectedOntologyFingerprint: 'a'.repeat(64), items,
});
const page = { key: 'meeting', kind: 'page', input: { title: 'Meeting', body: 'Notes', attachments: [evidence] } };
const claim = { key: 'action', kind: 'claim', input: {
  title: 'Action', body: 'Send report', claim_kind: 'commitment', assertion_origin: 'source',
  attribution: 'Meeting', evidence: [evidence], owner: '@person', entities: ['@person'],
} };
const relationship = { key: 'link', kind: 'relationship', input: {
  title: 'Attended', body: 'Attended meeting', from: '@person', to: '@meeting',
  label: 'attended', attribution: 'Meeting', evidence: [evidence],
} };

test('batch schema retains closed, kind-specific inputs and nested evidence through host projection', () => {
  const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(BatchInput));
  assert.deepEqual(projected.violations, []);
  const accepts = input => {
    const local = Check(BatchInput, input);
    const host = validateJsonSchemaValue({ schema: projected.schema, value: input }).ok;
    assert.equal(host, local, 'host and backend validation must agree');
    return local;
  };
  const annotated = structuredClone(page);
  annotated.input.identity = { status: 'partial', context: 'Two possible speakers', candidates: [{ id: '@person', basis: 'Name', evidence: [evidence] }] };
  annotated.input.attribution_confidence = { level: 'medium', basis: 'Transcript', evidence: [evidence] };
  annotated.input.continuity = [{ id: '@prior', relation: 'updates', basis: 'New notes', evidence: [evidence] }];
  annotated.input.record_class = 'fixture';
  assert.ok(accepts(batch([annotated, claim, relationship])));
  const emptyAttachments = structuredClone(page);
  emptyAttachments.input.attachments = [];
  assert.ok(accepts(batch([emptyAttachments])));
  for (const mutate of [
    value => { delete value.items[1].input.claim_kind; },
    value => { value.items[0].kind = 'claim'; },
    value => { value.items[0].input.owner = '@person'; },
    value => { value.items[1].input.evidence = []; },
    value => { value.items[1].input.owner = '@bad key'; },
    value => { value.items[2].input.from = 12; },
    value => { value.items[0].input.identity.candidates[0].evidence[0].sha256 = 'bad'; },
    value => { value.items[0].input.identity.candidates[0].id = '@bad key'; },
    value => { value.items[0].input.attribution_confidence.evidence = []; },
    value => { value.items[0].input.attribution_confidence.evidence = Array(21).fill(evidence); },
    value => { value.items[0].input.continuity[0].evidence = []; },
    value => { value.items[0].input.continuity[0].relation = 'replaces'; },
    value => { value.items[0].input.requestId = value.requestId; },
    value => { value.items[0].input.source = { text: 'inline', attribution: 'source' }; },
  ]) {
    const input = structuredClone(batch([annotated, claim, relationship]));
    mutate(input);
    assert.equal(accepts(input), false, String(mutate));
  }
});

// Codex's input schema projection retains these keywords and lowers const to
// enum before applying its 5,000-byte compaction threshold. An oversized schema
// loses $defs, then nested objects, hiding batch fields as Array<unknown>.
function codexShape(schema) {
  const result = {};
  // Installed Codex 0.155.1 retains minItems, unlike the older sibling checkout.
  for (const key of ['type', 'enum', 'required', '$ref', 'minItems']) if (key in schema) result[key] = schema[key];
  if ('const' in schema) result.enum = [schema.const];
  if (!result.type && result.enum && !result.$ref) result.type = 'string';
  for (const key of ['properties', '$defs', 'definitions']) if (schema[key]) {
    result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, child]) => [name, codexShape(child)]));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) result[key] = schema[key].map(codexShape);
  if (schema.items) result.items = codexShape(schema.items);
  if ('additionalProperties' in schema) result.additionalProperties = typeof schema.additionalProperties === 'boolean'
    ? schema.additionalProperties : codexShape(schema.additionalProperties);
  if (result.type === 'object') result.properties ??= {};
  return result;
}

test('projected batch schema stays below the host compaction budget with resolvable shared definitions', () => {
  const { schema } = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(BatchInput));
  const projected = codexShape(schema);
  const bytes = Buffer.byteLength(JSON.stringify(projected));
  assert.ok(bytes <= 5000, `batch schema would be compacted (${bytes} bytes)`);
  let references = 0;
  const expand = node => {
    if (node.$ref) {
      references++;
      assert.match(node.$ref, /^#\/\$defs\/\w+$/);
      const target = projected.$defs[node.$ref.split('/').at(-1)];
      assert.ok(target, `unresolved ${node.$ref}`);
      const { $ref, ...siblings } = node;
      return { ...expand(target), ...siblings };
    }
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$defs').map(([key, value]) => [key, expand(value)]));
  };
  const expanded = expand(projected);
  assert.ok(references <= 32, `exceeds code-mode reference expansion budget (${references})`);
  const kinds = expanded.properties.items.items.anyOf;
  assert.deepEqual(kinds.map(kind => kind.properties.kind.enum[0]), ['page', 'claim', 'relationship']);
  assert.ok(kinds[1].properties.input.required.includes('claim_kind'));
  assert.equal(kinds[2].properties.input.properties.from.type, 'string');
  assert.equal(kinds[0].properties.input.properties.attachments.items.properties.sha256.type, 'string');
  assert.equal(kinds[0].properties.input.properties.attachments.minItems, undefined);
  assert.equal(kinds[1].properties.input.properties.evidence.minItems, 1);
  assert.equal(kinds[1].properties.input.properties.evidence.items.properties.sha256.type, 'string');
});

test('batch static types discriminate payloads and preserve nested field types', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-batch-types-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'check.mts');
  const source = fileURLToPath(new URL('../src/ingestion-contract.js', import.meta.url));
  await writeFile(file, `
    import type { BatchItem, BatchInput } from ${JSON.stringify(source)};
    declare const batch: BatchInput;
    const item: BatchItem = batch.items[0];
    const title: string = item.input.title;
    if (item.kind === 'claim') {
      const kind: 'fact' | 'preference' | 'decision' | 'commitment' | 'event' | 'belief' = item.input.claim_kind;
      const hash: string = item.input.evidence[0].sha256;
      // @ts-expect-error claims have no relationship endpoints
      item.input.from;
    }
    if (item.kind === 'relationship') {
      const from: string = item.input.from;
      // @ts-expect-error relationships have no claim kind
      item.input.claim_kind;
    }
    // @ts-expect-error page body is required
    const missing: BatchItem = { key: 'page', kind: 'page', input: { title: 'Page' } };
    // @ts-expect-error invalid assertion origin
    const origin: Extract<BatchItem, { kind: 'claim' }>['input']['assertion_origin'] = 'guessed';
    // @ts-expect-error batch-level request IDs are not item input fields
    item.input.requestId;
  `);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022,
    strict: true, noEmit: true, skipLibCheck: true, types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});
