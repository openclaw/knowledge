---
name: knowledge-ingest
description: Ingest a document, article, or supplied text into sourced Knowledge pages, retaining originals, resolving relevant entities, and verifying retrieval. Routes meetings to meeting ingestion; extraction uses available host tools and may be partial.
---

# Ingest documents

Read [shared conventions](references/conventions.md) and
[publication](references/publication.md). Use
`knowledge-entities` for relevant names.

## Route and acquire

- Short thoughts/snippets: `knowledge-capture`.
- Meeting notes/transcripts: `knowledge-meeting-ingest`.
- Documents/articles: continue below. Use available host fetch/file/extraction
  tools for the source the user selected. Acquisition is not a Knowledge tool.
- Audio/video/images requiring transcription/OCR: use a host capability only if
  available and authorized. Otherwise retain the available source, report the
  missing extraction and mark the result partial. Do not invent a media tool,
  subscribe to a service, or claim that file retention proves content was read.

## Source-to-page loop

1. Identify title, author, date, URL/provider ID and complete available content.
   Disclose paywalls, missing sections or truncated fetches. Preserve original
   bytes before synthesis; retain extracted text separately with provenance.
2. Search existing pages by title and distinctive source identifiers. Inspect
   matching evidence hashes/content. Reuse an unchanged source/page; for an
   updated source, attach the new version to a reconciled edit with both versions
   identified. Similar titles alone do not establish a duplicate.
3. Read the full available source in manageable sections. Summarize the primary
   subject, material findings, numbers/dates, stated decisions and open questions.
   Separate source assertions from interpretation. Select exact passages for
   citations, preserving line/section locations; don't cite unread portions.
4. Resolve relevant entities, preserving uncertainty. Create/update entity pages
   only for material, supported context within the request. Choose types from
   the current ontology, not from upstream hard-coded directories.
5. Publish the source summary with original evidence and inline citations. If
   entity updates depend on this page's ID/path, publish it first, then reconcile
   entity pages and, if needed, update its links using fresh edit preconditions.
   Maintain the per-page work log; do not imply an atomic multi-page ingestion.
6. Verify the published body, each cited locator and the original reference.
   Resolve all authored page links against actual records, then test retrieval
   with a distinctive term. If the complete original is needed for verification,
   download all chunks; bounded excerpts are not enough to claim full readback.

Report the saved/reused pages, retained originals, citation/readback checks and
any extraction, identity or publication gaps. For a batch, verify one representative
item before scaling. If interrupted, reconcile the work log against receipts and
existing pages; only individual uploads/publications have backend resume support.
