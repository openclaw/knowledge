# Knowledge UI redesign: supporting contracts

Date: 2026-09-23

Status: implementation specification, **not a claim that these APIs have shipped**.

Baseline inspected: `d176fbf9f605d27e339da7c44986d27cb91bd454`.

Design input: the supplied `Openclaw design system.zip`, particularly
`ui_kits/control-ui/KnowledgeV2Screen.jsx`, `knowledge-v2.html`, and
`docs/knowledge-redesign-report.md`. This document resolves the report's open
questions, corrects its assumptions against the baseline, and specifies the
remaining backend/host work. The prototype's example people, feed, and counts
are fixtures, never production defaults.

## Product decision and work boundaries

Knowledge is an inspector for **what the agent saved**. People and things,
assertions, and evidence lead; files and operational metadata are secondary.
All user-initiated knowledge changes go through conversation and agent tools.
Remove page/claim/relationship creation and editing forms from the browser;
do not add correction, withdrawal, identity-resolution, or Markdown editors.
Chat handoffs prepare a request for the user to review and send. They never
send a message or perform a knowledge mutation automatically.

Three concurrent workstreams:

1. Lifecycle implementation: tool-mediated correction/withdrawal, recoverable
   publication, receipts, impact reporting, historical inspection, and safeguards.
2. UI implementation: match the supplied layout and interaction hierarchy using
   working read contracts, honest fallbacks, and no browser mutation calls.
3. This specification: data/read APIs and host integration needed to close the
   gap between that UI and the complete design. These additional APIs are future
   implementation work, not implicitly included in the lifecycle milestone.

No new database, graph service, UI framework, paid platform, background agent,
or approval queue is required. Reuse the plugin's SQLite state, publication
journal, FTS5, ontology, evidence inspection, and host styling. The supplied
React kit is a visual reference, not a requirement to replace the plugin stack.

## 1. Baseline verification and important corrections

| Design assumption | Verified implementation and required adjustment |
| --- | --- |
| Claim kind/origin and evidence already exist | Yes. Canonical origin values are `source`, `user_belief`, `agent_inference`, **not** `user`/`inferred`. Claim kinds also include `event`, omitted by the prototype. |
| Browse handles arbitrary offset | `contract.ts` currently caps `records.offset` at 500. Remove that ceiling or replace it with cursor paging before promising exhaustive large-vault navigation. |
| Stable snapshots exist in grep | `grep` and `connections` return change-detection hashes; neither accepts a pinned snapshot. True stable paging is new work, not a rename. |
| Reverse claim discovery is new | `connections.ts` already returns reverse entity/owner claims and dependencies, plus directed explicit edges. It scans eligible records; a persistent reverse projection and combined entity response are missing. |
| Ontology counts are ready for active Browse | Counts exist, but baseline `inspection.ts` counts scanned records rather than applying the full active retrieval policy. Use the lifecycle work's shared eligibility policy before presenting current counts. |
| Rich summaries exist | `Summary` has ID/title/kind/type/path/lifecycle/revision/valid only. Timestamps exist in portable metadata but are absent from summaries. Counts and conversation provenance are absent. |
| History can group by conversation | Receipts/history expose actor-like provenance but no trusted conversation identity. Do not reconstruct conversation origin from text, titles, evidence paths, or the currently selected chat. |
| Inferred means no evidence | Creation requires retained, verified evidence for every claim. Inference can cite premises without a quote directly asserting the conclusion. Preserve that distinction; do not weaken evidence requirements for a visual design. |
| Chat can prefill text | Inspected SDK has `sessions.open(BoardGetParams)` and `create`, but no page-level compose API. `setDraft` belongs to a replacement composer, not ordinary plugin pages. |
| Navigation icon is supported | `book` exists in the inspected host icon set; `bookOpen` does not. Use `book`. |

