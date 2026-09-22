# Ontology foundation

Implemented 2026-09-22. This is a read-only, synthetic-vault milestone, not real-vault activation or ingestion.

## Selection and local extension

Without `ontology.yaml`, a vault uses the shipped `knowledge-default@1.0.0` unchanged. The visible sample deliberately has no local overrides. To extend it, add this **manifest**, not a separate per-type schema:

```yaml
format: knowledge-ontology-v1
name: research
version: 1.0.0
description: Local research vocabulary
extends: knowledge-default
definitions:
  - name: researcher
    label: Researcher
    description: A person conducting research
    kind: page
    primitive: entity
    directory: researchers/
    aliases: [person]
    fields:
      - name: specialty
        label: Specialty
        type: string
        required: true
        values: [ecology, history]
  - name: investigates
    label: Investigates
    description: A researcher investigates a project
    kind: relationship
    directory: relationships/
    fields: []
    from_types: [researcher]
    to_types: [project]
```

This is a format example, not a user-facing private-vault configuration: the plugin still exposes only its bundled synthetic vault. Tests copy the sample into temporary directories to exercise local extensions.

Other local manifests live under `ontologies/`. `extends` resolves by manifest **name**, not a path or URL. Names must be unique, including the reserved bundled name. The active manifest is always `ontology.yaml`; unused local manifests do not activate themselves. Malformed active manifests, missing dependencies, duplicate identities, cycles, and chains longer than eight manifests prevent activation. Unused invalid manifests remain visible as diagnostics. There are no network imports or last-known-good fallback.

## Composition contract

Modeled on gbrain's reviewed `merge.ts` and `registry.ts` at [7cdc3e30a](https://github.com/garrytan/gbrain/tree/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/schema-pack). MIT attribution is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The investigation found no separately exported standalone ontology library; we adapt the small pure composition contract rather than depend on gbrain's full runtime.

- One parent, with child → borrowed → nearest parent → earlier ancestors precedence.
- Overrides replace the **whole definition**. Fields, aliases, prefixes, endpoint constraints, and flags are not deep-merged. Omitted page behavior flags become false; omitted prefixes use the primary directory; omitted fields' `required` becomes false.
- New page types precede root types in nearest-first order. Overridden root types retain their root positions. The first matching `path_prefixes` entry determines an absent page type. Explicit record types always win, and original metadata is never rewritten. Prefixes are literal directory prefixes, not regexes.
- `directory` is the primary filing home. A filing deviation is a diagnostic, not a move or invalidation. Other path prefixes support classification but do not create multiple primary homes.
- `aliases` form a symmetric, transitive, cycle-safe **query** graph. They do not rename records, activate an undeclared type, widen relationship endpoint constraints, or mean “is a subtype of.” Shared primitives alone do not expand queries. Unlike upstream's alias-cycle diagnostic, harmless query cycles are accepted because closure terminates on visited names and carries no directional semantics.
- Page and relationship names share one namespace. Changing an inherited name's record kind is rejected to prevent reinterpretation of existing records.
- Relationships are merged by name, child-first. They always connect stable page IDs. Omitted endpoint constraints allow any declared page type; nonempty `from_types`/`to_types` arrays restrict exact canonical type names.
- All five primitive categories are retained: `entity`, `media`, `temporal`, `annotation`, `concept`. They neither add fields nor activate algorithms. The fixed portable `page | claim | relationship` kinds remain a different layer.
- `behaviors: { extractable: boolean, expert_routing: boolean }` preserves explicit upstream intent. No extraction or expert service runs in this milestone, including when a flag is true. These flags cannot introduce code or phases.
- `fields` supports string, number, boolean, and string-array values, optional requiredness, and nonempty string enumerations. Unknown record metadata is preserved. Temporal category membership and string date fields do not imply date validation.

Selective borrowing is also supported:

```yaml
borrow_from:
  - ontology: research-library
    types: [researcher]
    relationships: [investigates]
```

