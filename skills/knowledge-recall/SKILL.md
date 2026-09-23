---
name: knowledge-recall
description: Find and answer from saved Knowledge vault pages with source citations. Use for questions about stored documents, meetings, people, or projects; not for recalling conversation history or searching the web.
---

# Recall saved knowledge

Read [shared conventions](references/conventions.md). This workflow is read-only.

1. For a named entity or known record use `knowledge_lookup({query})`. Preserve
   `ambiguous` as ambiguity and inspect candidates rather than choosing one.
2. For topical questions use `knowledge_grep({query})`: literal words, `all` by
   default; try a concise variant, `any`, or `phrase` when useful. No embeddings,
   regex, graph traversal or server-side synthesis is available. Narrow by
   ontology type/kind when appropriate; use `knowledge_records` and pagination
   for an inventory, not a ranked search pretending to be exhaustive.
3. Inspect relevant hits with `knowledge_record`. Read enough context to support
   the answer; follow body/evidence pagination as needed. Compare the hit's
   citation hash/revision to the readback. Restart on changes rather than combine
   incompatible revisions. Use `includeReferences` only for declared structured
   connections; prose links do not populate that list automatically.
4. Answer from the retrieved passages. Cite the title/ID/path and relevant source
   locator; propagate original evidence, not only the generated summary. Label
   synthesis and disagreements. Use lifecycle history filters explicitly for
   historical questions; do not present superseded material as current.
5. Distinguish no matches from inaccessible, invalid, incomplete or failed reads.
   Follow result offsets with unchanged filters and, for keyword search, compare
   `index.snapshot`. If an API pagination bound prevents exhausting results,
   narrow the query or state the coverage limit. Do not claim the vault lacks
   something solely because a short ranked list did not contain it.

Do not capture new pages or enrich entities as a side effect of answering.
