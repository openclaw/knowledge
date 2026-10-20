---
name: knowledge-entities
description: Resolve and enrich Knowledge people, companies, projects, and concepts during an authorized ingestion or entity update, with sourced State, timelines, and back-links. Read-only identity questions do not authorize writes.
---

# Resolve and Enrich Entities

Follow gbrain's resolve-before-asking and enrich workflows using Knowledge's
available tools. Read [shared conventions](references/conventions.md) and, before
writes, [publication](references/publication.md).

## Contract

- Check Knowledge BEFORE asking the user or reaching for external lookups.
- Every enriched page has inline citations and bidirectional content back-links.
- Scale effort to importance. No empty stubs, invented roles or boilerplate.
- Preserve user-written assessments; flag contradictions with both citations.

## Resolve before asking

Run this chain in order, stopping at the first evidence-supported resolution:

1. **Search + full page read.** Use `knowledge_grep` to discover entities and
   relevant context. Use `knowledge_lookup` only for an already-known exact
   record ID, full title or declared alias; if it returns `missing`, fall back
   to grep. A name mentioned in conversation is not necessarily a stored alias. Read the
   complete candidate pages and metadata, including role/relationship fields.
2. **Existing sources.** Inspect relevant retained meetings, documents and
   imported context. Knowledge has no mounted-source or synthesis API; use
   available authorized host sources only when needed within the task.
3. **Timeline + connections.** Inspect `knowledge_connections` with directions
   `claims`, `incoming`, `outgoing` and `dependents`, following pagination.
   Use knowledge_timeline({entity: id}) for dated context and
   knowledge_chronicle_last_seen for the latest dated mention/event; inspect
   original records and evidence before asserting attendance or sequence.
   Read connected records and event dates. These are direct connections, not
   semantic search or a multi-hop graph service. Synthesize from the evidence.
4. **External escalation.** If needed, use available host web research with
   public name/company hints. Do not send private transcript/context to public
   search or buy enrichment access. Stop when sufficient evidence is available.
5. **Ask with a hypothesis.** If ambiguity materially blocks the write, state
   what was searched, what was found and the specific candidate/contradiction.
   Otherwise leave the mention unresolved on the source and continue.

A name, email domain, filled role field or repeated copies of one assertion are
not independent identity proof. Keep ambiguous candidates separate. An attendee
roster is evidence of possible presence, not a mapping to a voice. Add spelling
variants as aliases only after identity is established.

Identity keys: when a source gives a stable account identifier, add it to the
person's page as a namespaced alias (`discord:<user id>`, `github:<login>`,
`email:<address>`, `slack:<user id>`) and `knowledge_lookup` that key before
creating a page. One key on two pages is a duplicate. When two pages are
confirmed to be one entity, merge them with `knowledge_merge` (see
`knowledge-correct`); do not write pointer pages or correct claims one by one.

For chat authors, use provider-scoped stable author IDs to connect messages across
display-name changes. Resolve handles against existing pages and retained identity
evidence; display names, mentions and name similarity alone do not identify a real
person. An explicit user identification is attributable evidence: use
`knowledge-correct` to reconcile an earlier unresolved or mistaken profile (merging
its page into the established one), then reuse the established person's page for
subsequent enrichment. A lookup that answers with `redirectedFrom` found a merged
page; use the returned page's ID. Preserve original
author labels and quotes in retained sources. Do not create another profile for
an already resolved handle.

## Enrichment tiers

| Tier | Who | Effort |
|---|---|---|
| Key | Close collaborators, key contacts | Full relevant source context; task-scoped external research when needed |
| Notable | Occasional interactions, relevant industry entities | Source extraction plus Knowledge cross-reference; targeted research if needed |
| Minor | Worth tracking, limited relevance | Source and Knowledge cross-reference; no broad enrichment sweep |

Actual, sufficiently identified meeting attendees get pages even with limited
context: their sourced participation and contribution are meaningful content.
For other mentions, apply notability: likely future interaction, work/interest
relevance, or a reusable concept. Skip incidental names, spam and non-participants.
Chat membership or a brief reply does not use the meeting-attendee exception.
Enrich contributors whose substantive work, positions or ongoing interactions
provide useful context, along with relevant organizations, projects and concepts.
Do not repeat recent enrichment absent new signal. Unknown facts remain absent.

## Enrichment protocol

1. **Identify entities.** Extract people, companies, projects and concepts from
   the source. Distinguish actual participants from third-party mentions.
2. **Check Knowledge state.** Read before create/update. Reuse existing IDs.
3. **Extract signal.** Capture supported roles, projects, beliefs, open threads
   and relationship context—not just a bio scrape. Attribute beliefs to the
   speaker; an agent's assessment is not the person's belief. Do not infer
   motivations from sparse context or propagate uncertain source claims. In a
   conversation, read the reply chain before assigning a position or commitment;
   distinguish suggestions, questions, reported results and agreed decisions.
