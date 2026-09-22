# Investigation: gbrain primitives and schema packs

Date: 2026-09-22
Status: research and recommendation; not an adopted specification or implemented feature.

## Recommendation

**Base Knowledge's domain-schema architecture on gbrain's schema-pack system. Retain its five semantic primitive categories. Adapt specific contracts where Knowledge has demonstrably different requirements.**

The evidence does not justify discarding packs as unnecessary complexity. Their composition, common resolution, vocabulary, query semantics, inspection, and evolution mechanisms solve problems Knowledge will also face. The five primitives are inexpensive conceptual structure worth retaining, but are less behaviorally enforced than earlier discussion suggested.

This is not a recommendation to import the entire gbrain runtime, copy every bundled default unreviewed, or claim manifest compatibility before implementing it.

## Scope and method

Reviewed upstream commit [7cdc3e30a](https://github.com/garrytan/gbrain/commit/7cdc3e30a898665a8c87b0c06937f6366f759f6c) (v0.51.8.0, September 22), not only the existing September 17 checkout. Fetched upstream metadata and inspected an isolated archive; did not change the existing checkout's working files.

Compared design documentation, manifest validation, resolver/merge implementation, runtime call sites, bundled packs, and relevant upstream test source. Executed nine focused behavioral probes against upstream modules with Bun 1.3.14 and Zod 4.3.6. No live brain, database, model, or paid service was used. This was not the full upstream test suite or a production end-to-end verification.

Compared Knowledge's current model and spec §4.4. Knowledge remains a read-only fixture explorer; no runtime/schema/sample changes are made by this investigation.

## 1. What problem the architecture solves

Gbrain's old closed page-type union did not describe actual user data: users and ingestion pipelines produced additional names regardless. The pack design makes vocabulary runtime-configurable without requiring engine changes for every domain type. It separates:

1. **Storage and engine contracts:** pages, links, facts/takes, access rules, and implemented algorithms.
2. **Semantic primitive:** a closed category assigned to each page type.
3. **Pack-defined domain type:** open names, filing prefixes, aliases, explicit behavior flags.
4. **Resolved pack:** the composed vocabulary and rules consumers consult.
5. **Workflow implementation:** code/skills that interpret those rules.

The original design included a larger ecosystem—discovery, suggestions, distribution, authoring, multiple sources—not just serialization. That broader scope explains much of the surrounding complexity. It does not make the shared resolver/composition core dispensable.

Sources: [type model](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/types.ts), [original design](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/docs/designs/V038_SCHEMA_PACKS.md). The design document describes intent; implementation takes precedence where they differ.

## 2. What the five primitives actually do

| Primitive | Defaults described in the primitive table | Representative bundled types |
|---|---|---|
| entity | Identity/contact metadata, entity relationship verbs, expert eligibility | person, company |
| media | Source/author/date metadata and citation verbs | media, source, writing, analysis |
| temporal | Date/attendees/duration/location and attendance verbs | meeting, conversation, event |
| annotation | Confidence, validity and source metadata | atom |
| concept | Tags and conceptual relationships | concept, project, note |

These are **not five storage layouts or five rigid record schemas**. Nor are they subtyping rules: sharing a primitive does not make two types interchangeable in queries.

### Important correction to the earlier explanation

The source comments describe primitive-default inheritance, but the current runtime does not implement that description uniformly—or, for the defaults helper, wire it into the runtime at all:

- A repository-wide source search found `getPrimitiveDefaults` defined and re-exported, but no production caller applying its values.
- Manifest parsing defaults `extractable` and `expert_routing` to **false**, regardless of primitive.
- The add-type mutator also supplies false when these flags are omitted.
- Pack resolution composes definitions but does not apply primitive defaults.
- The primitive enum is enforced during validation; primitive values are also used in inspection and authoring.
- The named frontmatter defaults are not typed field schemas and do not require, for example, a meeting date.

**Observed counterexample:** a new type with only `name: researcher, primitive: entity` does not become extractable or expert-routed, although the entity defaults table says both defaults are true. The parse and resolution probes verified this.

This is a precise implementation gap, not proof that primitives are a bad abstraction. Retaining the vocabulary costs little; silently promising unimplemented inheritance would be the mistake. Initially make behavior flags explicit, as the bundled packs do. If we later activate inherited primitive defaults, that needs a versioned contract and tests because it changes behavior.

Sources: [primitive table](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/primitives.ts), [manifest](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/manifest-v1.ts), [add-type mutation](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/mutate.ts), [resolver](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/registry.ts).

## 3. Where packs are genuinely load-bearing

| Path | Actual dependency | Qualification |
|---|---|---|
| Markdown type inference | Ordered `page_types[].path_prefixes` | Explicit frontmatter type wins; legacy inference remains when no pack is supplied. |
| Typed retrieval | Explicit alias graph expands type filters | Separate from primitive categories; current engine helper rejects mixed-pack, type-filtered source queries. |
| Expert discovery | `expert_routing` selects candidate types | This comes from per-type settings, not automatic entity-primitive inheritance. |
| Link extraction | Link inference rules and frontmatter-to-link mappings | Includes real regex/type consumers; legacy fallback behavior remains. |
| Explicit link/capture vocabulary checks | Active pack declares allowed names | Some write paths deliberately proceed without vocabulary enforcement when the pack cannot load. |
| Atom extraction | Pack extractable types contribute to eligibility | Combined with a legacy floor and synthesis exclusions; not a universal on/off switch. |
| Autonomous cycle | Pack phase declarations opt into selected phases | Does not define new executable algorithms or disable all baseline phases. |
| Calibration | Pack declares domains and selects closed-enum aggregators | Names are extensible; executable algorithm implementations remain in code. |
| Schema maintenance | Inheritance, borrowing, linting, mutation, retyping, migration mappings | Changes can affect existing corpus interpretation, not merely UI labels. |
| Existing company repositories | Dedicated pack extends base taxonomy, adds ownership/decision relationships | Latest upstream supplies a concrete extension use case beyond the original personal taxonomy. |

Sources: [Markdown inference](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/markdown.ts), [typed-query boundary](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/query-types.ts), [expert operation](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/ops/insights.ts), [link extraction](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/link-extraction.ts), [write vocabulary](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/write-vocabulary.ts), [atom extraction](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/cycle/extract-atoms.ts), [cycle gates](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/cycle.ts), [calibration](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/cycle/calibration-profile.ts), [company-brain pack](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/base/company-brain.yaml).

**Counterfactual:** removing packs would require relocating these rules into hardcoded lists, workflow prompts, or multiple configuration formats. Knowledge's current loose schema files cover field validation, but not this shared semantic/configuration role.

### Remaining fixed-type dependencies matter

The facts-write backstop still uses a fixed eligibility list and rescue paths. A pack can declare a custom type extractable without making this backstop accept it. Conversation-facts extraction has its own fixed type list. The enrichment service still accepts person/company, and completeness scoring still selects rubrics from a code-owned type map; the pack enrichment lookup helpers do not have production consumers in the inspected source.

Therefore “all extraction and enrichment is pack-driven” is not accurate. Packs expose extension points, but custom vocabulary alone does not guarantee participation in every workflow. This reinforces the need to test extension behavior through actual supported operations.

Sources: [facts eligibility](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/facts/eligibility.ts), [conversation types](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/facts/conversation-types.ts), [enrichment service](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/enrichment-service.ts), [completeness scorer](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/enrichment/completeness.ts).

## 4. Composition is substantive, not a cosmetic wrapper

The resolver implements these distinct contracts:

- One parent through `extends`, bounded inheritance depth, and cycle rejection.
- Selective `borrow_from` of explicitly named page/link types from a donor's own declarations—not its whole resolved ancestry.
- Precedence: child, borrowed definitions, nearest parent, then earlier ancestors.
- Type overrides replace the **whole type definition**, not a deep merge of its fields. An override that omits expert routing resets it to the parser's false default.
- New derived types precede base types for path matching; overriding a base type retains its base position.
- Six categories inherit: page types, link types, frontmatter mappings, enrichable types, filing rules, and takes kinds.
- Phases, calibration domains, and migration declarations are child-local. Installing a vocabulary extension does not implicitly adopt a parent's optional execution phases.
- Takes kinds combine by union; inheritance cannot narrow that vocabulary.
- Aliases form a separate symmetric query-expansion graph. They are not “is-a” inheritance. A researcher/person alias connects their searches; an unrelated entity-primitive type remains separate.

These rules carry real consequences and already have upstream regression cases. Reusing them is preferable to inventing slightly different, undocumented merge behavior.

Sources: [merge](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/merge.ts), [registry](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/registry.ts), [alias closure](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/closure.ts), [merge tests](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/test/schema-pack-merge.test.ts).

### Identity must include effective dependencies

The usual `name@version+hash` identity hashes the leaf manifest. A probe confirmed that changing a parent can alter the resolved manifest without changing that leaf identity. Registry invalidation tracks dependencies separately; this finding alone does not establish an end-to-end stale-cache bug.

Latest upstream already provides a stronger pattern: `approvedSchemaIdentity` additionally hashes the entire resolved manifest and rechecks it before connecting a repository. Knowledge's schema-dependent writes should use that effective fingerprint, not only the leaf version/hash.

Source: [approved effective schema identity](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/engine-resolution.ts).

## 5. What this means for Knowledge

Our `page / claim / relationship` kinds and gbrain's semantic categories occupy different layers. A meeting can be a `page`, of domain type `meeting`, classified as `temporal`; evidence-backed claims about it remain independently addressable claims. An annotation-type page is not automatically equivalent to our portable claim record.

Recommended conceptual boundary:

```text
Fixed portable records: page | claim | relationship
                         |
Domain pack: types + five semantic categories + aliases + filing + relationships
                         |
One validated, resolved schema and effective fingerprint
                         |
Shared UI / agent operations / ingestion / retrieval
```

### Adopt, adapt, or defer—with reasons

| Element | Recommendation | Evidence/reason |
|---|---|---|
| Named/versioned default pack and shared resolver | Adopt | Prevents examples, workflows, and UI from inventing competing vocabularies. |
| Five primitive names | Retain | Useful common categories; no demonstrated benefit from replacing them. Do not confuse them with enforced field or workflow contracts. |
| Explicit behavior settings and aliases | Adopt semantics | Behavior opt-in and query equivalence are separate, demonstrated concerns. |
| Local inheritance | Bring forward into foundation | Lets defaults evolve independently of user extensions; upstream has tested precedence rules. This revises the current deferral. |
| Selective borrowing | Preserve upstream design; implement when exposing composition support | If initially unsupported, reject it explicitly. Do not silently ignore it or invent a competing import mechanism. |
| Pack inspector, lint, affected-record diagnostics | Adopt with the foundation | Schema malleability is unsafe to use if users cannot see the effective interpretation. |
| Typed metadata and relationship endpoint constraints | Add a Knowledge-specific validation layer | Gbrain's manifest is not a typed record-field validator. Our spec explicitly requires this. Its inference endpoint matchers are not general edge-validation constraints. |
| Portable claim/relationship identities, provenance, revisions, access | Keep our established contracts | Packs configure domain meaning; they do not replace our Markdown authority and correction/recovery requirements. |
| Unresolved-schema writes | Adapt to reject typed writes | Gbrain's best-effort vocabulary loader can return no pack and allow a write. Our spec requires unavailable/incompatible schema to block dependent writes. |
| Effective schema hashing | Follow latest upstream's resolved-manifest pattern | Parent edits must invalidate schema-dependent write expectations. |
| Seven selection tiers and multiple source packs | Do not copy now | Knowledge has one store per agent and no gbrain-style source namespaces; host-bound vault config should select within that authority. |
| Pack marketplaces/distribution, automatic discovery and migration | Defer | Not needed for the scoped ingest–inspect–retrieve–correct loop; preserve extension seams. |
| Dreaming, expert services, calibration and enrichment engines | Defer unsupported workflows | OpenClaw owns execution and provider facilities; choosing a pack must not imply that these gbrain engines exist here. |

**This is architectural adoption with scoped implementation, not a new “simpler schema system.”** Directly importing gbrain as a runtime dependency is a different decision: its published exports do not expose a dedicated standalone schema-pack library. Prefer adapting the relevant pure modules and regression cases, retaining MIT attribution, or collaborating on extraction upstream. A concrete packaging spike is still needed before claiming code-level drop-in reuse.

Our current specification explicitly defers inheritance. This report recommends changing that boundary; it does not silently amend the approved spec.

## 6. Default taxonomy and examples

Start the defaults review from the actual `gbrain-base-v2` manifest, not the current sample taxonomy. The inspected manifest has **19 types**, despite older “15-type” comments: person, company, media, tweet, social-digest, analysis, atom, concept, source, deal, email, slack, meeting, conversation, writing, project, note, event, diary.

Do not assume every type/workflow should ship immediately. For each, record retain/defer/adapt plus the reason. For example, gbrain classifies project as concept; its company umbrella includes organization aliases. Neither should be replaced merely because our sample used another spelling.

Then review field requirements and relationship meanings against supported workflows. The primitive field-name lists alone cannot supply sound field types, requiredness, reference constraints, or date semantics. That part remains design work even if we adopt packs wholesale.

Required example policy:

- The visible sample uses the shipped default pack unchanged.
- No sample-only types, relationships, or behavior overrides.
- A sample may exercise only a subset of defaults; it need not display every type.
- Invalid schema/record cases belong in separate validation fixtures.
- Tests must demonstrate that an added type participates in each workflow we claim supports extensions—not merely that YAML parses.

Source: [actual default pack](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack/base/gbrain-base-v2.yaml).

## 7. Behavioral verification

All nine focused probes passed:

1. Entity classification alone does not apply expert/extraction defaults at parse time.
2. Resolution does not apply those defaults either.
3. Unknown primitive rejected.
4. A type with a typed `fields` declaration is rejected by gbrain's strict manifest.
5. Overriding a type replaces omitted parent settings.
6. Parent phases do not inherit.
7. Alias expansion connects declared equivalents, not all same-primitive types.
8. Pack extraction eligibility does not change the fixed facts-backstop allowlist.
9. Leaf identity alone does not capture an inherited effective-schema change.

Reproduction script: [gbrain-schema-probes.mjs](research/gbrain-schema-probes.mjs). It accepts the upstream checkout/archive root as its first argument, requires that root to resolve Zod 4.3.6, and runs with Bun. It imports the actual upstream modules rather than reproducing their algorithms. No full upstream integration-suite pass is claimed.

## Bottom line

The investigation strengthens the case for adopting gbrain's **pack architecture**. It narrows what we should claim about **primitives**: they provide a closed semantic classification and an intended defaults model, not today's universal behavioral enforcement.

The justified departures are precise: typed record validation, independent portable records, host-bound selection, and schema-dependent write guarantees. “Packs seem too complex” is not supported as a reason to replace them.
