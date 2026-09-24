# Designer feedback: implementation record

Companion to [the design handoff](DESIGN_HANDOFF.md). Implemented September 23–24,
2026. This records engineering behavior, not guarantees about an agent's future
extraction quality.

## Implemented contracts

- **Non-disruptive live refresh:** scoped content fingerprints skip unchanged
  polling; changed views stage offscreen and preserve scroll, focus, expansion,
  loaded connection pages, and unchanged evidence cards. Failed background
  refresh keeps the last readable view. Disconnect/vault changes still clear it.
- **Existing structured data:** claim cards resolve owners and source pages in
  the same scan. Browse distinguishes occurrence time from save time. Date-only
  values retain their calendar date; instants show a timezone. Missing owner/due
  date remains unknown, not an inferred task status.
- **Evidence:** unique retained files and cited passages have separate counts;
  repeated passages group under their file. Exact repeated citations collapse,
  but different locators/attributions and original/derived files remain distinct.
- **Fixture classification:** `record_class: fixture` excludes synthetic records
  from current discovery, search, connections, counts and ordinary activity.
  Exact reads, all-lifecycle inventory and history remain available. New tests
  use isolated temporary vaults, never the user's production store.
- **Source context:** `source_page` associates a record with an actual source
  page. `source_event: true` is allowed only for an event claim with a source
  page. Recent groups by explicit source before pagination; the UI calls these
  source groups, not ingestion jobs. Event associations retain entity timelines.
- **Identity:** `identity: {status: partial|resolved, context, candidates?}`.
  Candidates contain an existing scoped page ID, basis and verified evidence.
  A candidate does not merge records; a handle does not imply a missing surname.
- **Attribution:** `attribution_confidence: {level: high|medium|low, basis,
  evidence}` describes speaker/identity attribution, not claim truth or origin.
- **Continuity:** `continuity: [{id, relation: reaffirms|updates|contradicts,
  basis, evidence}]` relates claims without superseding or withdrawing them.
  Semantic correction remains `knowledge_correct`; no similarity-based merging.

## Write/API behavior

Creation tools and page saves accept these optional annotations. Existing records
can use chat-only `knowledge_annotate` with `requestId`, `id`, observed
`expectedRevision`/`expectedHash`, `reason`, `annotations`, optional `addEvidence`
and optional `expectedVaultId`. Supplied annotation fields replace those fields;
omitted fields remain unchanged. Added support is deduplicated, not substituted
for original evidence. Empty `continuity`/`candidates` clears those lists.

Annotations preserve assertion body and lifecycle, use the existing publication
journal, validate scoped references and supplied evidence, retain local history,
and replay the same request/payload safely. Inactive records permit only fixture
classification; historical assertions are not rewritten. The browser cannot
invoke writes. No new ingest-job store, merge UI, scheduler or task tracker exists.

Additive read fields are optional for compatibility. `recent(groupBySource: true)`
opts into grouping; older clients retain the flat activity contract. The status
`snapshot` is an opaque change token, not a record count or a public content hash.

## Workflow changes

Skills now require entity-focused introductions, evidence-qualified State,
dated Timeline entries, canonical names outside source quotations, structured
extraction/readback, and cross-source reconciliation before creating assertions.
They distinguish duplicate imports, reaffirmation, updates, conflicting accounts
and correction. A 3–5-item quality gate precedes bulk publication. Portable source
references stay; repeated generic evidence-boundary prose is discouraged.

## Verification

The deterministic suite exercises supported authored outputs, retry/conflict
handling, scope fences, fixture exclusion, verified annotation evidence, and
source-group cursor pagination. Browser integration covers actual navigation,
idle DOM preservation, changed-data refresh, expanded evidence retention and
background failures, with desktop/mobile screenshots.

These checks do **not** establish autonomous extraction quality on unseen
documents. The live cleanup is a reviewed, evidence-grounded curation pass, not
an unattended agent benchmark. Missing owners/deadlines/identities are not filled
by guesswork. See the execution report for observed validation and cleanup totals.