Primary implementation touchpoints: `src/{model,contract,inspection-contract,
mutation-contract,retrieval-contract,service,storage,identity-store,access,
connections,retrieval,inspection,ontology}.ts` and the host's
`src/plugin-sdk/control-ui.ts` / `ui/src/plugins/*`.

## 2. Common read and security semantics

Every new operation is one typed feature contract shared by agent tools and UI.
Reuse trusted invocation authority and recheck it before releasing results.
Inputs select among authorized records; they never grant authority.

Define a shared **current eligible set**: authorized, unambiguous, valid,
active at query time, not tombstoned, and without unavailable dependencies or
references. Use it before grouping, counting, ranking, sorting, or paging in
Browse, entity claims/links, ontology facets, suggestions, and attention counts.
Lifecycle implementation owns exact transitive suppression semantics.

Historical inspection is a separate, explicit route. Withdrawing a record must
remove its content from ordinary discovery, even in old feed pages or pinned
snapshots. Historical access may expose retained originals to authorized callers;
it must never become a back door into ordinary entity claims or search.

Conversation provenance has its own disclosure check. Access to a private-vault
record does not authorize every associated session key/title/run. Omit hidden
origins before calculating learned-in counts or groups. Missing, expired, and
inaccessible session links all display the same unavailable state. The existing
operator UI is scoped to the configured agent's private vault; this project must
not silently broaden it to every conversation vault.

Every response identifies its checked time and coverage where applicable.
Unavailable or uncomputed values are `null`/absent with a state, never fabricated
zeroes. Publication state, index state, evidence verification, and semantic truth
are different concepts.

## 3. Trusted operation origin

Persist origin with an accepted mutation, its receipt, and all resulting history
rows, atomically with the existing journal:

```ts
type OperationOrigin = {
  actor: "agent" | "operator" | "external" | "unknown";
  agentId?: string;
  sessionKey?: string;
  sessionId?: string; // distinguish reset/reused keys; not just a display link
  runId?: string;
  toolCallId?: string;
  requestId?: string;
  batchId?: string;
};
```

- Actor, agent, conversation identity, run/tool-call identity, and time come only
  from authenticated host invocation context. Missing host fields stay absent.
- Existing `requestId` is a model/client-supplied **idempotency key**, not a trusted
  host request identity. Preserve it under that meaning. Do not describe it as
  host-attached merely because it appears inside `origin`.
- A retry or `resume` retains the original accepted origin, never the retrying
  conversation's origin. A correction's two records share the operation identity.
- Batch grouping requires an actual journal/request/ingestion identity. Do not
  manufacture an ingestion batch from close timestamps. Without one, show
  separate contiguous conversation groups with explicit item continuation.
- Scanner changes get `external`; legacy rows without enough evidence get
  `unknown`. Initial discovery of an old file is not proof it was just created.
- Do not persist conversation titles. Host session lookup resolves authorized
  labels lazily and in batches; `sessions.rows` alone is not a complete roster.

**Decision:** operational SQLite only; no `learned_in` frontmatter in this phase.
Conversation identifiers are deployment-local and may expose private routing.
The vault remains portable without them. Loss of operational provenance is
reported as unavailable, not reconstructed by an LLM or guessed from Git.

Migration is additive and preserves pending journals, original request hashes,
receipts, withdrawal safeguards, and old readers. Never rewrite historical records
just to fill an origin. Document backup requirements for this non-rebuildable state.

## 4. Portable unresolved mentions and display hints

Add optional `unresolved_mentions` to page and claim envelopes and their typed
agent write inputs:

```yaml
unresolved_mentions:
  - id: mention-sam-14
    label: Sam
    kind_hint: person
    evidence:
      - path: artifacts/standup.txt
        sha256: <retained-content-hash>
        start_line: 14
        end_line: 14
```

Use record-local stable mention IDs so two different speakers called Sam are
not conflated. `kind_hint` is optional and validated against the effective
ontology, not evidence of an identified person. Evidence uses the existing
retained-source checks. Apply the current record-size bounds and paginate read
collections; do not introduce an arbitrary small evidence cap.

