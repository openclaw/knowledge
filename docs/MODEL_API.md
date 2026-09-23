# Model-facing inspection

The UI and agent tools use the same typed service and access checks. These are
presentation choices, not alternate authority or storage paths. All options below
are live service inputs once the rebuilt plugin is loaded. Existing callers must
opt into fields that used to be returned unconditionally.

## Ontology: discover, then inspect

| Task | Input to `knowledge_ontology` | Output |
|---|---|---|
| Discover vocabulary | `{}` | Catalog: names, labels, kinds, descriptions, aliases, record counts; 50 entries/page |
| Prepare a page write | `{"view":"definitions","name":"project"}` | Structured fields, allowed values, filing, endpoint constraints and provenance; no serialized JSON copy |
| Browse a kind | `{"kind":"page","limit":20}` | Filtered catalog with `nextOffset` |
| See examples | `{"view":"definitions","name":"project","includeRecords":true}` | At most 20 record summaries/type and an explicit `recordsTruncated` flag; exhaustive retrieval uses `knowledge_records({type:"project"})` |
| Discover source files | `{"view":"sources"}` | Authorized source paths, validity and size, without raw YAML |
| Debug a manifest | `{"view":"sources","sourcePath":"ontology.yaml"}` | Only the selected YAML, bounded to 12,000 characters by default |
| Diagnose activation | `{"view":"diagnostics"}` | Paginated issues and inheritance chain |

Definitions default to 10/page; other list views to 50/page. `limit` accepts 1–100.
`name` is exact; `kind` is page or relationship. All views include availability,
identity/fingerprint, total count, offset and nextOffset. `totalIssues` is the
vault validation count, not just activation errors. Unavailable ontology is not
reported as a valid empty vocabulary.

Follow `nextOffset` with unchanged view/filters. Source text offsets count
characters; other offsets count entries. A selected source reports `total` in
characters and repeats that unit explicitly as `source.totalChars`. `maxChars`
accepts 256–65,536. Source paths must match already-enumerated authorized sources;
this is not a filesystem-read tool. Compare fingerprints across definition pages.

Raw YAML is useful only for diagnosing malformed definitions or preserving authored
comments during a source edit. It is not needed for normal page authoring. Effective
definitions are already structured; there is no model-facing serialized-definition
mode. Behavior flags describe vocabulary and do not enable unimplemented workflows.

## Records: content once, extras on request

`knowledge_record({id})` returns body text, identity, revision/hash, lifecycle, attribution/assertion origin when present, validation issues and verified
evidence. It does **not** return original Markdown a second time, full frontmatter,
or connected-record lists by default.

- `view: "summary"`: omit text and evidence by default; inspect identity/state.
- `view: "raw"`: original Markdown **instead of** body, for exact-file inspection.
- `includeMetadata: true`: full frontmatter as a structured object, not a JSON string.
  Use this to inspect domain fields before replacing the `fields` object in an edit.
  Omitting `fields` from a save preserves existing fields.
- `includeReferences: true`: connected summaries, default 20/page, with
  `referenceTotal` and `nextReferenceOffset`. Continue with `referenceOffset`;
  `referenceLimit` accepts 1–100.
- `evidenceOffset` / `evidenceLimit`: page through source references (default 20, max 100 **per response**, not per record), following `nextEvidenceOffset`; `evidenceTotal` reports the full count.
- `includeEvidence`: override the view's default. `maxEvidenceChars` limits the
  **combined excerpt text** (default 4,000; range 0–20,000). Citation locators and
  verification remain present even if excerpts are shortened; each excerpt has
  `excerptTruncated`. Verification describes the full locator, not just its excerpt.
- `offset` and `maxChars`: page through body/raw text (default 12,000 chars).
  Follow `content.nextOffset`; `content.totalChars` discloses the full length.
  Compare hashes across chunks and restart if the record changes. Never replace a
  page using an incomplete body. Missing/duplicate IDs return `record: null`.

The browser explicitly requests complete bodies and metadata for editing, fetches
raw files on demand, and follows ontology pagination. Opt-in full metadata and
large custom definitions can still be large; normal discovery does not fetch them.

## Drafts and publication are different

