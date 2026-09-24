# Publishing and retrying Knowledge records

## Prepare

1. Confirm `knowledge_status` is non-sample and `writesEnabled: true`. Retain the
   observed vault UUID (`vault`) as `expectedVaultId` on uploads and saves.
2. Search for an existing page before creating one. Match source IDs/URLs,
   original hashes, title/date and content, not merely a similar title. There is
   no automatic content-deduplication service. Identical content with a new request
   ID can create a duplicate. Reuse verified existing evidence/pages when possible.
3. For edits read the entire body and observed revision/hash; request
   `includeMetadata: true` if changing domain fields. Preserve unrelated prose.
   Omit `fields` to preserve them; supplying `fields` replaces the complete object.
   Only use fields allowed by the selected ontology. `save_page` also supports
   aliases, tags and dependencies: omitted preserves, supplied replaces, empty
   clears. It cannot set lifecycle, entity IDs, arbitrary frontmatter, claim kinds
   or relationships; do not smuggle these into `fields`. Existing
   type cannot be changed by this editor. Record unsupported information in
   clearly attributed prose where appropriate, not fictitious structured state.

## Retain the source

Use `knowledge_attach` with a fresh UUID request ID per original. Send exact bytes
as base64 in sequential chunks of at most 49,152 decoded bytes, starting at
`offset: 0`. Keep request ID, filename, mediaType, attribution and vault precondition
unchanged; set `final: true` only on the last chunk (an empty file is one empty
final chunk). Follow `receivedBytes`. Retry the identical chunk after a lost
response; never guess a new offset or silently restart under a new request ID.

Use available host file-reading/encoding facilities; do not manually invent
base64 or pass a filesystem path to this tool. If those facilities are absent,
report that original retention is blocked. For small inline user text,
`save_page.source: {text, attribution}` is also supported; pass the exact text.

Only `state: complete` returns usable `evidence`. Supply that object in
`save_page.attachments`, optionally adding verified text line locators/quote.
Attachments append and existing evidence remains; uploading alone creates no
page. Failed page publication can leave an unattached retained file: report it,
reuse its receipt, and do not promise automatic garbage collection.

## Publish one page

Keep a fresh UUID `requestId` and the exact payload for each distinct save. Use
the JSON tool arguments, not shell interpolation of imported text.