Omission preserves the collection on edit; `[]` clears it. Resolution supplies
the observed record revision/hash and mention ID, removes only that mention,
and adds the supported entity reference or explicit relationship. Resolving a
claim must use the lifecycle/correction contract rather than silently changing
its assertion. If resolution needs multiple record changes, either use a shared
journaled operation or return explicit partial progress with retryable receipts;
never claim atomic completion from two unrelated saves. The source's literal
speaker label/evidence remains inspectable in prior history.

Unresolved identities are not validation errors and never hold saved knowledge
in an approval state. No guessed identity, implicit merge, or automatic rewrite.

Add optional `inverse_label` to relationship definitions, validation, ontology
outputs, and bundled definitions. Fall back to `← <forward label>`. This changes
display only, not direction, identity, or entailment.

## 5. Shared summaries and large-vault Browse

Extend the existing `RecordSummary` additively, keeping its existing keys:

```ts
type SummaryAdditions = {
  recordedAt: string;
  updatedAt: string;          // portable record time, not filesystem mtime
  lastSavedAt?: string;       // trusted operational observation/publication time
  hash?: string;             // include when producing an exact mutation reference
  claimCount?: number;
  linkCount?: number;
  lastLearnedIn?: { sessionKey: string; sessionId?: string };
  assertionOrigin?: "source" | "user_belief" | "agent_inference";
  claimKind?: "fact" | "preference" | "decision" | "commitment" | "event" | "belief";
};
```

Use the existing camel-case API names `assertionOrigin`/`claimKind`, not another
`origin` alias that conflicts with operation provenance. Pages' `claimCount`
counts distinct current claims whose `entities` includes the page. Owner-only
claims remain a separately labeled relation, not silently added to this count.
`linkCount` counts distinct current explicit relationship IDs incident on the
page (a self-loop once); derived links have a separate count if exposed.

Extend `records`:

```ts
{
  kind?, type?, query?, limit?, offset?, snapshot?,
  sort?: "updated" | "title" | "claims", dir?: "asc" | "desc",
  claimKind?, assertionOrigin?, learnedIn?, updatedSince?,
  attention?: "unresolved" | "inferred" | "unverified" | "indexPending"
}
```

- Default `updated desc`, using `updatedAt`; UI label is **Last updated**, not
  necessarily **Last saved**. A literal Last saved ordering needs `lastSavedAt`
  and a separately named sort. No fabricated timestamps for legacy material.
- Stable final tie-break is ID. `claims` is page-only; reject incompatible kinds.
- `query` remains inventory title/ID/alias filtering, not FTS relevance ranking.
- Return `total`, `snapshot`, continuation, checked time, and explicit complete
  inventory semantics. Remove the 500-row offset restriction. Limit response
  size, not vault navigation depth.
- Ontology facets use the same eligibility/snapshot and page/claim mode. Hide
  zero-count page types; claims filter by claim kind, not imaginary page types.

**Pinned paging contract:** first call fixes scope, normalized filters, sort,
query time, and ordered immutable summary projection for a bounded TTL (initial
target: 10 minutes). Subsequent calls accept an opaque server token bound to
that scope/query. Inserts/ordinary edits do not shift pages. Token expiry,
service restart, or incompatible query returns typed `snapshot_expired` or
`snapshot_mismatch`, never silent paging on a different dataset. Access changes,
withdrawal/supersession, dependency suppression, or expiry invalidate affected
snapshots before returning stale content. UI restarts with a visible explanation.
Bound cache bytes and token lifetime; eviction is explicit expiry, not truncation.

This is new infrastructure. A digest that clients compare only *after* receiving
a page does not satisfy the stable paging guarantee.

## 6. Recent feed