One unsaved browser draft per authorized agent/vault/scope is retained in tab-local
sessionStorage on each edit. It survives navigation, page reload and plugin UI
remount. Original record ID/revision/hash and the exact submitted payload/request
ID survive uncertain save outcomes. A recovered draft never replaces its edit
preconditions with a newer snapshot. Opening another editor reopens the existing
draft; explicit discard is available only before acceptance/uncertain submission.

This is not a server draft or backup. Closing the tab, clearing browser storage,
or browser failure can lose it. Storage errors remain visible. Drafts open only
after an authorized status response for the same identity; browser saves include
`expectedVaultId`, a precondition (not a scope selector), to reject accidental
publication into a replacement vault. No new scope authority is granted.

An **accepted publication** has durable intent and recovery material. The journal
exists because Markdown/artifacts and SQLite cannot share one transaction. Use the
same request ID and exact payload for retries, and inspect/resume accepted work.

A request rejected **before acceptance**, including a stale revision/hash, creates
no saved draft or receipt. The error says so. Keep the proposed text, read the
current record, reconcile, and submit a new request. Do not archive every invalid
request just to make a misleading error true.

## Local Git history

`knowledge_save_page` and `knowledge_resume` return publication status separately from optional `git: {state, commit?, message}`. A `published` receipt remains a successful save even when Git is `pending` or `unavailable`. `committed` includes the local commit ID. Retry with the same request ID; do not resubmit a new write just to get a Git checkpoint.

`knowledge_history` adds a scoped `git: {state, pending, message}` summary. States also include `idle` (no content observed yet) and `read-only`. Neither counts nor retries include other scopes. Normal scoped scans also retry queued history. No GitHub or remote operations are exposed. See [local-history details](LOCAL_HISTORY.md).

## Keyword retrieval and exact identity lookup

`knowledge_grep({query})` ranks titles, aliases and authored bodies with local
SQLite FTS5. Modes: `all` (default, every word), `any`, `phrase`; not regex/raw FTS.
`knowledge_lookup({query})` resolves exact IDs, full names and aliases, returning
`found`, `ambiguous` or `missing`. Never infer identity from the first ambiguous hit.

Both default to **active** valid records. Saved pages are immediately available;
there is no approval status or acceptance filter. `lifecycle:"superseded"` or `"all"`
includes historical records, never withdrawals. Both accept `kind`, `type` (ontology
aliases supported), exact `tag`, `limit` (1–50, default 20), and `offset`.

Hits contain bounded snippets, matched fields, revision/hash citations and up to
three verified evidence locators. Inspect with `knowledge_record` for more.
Keyword `index.state:"unavailable"` / `total:null` is a failed retrieval, not zero
matches; retry or inspect the database. `coverage.complete:false` signals source
validation issues. Compare `index.snapshot` across pages and restart if changed.
Exact lookup does not depend on FTS. `knowledge_records` remains exhaustive
listing, including records needing inspection; search is not an inventory.

Publication receipts describe publication-time state: `indexed:false` now means
pending until the next search reconciles. Search reports its own current snapshot.
See [retrieval semantics, security and rebuild boundaries](RETRIEVAL.md).

## Live state

The private-vault explorer subscribes to the supported `changed` feature event.
Events contain no record data or paths. Node filesystem watches coalesce hints;
normal authorized scans perform reconciliation and Git checkpointing. They do not
create a background identity with broader access or scan other conversations.
Reconnect, manual refresh, and a 30-second visible-page fallback request current
snapshots, covering missed/coalesced notifications and backend-only reloads.
`status.live` reports `watching`, `unavailable`, or `stopped`; unavailable watchers
are retried on the next authorized private status read. Conversation tools still
reconcile their own partition on demand; they do not run private reconciliation.

Service stop closes watchers/timers and fences old and in-flight access. A retry
uses the original request ID against the replacement service; accepted publication
recovery and explicit conflict handling remain unchanged. Full backup/restore is
not implemented by this lifecycle work.

## File attachments

Use `knowledge_attach` to retain original source bytes (text, PDF, image, audio,
video or other files). Send sequential base64 chunks with a stable requestId,
filename, mediaType, attribution, byte offset and final flag. Each decoded chunk
is at most 48 KiB to fit the native transport; this is **not** a total file-size
limit. Retry identical chunks with unchanged metadata after interruption.
The complete receipt returns `evidence`; append it with `save_page.attachments`.
There is no evidence-count cap. Pages can still be saved without any evidence.