4. **Look up missing material context.** Follow the resolution chain above and
   stop at the entity's appropriate tier. Unavailable APIs are not requirements.
5. **Save raw data.** Retain used source/API responses with attribution and
   acquisition date via `knowledge_attach`; preserve exact cited evidence.
6. **Write the page.** Inspect the canonical ontology type and fields. Use
   supported aliases/tags/fields; omitted metadata is preserved, supplied
   collections/fields replace the whole value. Never invent frontmatter fields.
   - CREATE: substantive cited summary and State, known relationship/context,
     first dated source reference; omit unsupported template sections.
   - UPDATE: add new Timeline entries. Rewrite a State topic only when the new
     source changes it. A rerun or repeated report changes nothing; don't save.
     Keep user-written assessments. Flag conflicting accounts with both sources.
7. **Cross-reference.** Link the source to the entity and the entity back to the
   source. Update related company/project pages when relevant evidence surfaced.
   Use actual returned paths for links. Create/reuse event claims connected to
   all relevant entities, with source dependencies; inspect existing claims first.
   Create explicit evidenced relationships only using inspected ontology labels
   and directions. Markdown links alone do not create these edges.

## Reconcile evidence associations

Use returned resolved evidence as-is, including its `source` ID. Source descriptors
are shared within the authorized vault scope; do not re-upload originals or invent
IDs to reduce profile size. Retain passage ranges, quotes and attribution.

When an authorized repair requires replacing the current evidence set, read the
complete State, Timeline and annotation support first. Use
`knowledge_reconcile_evidence` with a reason, exact vault/ontology/revision/hash
fences and the reviewed complete `evidence` set. Preview with `dryRun: true`;
apply with `dryRun: false` only after inspecting the result. Preserve historical
Timeline support even if it is absent from State. Annotation support is retained
automatically. Removing an association does not delete originals or history.

For an explicitly requested representation migration, omit `evidence` and select
`representation: compact` or `expanded`. Do not migrate or save a no-op profile
merely to produce a receipt. After a change, verify the complete body, unchanged
metadata, retained evidence and published revision/hash.

## Page structure

### Entity-focused synthesis gate

The opening answers “what do these sources establish about THIS entity?”, not
“what happened in the last call?”. Give each section one job:

- **Introduction:** supported identity, how the person is known, and relevant
  continuing context. Do not turn a single meeting into an enduring biography.
- **State:** the current situation, in short `###` topics named for what they
  cover. A new source usually changes nothing here; its contribution is the
  Timeline entry. When it does change the situation, edit the sentences of the
  existing topic so they read as current; earlier wording stays in the Timeline
  and in revision history. Never add a topic or paragraph named for a date,
  meeting or source.
- **Timeline:** newest first, one line per source event:
  `- **YYYY-MM-DD** — what happened for this entity. [[source|Label · lines]]`.
  One sentence; detail stays in the linked source.

Populate supported ontology fields such as `role` when the source establishes
them, and create evidenced relationships separately. Unknown role, employer and
surname remain absent. Canonicalize generated names using resolved entity names;
never rewrite the retained original or “correct” a verbatim quote.

For partial identity, record structured `identity.status` and context instead of
relying solely on parenthetical title text. Candidates require their own evidence
and remain distinct pages. Identity consolidation is still not implemented.

Keep gbrain's useful structure, scaled to available evidence:

- Person: executive summary (who/how known/why relevant), State, What They Believe,
  What They're Building, What Motivates Them, Hobby Horses, Assessment, Trajectory,
  Relationship, Contact, Network, Open Threads, Timeline.
- Company: executive summary, State, Open Threads, Timeline.

Do not fill headings with speculation or placeholder promises. Unknown data is
not a reason to invent profile completeness. Every factual statement and timeline
entry carries an inline citation; dates refer to the event, not ingestion time.
One event claim can reference several entity IDs; per-page timeline prose remains
useful for human reading. Different companies' feedback needs separate context,
not a copied blob about the entire meeting.

For a worked source-to-profile example with distinct introduction, State and
Timeline, read [meeting and entity example](references/meeting-entity-example.md).

## Verify and report

Run aggregate verification with independently planned authored links in both
directions, associations and relationship endpoints. Read every changed page and
assertion for substantive correctness using compact defaults; request
`includeEvidence: true` for sources/attribution and `metadataView: "full"` for
domain fields. Follow shared pagination and exception-investigation rules; use
compact connections for discovery rather than repeating passed structural checks.
Verify contextual source links in the body separately from derived navigation.
Return resolved IDs, created/updated/reused records, sources used and unresolved
candidates to the calling ingestion. Inspect uncertain
receipts before reruns; never duplicate an unknown prior outcome. Route explicit
corrections through `knowledge-correct`; identity consolidation is not implemented.
For bulk work, inspect 3–5 outputs before scaling and report failures/partial work.