**Partial implementation (September 23):** the `recent` feature query now groups
published correction pairs, preserves operation timestamps, labels observations
honestly, and supports scoped upper-sequence/keyset pagination with eligibility
rechecks. The conversation-grouped/windowed interface below remains the target.
See `UI_REDESIGN_IMPLEMENTATION.md` for the shipped boundary.

Add `recent({ since?, until?, limit?, cursor?, attention? })`, returning ordered
groups with origin, optional batch identity, first/last time, individually
identified changes, unresolved mentions, and `nextCursor`.

- Default window is the last **seven days**, `until` fixed at first request.
  Default page budget is 50 items, maximum 100. “Load older” widens the window;
  the window is not a history retention/deletion policy.
- Order by operational time and unique history sequence, descending. Cursor
  pins an upper sequence bound. New saves appear on refresh, not by shifting
  the user's current page. Large groups may span pages with a continuation key.
- Group by authorized session incarnation and actual batch where available.
  Display “Edited outside OpenClaw” or “Earlier saves · conversation unavailable”
  for external/legacy entries. Do not group all unknown rows as one conversation.
- Item identity includes operation/history sequence and record ID/revision.
  Repeated observations and exact retries must not duplicate one publication.
- `created` is known plugin creation at revision 1; `updated` is a known update.
  Add `observed` for initial scanner imports and unknown historic operations.
  Revision number alone cannot prove an import was a newly created record.
- Corrections group original supersession and replacement creation as one
  logical change. Relationships remain individual items; UI may collapse only
  fully loaded, authorized items without inventing a count.
- Withdrawn/superseded content is not an active assertion card. Return minimal
  authorized lifecycle event metadata, reason/replacement availability, and an
  explicit history link. Do not embed an old assertion quote in the default feed.
- Failed/pre-acceptance writes are not saved items. Accepted/conflicted work is
  separately labeled pending operational activity. Published-but-not-indexed
  records remain visible. An incomplete correction must not leak a half-state.

## 7. Combined entity inspection

Add `entity({ id, claimLimit?, claimCursor?, linkLimit?, linkCursor?,
learnedInLimit?, learnedInCursor? })`. Return:

- `record`: summary, aliases, ontology-labeled fields, and safely renderable body
  with truncation/continuation metadata compatible with `record`.
- `claims`: counts by canonical kind, paged summaries, total, continuation,
  snapshot, attribution, origin, evidence count, and bounded first excerpt.
- `links`: separately labeled incoming/outgoing typed relationships and derived
  links, with target summary and relationship ID where one exists.
- `learnedIn`: authorized session identities, last save time, distinct operation
  counts, bounded continuation. A global roster fetch is not required.
- `unresolved`: paged record-local mentions and evidence previews.
- Explicit historical navigation, rather than withdrawn content mixed into
  current claims. Missing/ambiguous/inaccessible records use today's null result.

**Summary decision:** render the existing Markdown body safely. No second
agent-maintained summary field or on-read model generation. Preserve headings,
links, and meaningful content; use an excerpt + expand for long bodies. Never
present a truncated body as an editable complete record.

Reuse `connections` semantics but build rebuildable, scope-partitioned reverse
projections for `entities`, `owner`, `dependencies`, and relationship endpoints.
Keep dependency links distinct from “claims about this page.” All subcollections
come from one read generation; continuation expires rather than mixing states.

Derived wikilinks are their own projection, flagged `derived: true`, never
asserted/evidenced relationships. Resolve only unique authorized targets; do not
guess ambiguous aliases. Removing a wikilink only removes its derived entry.
Return one-hop neighborhoods; no hidden transitive graph expansion.

Evidence uses current chunked inspection/download. Distinguish a retained,
hash-verified original from a source that proves the conclusion. For inference,
label the conclusion as agent inference; show premise evidence separately and
say “No direct quote for this inference” when appropriate. `user_belief` means
an attributed user statement, not automatically “you” for every viewer. Resolve
speaker labels from evidence attribution; do not relabel another user's words.