Create payload shape (replace the symbolic values with observed/generated ones):

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "type": "note",
  "title": "Source title",
  "body": "Attributed summary with source citations"
}
```

Replace the symbolic UUIDs before use and add `attachments` as an array of
returned evidence objects when attaching originals. An edit additionally
supplies `id`, `expectedRevision`, and `expectedHash` from the complete current
read. Creates must omit those three fields: client-chosen IDs are not supported.
The page body is limited to 48,000 characters; this is NOT an original-file limit.
Keep long originals attached and write a focused page; never silently truncate
the original to make it fit.

The backend chooses descriptive filenames from titles; do not predict a slug or
choose a client-side ID. For a new source page needing self-citations, publish its
substantive body with retained evidence first, then use the returned path for
readable inline self-links. Likewise add cross-links after target pages exist.
Read the current revision/hash before each follow-up edit and preserve unrelated
content/metadata. The workflow is not complete until final links pass the shared
readback checks. After a rename, reread preconditions even if body bytes did not
change; the observer may have advanced the revision.

## Retry and reconcile

- Lost/uncertain save response: inspect `knowledge_mutation({requestId})`. Replay
  the exact payload with that ID, or use `knowledge_resume({requestId})` for a
  known accepted publication. Never replace an uncertain request with a new ID.
- `state: accepted` is durable intent, not completion. `state: published` means
  the page was saved. `indexed: false` describes publication-time state; a fresh
  search reconciles indexing. A pending/unavailable Git checkpoint does not undo
  publication or justify another save.
- A rejection before acceptance leaves no saved draft. Preserve the proposed
  text, reread, reconcile changes, then use a new request ID for the new payload.
- `state: conflict` retains recovery material. Inspect mutation/history and
  report the conflict; resume does not resolve it. Do not overwrite, bypass
  preconditions, delete the journal or blindly loop. A repeated unchanged failure
  needs inspection, not more retries.
- For several records, keep an itemized work log of source identity, upload request
  IDs/evidence, page/claim/relationship request IDs/exact payloads, returned record IDs and verified
  outcomes. Use authorized task storage if durable continuation is needed; this
  is an agent work log, not a Knowledge ingestion checkpoint. If it is lost,
  inspect history and existing pages before proceeding. When uncertain whether
  an item was published, stop that item rather than create a possible duplicate.
  No general multi-record ingestion atomicity, rollback, semantic dedup or job-resume guarantee is available. Explicit correction is the one supported two-record logical mutation.

## Supported structured assertions

`knowledge_create_claim` publishes one claim with title/body, claim_kind
(fact/preference/decision/commitment/event/belief), assertion_origin
(source/user_belief/agent_inference), attribution and nonempty retained evidence.
`knowledge_create_relationship` publishes from/to page IDs, a declared ontology
label, title/body, attribution and evidence. Both require a fresh requestId and
`expectedOntologyFingerprint` from `knowledge_ontology`; also supply observed
expectedVaultId. Existing source evidence can be reused with verified locators.

Claims may reference page `entities` and record `dependencies`; relationships may
have dependencies and ontology fields. References must be active and authorized.
A commitment may have a known owner page ID and due_at. An event may have
occurred_at. Dates preserve source precision (date-only or timestamp with explicit
timezone); unknown values remain absent. Valid_from/valid_until/expires_at use the
exact snake-case keys `valid_from`, `valid_until`, `expires_at` and UTC timestamps.
Capture never schedules work. Unresolved speakers remain attributed source labels.

These create tools do not deduplicate semantically or overwrite claims. Use
`knowledge_correct` for a revision-fenced evidence-backed replacement and
`knowledge_withdraw` for an explicit retraction; follow the knowledge-correct skill.
Use the same publication/retry/readback rules above. Inspect typed metadata with
`knowledge_record` and incoming/outgoing edges, reverse dependencies or entity
claims with `knowledge_connections`; paginate and verify evidence. Do not report
full ingestion completion merely because individual assertions published. The agent
reconciles the workflow using this work log and the existing per-write guarantees;
there is no ingestion-system prerequisite.


## Choose assertions and reconcile reruns

### Structured context and continuity

Create operations and page saves accept `source_page`, `record_class`, `identity`,
`attribution_confidence` and `continuity` where semantically applicable. Inspect
the actual tool schema. Source pages must already exist; do not reference a
page's own ID as `source_page`. Use the meeting/source ID on the extracted
assertions and attendance edges. This groups source context, not an ingestion job.

`attribution_confidence: {level: "high"|"medium"|"low", basis, evidence}` means
speaker/identity attribution confidence only. Preserve source-grounded reasoning;
do not invent a calibrated truth score or replace assertion origin with it.

Use `knowledge_annotate` for revision/hash-fenced contextual metadata updates or
`addEvidence` on an unchanged assertion. Supply a fresh request ID, observed
vault, ID/revision/hash, reason and `annotations` object (empty is allowed only
with added evidence). Omitted annotations are preserved; supplied arrays replace.
Read back the receipt and record. This operation cannot change assertion text or
lifecycle; historical records accept only fixture classification.

Before creating another claim, compare meaning, owner, source and dates:

- Same assertion and same source: reuse the existing ID.
- Same assertion with additional source support: append verified evidence with
  `knowledge_annotate`; preserve the original statement and attribution. New
  evidence must support the same qualifications, not merely a related subject.
- A separately useful dated reaffirmation, updated plan or contrary account:
  create the sourced claim and add `continuity: [{id, relation: "reaffirms" |
  "updates" | "contradicts", basis, evidence}]`. This does NOT supersede the
  earlier claim, establish completion, or make the newer source authoritative.
- An explicit correction: use `knowledge_correct`, not an annotation or silent
  replacement. Missing/uncertain outcomes still follow mutation replay rules.

An event claim that specifically represents the source meeting itself may set
`source_event: true` with its `source_page`. Keep one shared event association for
all relevant entities. Do not mark other events mentioned in a meeting this way.
The UI can fold this representation into a meeting entry without deleting it.

Use structured records for independently useful, sourced assertions, not every
sentence of a summary. Keep the page as readable synthesis with inline citations.

| Source meaning | Claim representation |
|---|---|
| Material factual statement | `claim_kind: fact`, `assertion_origin: source`, attribution names the actual source |
| Explicit decision | `decision`; preserve conditions, decision maker and source date in body/attribution |
| Explicit commitment | `commitment`; resolved `owner` when known, `due_at` only when supported |
| Dated event / timeline material | `event`; `occurred_at` at source precision, all relevant resolved page IDs in `entities` |
| Stated belief/preference | `belief`/`preference`; source origin for a document's speaker, `user_belief` for the user's own assertion |
| Agent analysis worth saving | appropriate kind with `agent_inference`; evidence supports the premises, not an invented quotation |

One independently correctable assertion per claim. Holder/speaker belongs in
attribution; `entities` describes resolved relevant pages, not automatic endorsement.
Unknown speaker identity does not block a source-attributed claim, but omit a
claimed owner or person association that would guess that identity. Proposals,
jokes and provisional targets are not decisions or commitments unless the source
actually establishes that meaning.

Publish the source page and resolved endpoint/entity pages before dependent
assertions. Supply the source page ID in `dependencies`, relevant entity page IDs
in `entities`, and retained original evidence with verified locators in `evidence`.
If an assertion genuinely relies on another claim, include that claim dependency;
do not add dependencies merely for every prose mention. Dependencies are not
citations: inactive dependencies can withhold dependent records from discovery.

Before creating on a rerun:

1. Resolve the source page by source ID/hash/content. Inspect its
   `knowledge_connections({id, direction: "dependents"})` and relevant entities'
   `claims` plus `incoming`/`outgoing` edges. Follow `nextOffset` with unchanged
   filters; restart a paginated read if `snapshot` changes.
2. Read candidate metadata, evidence and lifecycle. Compare assertion meaning,
   speaker, qualifications, event/date, entity IDs, and original evidence. For
   relationships compare directed endpoints, label and evidential context, not
   only the pair. Use lookup/grep when existing records lack dependencies.
3. Reuse a matching active assertion. A genuinely different source assertion may
   coexist with contrary evidence; do not silently supersede. New source coverage
   does not justify recreating all assertions already accounted for.
4. If a work-log request has an uncertain outcome, inspect `knowledge_mutation`
   and replay/resume the original payload. If missing from active results, inspect
   known IDs/history (and `historical: true` connections where appropriate) before
   inferring absence. Never resurrect a withdrawn/superseded assertion on reimport.
   If you cannot determine the outcome safely, mark the item unresolved.
5. An explicit correction uses `knowledge-correct`; reconcile affected source-page
   prose and entity references within scope. A new request ID is not a way around
   a conflict or a changed payload under an existing ID.

Structured create example (replace placeholders with observed/generated values):

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "expectedOntologyFingerprint": "<observed fingerprint>",
  "title": "Send reliability report",
  "body": "Speaker 2 offered to send the report on Friday; their identity is unresolved.",
  "claim_kind": "commitment",
  "assertion_origin": "source",
  "attribution": "Speaker 2, retained transcript line 5",
  "dependencies": ["<meeting page ID>"],
  "evidence": [{"path": "<returned artifact path>", "sha256": "<returned hash>", "start_line": 5, "end_line": 5}]
}
```

This intentionally omits owner and due date: neither an anonymous label nor a
relative date without adequate date context supplies a resolved value. Creating
this claim records the source statement; it does not assign work or schedule it.
