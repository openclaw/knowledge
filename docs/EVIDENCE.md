# Original source files

Evidence is retained as original files, not text squeezed into a page-save field.
The page carries file references, SHA-256 hashes, attribution, filenames, media
types and sizes. Text citations may narrow a file reference to an inclusive line
range and optional exact quote; whole-file references need neither.

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
