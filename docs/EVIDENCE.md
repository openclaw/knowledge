# Original source files

Evidence is retained as original files, not text squeezed into a page-save field.
Each scoped source has an immutable descriptor containing its retained path,
SHA-256 hash, origin attribution and optional filename, media type and size. Pages
store a descriptor ID plus an inclusive line range, exact quote or citation-specific
attribution when needed. Whole-file citations need none of those passage fields.
API reads expand descriptors and retain the `source` ID alongside the full fields.

There is no 48,000-character source limit and no 20-reference-per-record limit.
Pages may omit evidence. Existing claim/relationship evidence requirements are
unchanged. Legacy small text attachments and their line locators remain readable;
old source.text writes remain compatible, including larger originals.

## Storage and transport

`knowledge_attach` uploads bytes in sequential 48 KiB decoded chunks with a stable
request ID and immutable filename/mediaType/attribution. That chunk size bounds
individual RPC payloads, not the file. Chunks are journaled in the plugin's SQLite
state; retries compare offset, hash, size, final flag and metadata. Finishing
streams chunks into an exclusive staging file and installs a complete original
without overwriting an existing file. The completed receipt is durable; only
chunk hashes/receipts remain in SQLite, not another complete file copy.

Originals live at `<scope>/artifacts/<requestId>/<filename>`. Uploading is separate
from page publication. Append the returned evidence using `save_page.attachments`;
page revision/conflict checks still apply. Failed/discarded page saves do not
delete uploaded originals. There is no automatic attachment garbage collection.

No tool accepts an arbitrary host path. Uploads use existing trusted write
authority and vault-identity fences. Downloads require a matching reference and
hash on a record in the authorized scope. Symlinks, hardlinks, unsafe paths,
nonregular files and files changed while reading are rejected. Originals are
streamed for hashing rather than decoded wholesale or charged against the text
catalog's 8 MiB scan budget. Record/ontology catalog bounds remain separate.

`knowledge_record` paginates references (20 by default; up to 100 per response).
Bounded text previews disclose truncation. PDFs/media are downloadable originals,
not claims of extraction/OCR/transcription. `knowledge_attachment` returns original
bytes in at most 32 KiB decoded chunks; clients follow nextOffset (not the upload
chunk size). Base64 plus JSON metadata and tool framing stays below the dynamic
transport's 64,000-character response budget. The browser offers a file picker for
uploads and downloads; where supported it streams downloads to a chosen local
file, otherwise it uses a browser Blob download. Source HTML/SVG is never rendered
as trusted app content.

## Immutable source identity

Descriptors live at `<scope>/artifacts/sources/<id>.json`. The ID is the SHA-256
of canonical, versioned descriptor JSON, including its trailing newline. Fields
use lexicographic key order. Path, content hash and origin attribution all
participate in identity: equal bytes from different origins do not collapse into
one source. Changed or redacted original bytes require a new descriptor.

```yaml
evidence:
  - source: <64-character-descriptor-id>
    start_line: 12
    end_line: 18
    attribution: Speaker attribution for this passage
```

`attribution` on a citation overrides the source attribution for that passage,
without changing the source origin. Resolved API evidence retains its `source`
ID through later edits. Do not change a resolved source path, hash or descriptive
metadata while retaining that ID. Full legacy evidence remains readable for
historical revisions and explicit migrations. Its attribution is preserved as
recorded; the containing page attribution is not inferred to be its source origin.

Resolution starts only after record-scope authorization and reads a bounded regular
file in that same partition. A digest is an identity, not an access credential.
Authority comes from trusted scope selection and local placement, not a
cryptographic scope binding. Copying a record alone does not transfer its source.

Publication journals new descriptors before compact records and rechecks reused
descriptors during acceptance and recovery. Both scan-cache levels track source
dependencies, including missing descriptors. Git observation includes descriptors
used only by annotations. Backups and exports must retain descriptor sidecars
alongside originals and historical raw records. Removing a citation never deletes
a descriptor or original.

## Reviewed reconciliation and representation migration

`knowledge_reconcile_evidence` targets one record with exact vault, ontology,
revision and hash preconditions, a UUID request ID and a reason. Read the complete
page, Timeline, annotations and relevant original passages first.

1. Set `dryRun: true` and choose `representation: compact` or `expanded`. Omit
   `evidence` for a representation-only migration. Inspect the byte and association
   counts. A preview does not publish descriptors or a mutation.
2. To replace an active page's current support, supply the reviewed complete
   `evidence` set. Keep support for historical Timeline assertions as well as
   current State. Annotation evidence remains attached automatically. Absence
   from prose alone is not a reason to remove a source. Claims and relationships
   use correction/annotation operations for support changes.
3. Apply with `dryRun: false` and the same still-current preconditions. Publication
   preserves the body and unrelated metadata, writes a new revision, and retains
   source files, descriptors, other records and old raw revisions. A pure
   representation conversion preserves the previous author attribution.
4. Read back the complete result and verify retained evidence and expected
   revision/hash. Exact retries reuse the mutation UUID and unchanged payload.

`expanded` restores full evidence fields as a new revision. Source identity is
retained, so this is data-format rollback, not permission to downgrade the plugin
binary. Historical compact revisions and pending journals still require descriptor
resolution. Preview refuses an expanded representation that exceeds record limits.
There is no automatic bulk migration, citation pruning or source deletion.

## Gbrain precedent and deliberate differences

Reviewed gbrain's `src/commands/files.ts` (`uploadRaw`) and
`skills/ingest/SKILL.md` at `7cdc3e30a898665a8c87b0c06937f6366f759f6c`.
Its documented policy keeps text/PDF originals below 100 MiB in Git sidecars and
routes larger originals/media to configured object storage with a redirect
pointer. This is a storage-routing threshold, not a source-length requirement.

Knowledge adopts file-backed provenance and the 100 MiB automatic Git threshold:
non-media originals below it can be checkpointed as exact binary Git blobs without
copying the content into a JSON journal. Media/large originals remain in the local
vault outside automatic Git snapshots; their references remain in page history.
No cloud backend, credentials, upload spend or automatic external transfer has
been introduced. The deliberate difference is local retention until an external
storage backend is explicitly selected. Back up the vault directory and operational
state, not just Git, to retain those originals and recovery state.

## Verification

Attachment tests cover larger UTF-8 and binary originals, byte-exact download and
Git blobs, more than 20 source references with exhaustive pagination, interrupted
uploads/replays, changed payload rejection, authority and filesystem boundaries,
source tampering, and originals larger than the catalog scan budget. Existing
publication/recovery tests continue to cover legacy evidence and page saves.