As in the reviewed upstream implementation, borrowing is **leaf-local** and reads only a donor's own declarations, not its resolved ancestors. A parent's `borrow_from` is not implicitly activated by a child. Omitted lists borrow nothing. Missing requested definitions are rejected (stricter than upstream's silent omission). For overlapping donors, upstream ordering is retained: root page overrides use the last borrowed declaration, newly introduced pages and relationships use the first. Prefer disjoint donors or an explicit child override.

Unsupported phases, migrations, remote imports, inference rules, and executable settings are rejected, not silently ignored. Inheritance depth is deliberately bounded at eight for this small local reader.

## Default taxonomy review

Baseline: actual `gbrain-base-v2` at the reviewed commit, with **19**, not 15, page types. All canonical names, primitives, aliases, and ordered path prefixes are retained. The first upstream prefix is the primary filing directory.

| Canonical type | Primitive | Decision |
|---|---|---|
| person | entity | Retain; optional string `role` |
| company | entity | Retain upstream umbrella, including `organization` query alias; sample organization uses canonical `company` |
| media | media | Retain |
| tweet | media | Retain vocabulary; no social connector implied |
| social-digest | temporal | Retain vocabulary; no scheduled digest implied |
| analysis | media | Retain |
| atom | annotation | Retain as a page, **not** a replacement for independently attributed portable claims |
| concept | concept | Retain |
| source | media | Retain |
| deal | temporal | Retain vocabulary; no investment workflow implied |
| email | temporal | Retain vocabulary; no email connector implied |
| slack | temporal | Retain vocabulary; no Slack connector implied |
| meeting | temporal | Retain; optional string `occurred_at`, not a typed timestamp |
| conversation | temporal | Retain |
| writing | media | Retain |
| project | concept | Retain; optional string `status`, restricted to active/paused/completed/cancelled when supplied |
| note | concept | Retain; no unknown-type fallback or automatic retyping |
| event | temporal | Retain; no life-chronicle processor implied |
| diary | temporal | Retain; no journaling automation implied |

The optional project status deliberately relaxes the old fixture's requiredness: there is no supported workflow that needs to reject an otherwise useful project page solely for lacking status. All shipped typed fields are optional; user extensions can require fields.

Retain the 17 upstream explicit relationship names: `partner_of`, `relates_to`, `mentions`, `discusses`, `owes_to`, `awaiting_reply_from`, `founded`, `works_at`, `invested_in`, `advises`, `sourced_from`, `derived_from`, `supersedes`, `redirects_to`, `attended`, `authored`, `attributed_to`. Their endpoint types are unrestricted because the upstream manifest does not supply general endpoint constraints. No inverse-edge generation, regex inference, automatic identity redirection, or lifecycle mutation is implied by a name.

Add two constrained default relationships for explicit project responsibility: `leads` (person → project) and `supports` (company → project). They are shipped defaults, not sample-only overrides. Additional meanings require an extension rather than assumptions from English labels.

Defer upstream subtype matching, frontmatter-to-link extraction, inferred links, migration maps, calibration, enrichers, and autonomous phases: there are no supporting workflows in this read-only milestone. The manifest is intentionally **not gbrain wire-compatible**. Retaining all vocabulary is not a claim of workflow parity.

## Identity, inspection, and failure behavior

The SHA-256 fingerprint covers canonicalized effective definitions plus active name/version. Parent or donor edits affecting those definitions change the fingerprint even if the leaf manifest is unchanged. YAML formatting, comments, key order, source paths, and unused declarations do not. Array order remains significant. Provenance (source path, defining ontology/version) is returned separately. Future schema-dependent writes must bind to this fingerprint; no writable service exists yet.

`knowledge_ontology` and the native **Ontology** view use the same `SampleVault.inspectOntology()` result. The agent operation retains effective definitions, provenance, aliases, filing, raw manifests, activation state, fingerprint, diagnostics, and associated records. The browsing UI deliberately presents only the human-facing vocabulary: category groups, descriptions, optional/required fields, relationship endpoints, search terms, and associated records. Fingerprints, effective JSON, source manifests, inheritance chains, and development status are not rendered. Page types and relationships have separate views; search and category filters work on local snapshots, including custom types. Invalid active ontologies leave records inspectable but mark ontology-dependent validation unavailable. The fixed claim envelope and evidence checks still run. Diagnostics are not a mutation history, and all reads preserve source bytes.

`knowledge_records` and the Records view use the same alias-aware `type` filter. Relationship labels are exact-match filters, not page aliases. The `knowledge_schemas` prototype operation is replaced by `knowledge_ontology`; there is no external stable API compatibility promise for this unreleased sample milestone.

## Verification and next boundary

`test/ontology.test.mjs` exercises a researcher extension end to end, including valid/invalid fields, relationship endpoint constraints, source inspection, symmetric filtering, filing diagnostics, inheritance ordering, borrowing, changed-parent fingerprints, explicit type precedence, malformed manifests, unavailable dependencies, cycle/depth rejection, and byte-preserving failure.

The next milestone remains a host-authorized real-vault create/edit path shared by UI and agents: access enforcement, revision checks, conflict preservation, and recoverable publication **before** document/meeting ingestion. Distribution, discovery, automatic migrations, and autonomous processing remain deferred.

## Vocabulary atlas refresh — 2026-09-22

The default vocabulary remains unchanged: 19 page types and 19 relationships. Descriptions now explain each type in plain language. The five primitive categories appear as People & things, Ideas & projects, Sources & writing, Events & conversations, and Annotations. Relationship groups are presentation-only; unfamiliar relationship types remain visible under Other connections.

Rechecked upstream packs: `gbrain-base-v2` has only `person` and `company` as entities. Its `company` subtypes include product and org. The separate [recommended pack](https://github.com/garrytan/gbrain/blob/master/src/core/schema-pack/base/gbrain-recommended.yaml) additionally classifies place, civic, and project as entities; the separate [company-brain pack](https://github.com/garrytan/gbrain/blob/master/src/core/schema-pack/base/company-brain.yaml) adds customer, competitor, supplier, and distributor. These are not missing base-v2 defaults. Per user clarification, no types were added and Project remains in the concept category.