## 8. Suggestions and attention

Prefer a separate `suggest({ query, limit? })` over changing exact `lookup`
semantics. Limit 10; empty query gives no suggestions. Normalize Unicode/case/
whitespace consistently with lookup, escape literal tokens, and never accept raw
FTS syntax. Rank exact title, exact alias, title prefix, alias prefix with stable
ties; return `matchedOn` and matching alias. The label is **Suggestions**, not
the prototype's incorrect **Exact matches** for partial text. UI debounces about
200 ms and discards late responses. FTS5 title/alias projection is sufficient.

Add `attention({ since?, cursor?, limit? })` or equivalent typed summary/detail
routes. Default recent-inference window matches Recent's seven days and returns
the effective window. Each total must link to the *same predicate* used by its
detail list, applied after access/lifecycle filtering:

| Metric | Meaning / drill-down |
| --- | --- |
| `unresolvedMentions` | Number of current mention entries, not number of records; detail items include record and mention ID. |
| `inferredClaimsRecent` | Distinct current `agent_inference` claims saved in the window; not synonymous with missing evidence. |
| `unverifiedEvidence` | Distinct record/evidence-reference pairs failing verification, with failure category and checked time. |
| `indexPending` | Distinct published current records not represented by the current retrieval projection. Unknown if index state cannot be measured. |
| `conflicts` | Accepted conflicted mutations, linked to operational mutation inspection, not a `records` filter. |

Evidence verification may be expensive: cache by scoped content hash and
generation, invalidate on source changes, and return checking/unavailable state
instead of false zero. Baseline receipt `indexed: false` is a fixed receipt value,
not a live index-progress measurement; do not use it to count pending records.
Attention is informational; it never blocks ingestion or promotes “accepted” facts.

## 9. Host integration: separate OpenClaw work

### Chat compose (required for the designed handoff)

Add a supported ordinary-plugin-page API, preferably:

```ts
host.chat.compose({
  agentId?, sessionKey?, text,
  context?: {
    pluginId: "knowledge",
    references: [{ kind: "knowledge-record" | "knowledge-claim",
      id, revision?, hash?, label, mentionId? }]
  }
});
```

No session means prepare a new conversation; an existing session must be
accessible and agent-compatible. Preserve a nonempty existing user draft by
explicit user choice or compose in a new draft; never overwrite silently. Show
references as removable chips, persist them with the draft, and include them in
the sent message only when the user sends. Cancel/removal sends nothing.
No auto-send, DOM poking into the host composer, or use of internal host methods.

References are target hints, **not trusted authorization or instructions**. Agent
re-reads the record and validates observed revision/hash before mutation. If
content changed, explain the conflict; do not silently retarget the request.
The host must define reference serialization to the model and sanitization of
labels/plugin IDs. “Tell the agent who” includes exact mention and source record.

Until this API exists, use an explicit copy-request + open-chat fallback with
truthful feedback. Do not claim the request was prefilled or sent. Plain
“Open conversation” uses existing `sessions.open` once trusted origin exists.

### Styling and icons

Choose a small documented, versioned host token/class contract (option a from
the design report) first. This fits the current light-DOM plugin architecture;
new host components are optional, not a prerequisite for every UI element.
Keep plugin layout rules namespaced and follow existing tokens for fonts,
surfaces, buttons, focus, and reduced motion. Do not force the whole host theme.
Use the existing `book` navigation icon. A supported icon-render helper is a
nice-to-have follow-up; do not bundle an entire duplicate icon library solely
for a handful of glyphs.

**Ontology location:** a secondary Knowledge sub-view reachable from the page
header, with normal Back navigation. Not a primary tab or large modal.

## 10. Skills and migration

Repository-owned skills change alongside shipped APIs, not before:

- `knowledge-correct`: consume exact reference/revision/hash, inspect evidence,
  correct or withdraw using tools, report receipt plus dependent repair needs.
