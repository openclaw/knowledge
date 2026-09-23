---
name: knowledge-entities
description: Resolve people, companies, and projects against the Knowledge vault, and create or update sourced entity pages when requested or needed for an authorized ingestion. Keeps ambiguous names unresolved; not automatic contact enrichment.
---

# Resolve and maintain entity pages

Read [shared conventions](references/conventions.md). Before any write, read
[publication](references/publication.md).

## Resolve before creating or asking

1. Look up the full name or known ID with `knowledge_lookup`; inspect matches.
   For a near-miss, search plausible spellings and related organization/project
   terms. Read existing role/context and its evidence, not just result titles.
2. Compare independent identifiers actually provided: source-confirmed identity,
   organization, role, known interactions. Shared names, similar spellings, email
   domains and repeated copies of one assertion are not conclusive. Keep
   candidates separate and uncertainty explicit; do not auto-merge or add aliases.
3. If uncertainty matters to the requested write, ask a specific question grounded
   in the candidates. Otherwise leave the mention unresolved on its source page
   and continue independent work. An attendee roster alone does not map a voice.
   External research is optional and task-scoped, not a required escalation chain;
   do not send private transcript context to public search or paid enrichment APIs.

## Create or update within scope

- Prefer existing pages. Create only a relevant, sufficiently identified entity
  with substantive source-supported context, not a stub for each name encountered.
- Inspect the canonical ontology type and allowed fields. Put known role/context
  in prose or supported fields, with dates and citations. Do not infer contact
  details, motivations, ownership or employment from co-occurrence.
- Preserve user-authored assessments. Integrate material supported changes into
  current context without erasing history; list contrary evidence with citations.
  A provisional claim stays on the source page until identity/support is adequate.
- Add a dated prose reference back to a source page when it contributes meaningful
  context. Derive relative links from observed paths, retain stable IDs, and attach
  the relevant evidence to the entity edit. Avoid duplicate entries on reruns.
  This is an ordinary page edit, not a graph edge or structured timeline operation.
- Read back each changed page. Return resolved IDs, changed/reused pages and
  unresolved candidates to the calling ingestion. Read-only identity questions
  do not authorize writes; profile consolidation/merging is not implemented.