`knowledge_attachment({id,path,sha256,offset})` downloads originals referenced by
an authorized record, one base64 chunk at a time. Follow nextOffset until null.
Never mistake the bounded excerpt for the original. No tool accepts an arbitrary
host filesystem path. Older source.text saves remain supported, without the old
48,000-character schema cap; file upload is the normal authoring interface.

The editor selects multiple files, retains completed uploads in draft recovery,
and offers downloads from record detail. Browsers cannot restore an unuploaded
File selection after reload: reselect those files. Completed originals remain in
the vault even if the page draft is discarded. See [EVIDENCE.md](EVIDENCE.md).

## Structured authoring

1. Read `knowledge_status` and `knowledge_ontology`; retain the vault ID and
   effective ontology `fingerprint`. Resolve existing pages with lookup/records.
2. Retain source bytes using `knowledge_attach`, or reuse evidence from an
   authorized source record. Add only locators/quotes verified against that source.
3. Publish through the operations below; use fresh UUIDs for genuinely new writes
   and exact request/payload replay for uncertain outcomes. Publication is not
   semantic truth, extraction completeness, deduplication or task execution.

`knowledge_create_claim` example (replace symbolic UUIDs/fingerprint/evidence):

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "expectedOntologyFingerprint": "<ontology fingerprint>",
  "title": "Release commitment",
  "body": "Alex committed to delivering the release on Friday.",
  "claim_kind": "commitment",
  "assertion_origin": "source",
  "attribution": "Alex, meeting transcript line 12",
  "entities": ["<project page ID>"],
  "dependencies": ["<meeting page ID>"],
  "owner": "<resolved person page ID>",
  "due_at": "2026-09-25",
  "evidence": [{"path": "<retained artifact path>", "sha256": "<observed hash>", "start_line": 12, "end_line": 12}]
}
```

Kinds: fact/preference/decision/commitment/event/belief. Origins:
source/user_belief/agent_inference. Omit unknown owners/dates. For a timeline event,
use an event claim with `occurred_at` and relevant entity IDs. There is no dedicated
chronological timeline query yet; inspect connected claims and their dates.

`knowledge_create_relationship` uses the same request/vault/ontology controls,
title/body/attribution/evidence/dependencies and optional validity/expiry, plus
`from`, `to`, ontology `label`, and optional ontology `fields`. It does not accept
claim kind/origin, occurrence or commitment fields. Inspect endpoint constraints
before publication; backend enforces them. Same endpoint pair may carry multiple
independently evidenced assertions. No implicit supersession or overwrite.

`knowledge_save_page` additionally accepts aliases/tags/dependencies and optional
`expectedOntologyFingerprint`. Omission preserves metadata; supplied collections
replace (empty clears). Existing ID/revision/hash edit preconditions still apply.

All three operations share accepted/published/conflict receipts, request replay,
resume/history/Git behavior, service-generation fencing and live refresh. Changed
payload or operation under an existing request ID fails. Creates generate their
own ID/path. Structured assertions cannot be edited/withdrawn through these APIs;
that is the next lifecycle milestone.

`knowledge_record({id, includeMetadata:true})` returns all portable assertion
fields as a typed object. `knowledge_connections({id})` returns paginated incoming
and outgoing explicit relationships, reverse dependencies, and entity/owner claims.
Filter `direction` with incoming/outgoing/dependents/claims, use `limit` (1–100,
default 20), follow `nextOffset`, and compare `snapshot` between pages. Access and
active temporal/lifecycle filtering happen before counts. Historical queries opt
in with `historical:true`; withdrawn records remain excluded. Evidence is limited
to three references per connection; `evidenceTruncated` signals further evidence
available from record inspection. Markdown links are not relationship assertions.

Native UI offers New claim/New relationship alongside New page. Advanced source
controls accept file uploads or existing evidence with exact locators. Drafts
retain operation kind, all form values and exact submitted payload/preconditions;
failed authoring-option loads can be explicitly retried without losing a draft.
