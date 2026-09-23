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

`knowledge_record({id})` returns body text, identity, revision/hash, lifecycle and
acceptance, attribution/assertion origin when present, validation issues and verified
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

An unsaved browser editor draft remains in the mounted dialog across refresh and
close/reopen. That is not a durable server draft and does not guarantee survival
across page remount, browser restart or plugin UI reload.

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

## Keyword retrieval: proposed next step, not implemented

SQLite FTS5 is the existing-solution choice: OpenClaw memory-core already uses
FTS5/BM25, and lossless-claw provides FTS-backed recall. Reuse the engine and proven
patterns, not either plugin's private database or internal modules.

A `knowledge_grep` could search title, aliases and body, accept explicit query mode
and kind/type/lifecycle filters, and return bounded ranked snippets with stable ID,
path, revision/hash and match locations. Default to active valid unambiguous records;
keep candidate/accepted status visible. Keep `knowledge_records` as exhaustive
listing rather than conflating ranked results with a complete catalog.

The index belongs in Knowledge's SQLite state as a rebuildable projection of
Markdown. Scope must constrain corpus/counts/ranking **before** search, not filter
private hits after ranking. Index updates must reconcile edits, renames, deletes
and publication/restore generations. Report unavailable or stale indexing explicitly,
not as an empty match set. Test those invariants before adding the tool. Embeddings,
a new service and a general regex engine are not prerequisites for body search.