- `knowledge-entities`: resolve exact unresolved mentions from evidence, preserve
  ambiguity, and report each completed operation without claiming an implicit merge.
- `knowledge-ingest` and `knowledge-meeting-ingest`: write supported unresolved
  mention structures and distinguish source statements, user beliefs, inference.
- Shared guidance: all mutations are agent-mediated; “Needs a look” is not an
  approval queue. Synchronize generated references only after canonical edits.

Upgrade SQLite additively; legacy origin stays unknown, missing mentions stays
empty, missing inverse labels uses the arrow fallback. Reverse indexes,
suggestions, count projections, and snapshot caches are rebuildable; provenance,
publication history, and lifecycle safeguards are not. Rebuild tests must prove
the latter survive. Old portable files remain readable; new unknown optional
fields must not be erased by unrelated writes.

## 11. Delivery slices and acceptance gates

| Slice | Owner / dependency | Acceptance |
| --- | --- | --- |
| A. Read-only redesign + lifecycle | Current UI/backend workstreams | No browser knowledge writes; correction/withdrawal tests; truthful fallback rendering. |
| B. Origin + current-summary projection | Knowledge backend | New writes/retries/recovery have one correct origin; legacy/external distinguished; filtered counts agree. |
| C. Compose API | OpenClaw host; can proceed independently | Prefill + chips survive navigation, preserve draft, require Send, and convey exact references without widening access. |
| D. Browse + snapshots | B/shared projection | At least 10,000 mixed records; every eligible row reachable once with stable ties amid writes; expiry handled explicitly. |
| E. Recent + entity | B/D + lifecycle read policy | Accurate groups, one logical correction, one-hop typed/derived links, bounded collections, no N+1 whole-vault hydration. |
| F. Mentions + attention + skills | B/E, typed write support | Repeat-label resolution, exact drill-down totals, evidence-check state, no approval workflow. |
| G. Suggestions + ontology polish | Shared projections | Literal prefix semantics, alias ambiguity, stale-request cancellation, inverse labels and zero-type hiding. |

Do not make origin and Browse prerequisites for independent host compose work.
Keep future APIs feature-detected/versioned so the redesigned UI can run against
the current plugin without pretending the full design is implemented.

Required checks include repository check/build/validate and targeted automated
tests. Test access noninterference with hidden canary records/sessions: visible
totals, pagination, feed grouping, learned-in, suggestions, links, diagnostics,
and attention must not reveal them. Test withdrawal during a pinned read,
service restart, lost-response retry from another session, legacy migration,
source disappearance/hash mismatch, timezone boundaries, external import, and
published records while FTS is unavailable. Visual checks cover desktop/narrow
layouts, keyboard focus, expanded evidence, empty/error states, and the delivered
chat handoff. No prototype fixture writes in the user's vault.

Performance gate: large-vault Browse/entity/suggest query work is bounded by
indexed selection plus page size after reconciliation, not repeated full-vault
scans or per-row browser requests. Measure p50/p95 on a stated 10,000-record
fixture and machine before setting a latency budget; record actual numbers.

## 12. Existing-solution and gbrain comparison

The existing plugin, host styles, SQLite/FTS5, and supplied UI kit adequately
cover this work; no additional framework/platform is justified. Reviewed local
gbrain at `d13aa742fd68b71bfd6c98be3dda5813791f1d6c`, specifically
`src/core/persistence/links-preparation.ts` and `src/core/sort-newest-first.ts`.
Reuse its principle of separately tracking automatic link origin and only
reconciling links owned by that derivation. Do not copy its persistence runtime.
Its path-based newest-first helper intentionally sorts undated paths
lexicographically; Knowledge instead needs record/operation timestamps for a
truthful Recent feed. Host-attached conversation provenance and agent-only UI
changes follow this project's explicit requirements, not generic graph defaults.
