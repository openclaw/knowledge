---
name: knowledge-ingest
description: Ingest documents, articles, conversations, or supplied text into Knowledge with retained originals, sourced claims, entity updates, timelines, and cross-links. Routes meetings to knowledge-meeting-ingest and short thoughts to knowledge-capture.
---

# Ingest Skill

Ingest documents, articles and conversations into Knowledge. Follow gbrain's ingest workflow;
Knowledge's tools replace its storage, filing, linking, and sync operations.
Read [shared conventions](references/conventions.md) and
[publication](references/publication.md). Use `knowledge-entities` for resolution
and enrichment and `knowledge-meeting-ingest` for meeting transcripts.

## Contract

- Apply the shared reconciliation rules across sources, not just duplicate files.
  Populate supported structured fields, source associations and uncertainty when
  grounded. Check substantive entity synthesis on 3–5 outputs before scaling.

- Every fact written to a page carries an inline source citation with date and
  provenance; unknown dates stay unknown.
- Every identified entity mentioned with a Knowledge page gets a back-link from
  its page to the page mentioning it, within the authorized ingestion scope.
- Raw sources are preserved for provenance with `knowledge_attach`.
- State sections are rewritten with current best understanding, never appended
  to. Preserve unrelated content, user assessments and contradictory evidence.
- File by PRIMARY SUBJECT, not by format. Inspect `knowledge_ontology`; the
  backend assigns the record ID/path. Do not copy gbrain slugs or directories.

## Route and acquire

- Short thoughts/snippets: `knowledge-capture`. Preserve the user's exact wording;
  their language is the insight.
- Meetings: `knowledge-meeting-ingest`; source-specific handling ends at
  normalization, not a separate pipeline for each recorder.
- Articles/web content: use available host fetch tools; extract title, author,
  publication, date and full available text. Summarize executive takeaways and
  key arguments, not a rehash. Explain what is interesting given existing
  Knowledge; flag connections and contradictions as analysis, not source facts.
- PDFs/documents: use available host extraction/OCR; summarize executive
  takeaways, key sections and notable data. Keep the original and extracted text
  separately identified.
- Audio/video/images: use authorized host transcription/OCR when available.
  Retain transcripts (including diarization/timing when supplied) and link them
  from the page. Without extraction, report partial source retention, not completed
  ingestion. Do not invent a Knowledge media tool or add a connector/service.
- Social posts: retain available thread/context and a direct original URL in
  citations. Do not invent inaccessible replies or context.
- Conversations/chat exports: use `knowledge-source-ingest` for acquisition and
  overlap handling when needed, then continue here with the retained snapshot.
  Read substantive discussions with replies and surrounding context; adjacent
  messages may belong to different threads. Preserve stable message/author IDs,
  dates and original labels. Distinguish authors, addressed participants and
  third-party mentions; a mention or reaction is not a statement by that person.
  File durable material by subject and reuse existing pages; do not create a
  page per message or profile every channel member. A digest can orient the
  reader, but apply the entity, assertion, timeline and linking phases below to
  the underlying discussions too.

## Phases

1. **Parse the source.** Read the complete available content in manageable
   sections; extract people, companies, concepts, dates and events. Disclose
   paywalls/truncation. Select exact passages for citations before summarizing.
2. **Check for an existing source and page.** Search source identifiers, title,
   date and content; inspect hashes/evidence. An unchanged source reuses its
   page and evidence; fill in omitted enrichment without duplicating the source.
   New coverage is reconciled into the existing page with retained versions,
   not automatically a duplicate or a correction of every old claim.
3. **For each entity mentioned:** run `knowledge-entities` to read and enrich its
   page, or apply its notability gate before creating. Extract meaningful
   contributions, positions, work and open threads into entity-focused synthesis;
   a mention list or copied discussion summary is not enrichment.
   Resolve spelling variants before creating. Update State
   only where material new evidence changes the picture. Leave uncertain
   identities explicit; do not create a guessed profile.
4. **Preserve raw source and publish.** Retain original bytes, extracted text
   and provenance. Publish the source/subject page with analysis and inline
   citations. When new page IDs are needed, save those pages first, then add
   links using fresh edit preconditions. Follow the publication work log.
5. **Capture independently useful assertions.** Follow the structured-assertion
   guidance in publication: save supported facts, decisions, commitments,
   preferences/beliefs and events as appropriate, with source-page dependencies
   and exact evidence. Do not turn every summary sentence into a claim or promote
   the agent's analysis to source fact. Keep the source's qualifications.
6. **Append to timeline.** Create/reuse a dated event claim for each material
   event, with all resolved relevant entity IDs, source dependency and citation.
   Add a reverse-chronological dated entry on each entity page linking to the
   source. One shared event claim can serve all participants; no copy per entity.
7. **Create cross-reference links.** Use `knowledge_create_relationship` for
   evidenced relationships with labels/endpoints from the current ontology.
   Co-mention supports a prose reference, not an invented employment/ownership
   edge. There is no auto-link post-hook in Knowledge.
8. **Back-link all entities.** Update each identified mentioned entity's page
   with a contextual link back to the source page. Check existing entries first;
   reruns do not append duplicates. Make the source page link to those entities.

## Test Before Bulk

Test on 3–5 items first (or the whole batch if smaller). Read the actual outputs:
substantive titles/analysis, entity context, citations, timelines and back-links.
Fix the approach before scaling. Use host throttling where needed. Knowledge
publishes/indexes and handles local Git history; do not run gbrain sync or commit
private vault files yourself.

## Verify before declaring done

Read every changed page/claim/relationship back, including metadata and all
cited evidence. Verify exact quotes/locators, actual link destinations, entity
back-links and connected claims/edges. Test lookup and distinctive-keyword
retrieval. Follow pagination; a preview is not full readback. For complete-source
verification, download all original chunks.
Use the shared resolved-link and derived-backlink checks, including expected
stable IDs, not just link labels. Keep citations readable and inline, originals
attached, and artifact/hash inventories out of the page body.

On interruption or repeat ingestion, reconcile the itemized work log, receipts,
source evidence and existing connections before creating anything. Use
`knowledge-correct` for an explicit correction, not automatic conflict resolution.
A saved summary alone is not a completed multi-record ingestion.

## Output Format

Report title, page ID/path/type, sources retained, entities created/updated/reused,
claims/relationships and timeline/back-links created/reused, verification actually
performed, and any unresolved identity, conflict or incomplete work. Use partial
when required outputs/checks are missing. No separate ingestion job is created.
