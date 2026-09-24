# Knowledge: design response and handoff

Date: 2026-09-23  
Audience: product design and implementation  
Design reference: `Openclaw design system.zip`, Knowledge v3

## The brief

**Make incomplete knowledge understandable. Don't make it look complete.**

Knowledge is a read-only inspector of what the agent saved, why it believes the
source supports it, and how that understanding changed. It is not a CRM with
required profile completeness, a task manager, or an approval queue. Knowledge
changes happen through conversation and agent tools.

We own extraction quality, structured semantics, evidence integrity, consistent
counts, and usable read APIs. Design should not infer missing semantics from
titles, prose, proximity in a feed, or the shape of a person's name.

## Corrections to the supplied data analysis

These are observations from the live store at review time, not permanent counts:

- Twelve of nineteen current commitments have structured owners. No current
  commitment has a structured due date. Owner presentation is missing, not the
  entire owner data model.
- Superseded and withdrawn records exist, including synthetic verification
  records. Current discovery intentionally excludes historical/ineligible data.
- Line-range citations already produce verified transcript excerpts; a stored
  `quote` is optional, not a prerequisite for evidence.
- Meeting-event claims currently provide shared entity-timeline associations.
  Don't delete or globally hide event claims to remove visual repetition.
- Raw files and current eligible records have different counts. Synthetic data
  leaking into ordinary use is a separate defect that engineering owns.

## Required design adaptations

### 1. Design for sparse, uneven knowledge

A newly ingested meeting collection naturally emphasizes meetings, attendance,
decisions, commitments, and events. Other collections will look different.

- Derive kinds and facets from real supported data; hide empty facets when useful.
- Support entity pages with no role, employer, or rich biography.
- A profile may truthfully contain only what one meeting established.
- Do not add speculative information to make a layout look complete.
- Support the `event` claim kind, currently missing from the v3 prototype map.

Engineering will improve entity-focused summaries. A company introduction should
describe what is known about that company; meeting-specific developments belong
in dated context, not three copies of the same paragraph.

### 2. Unknown is a useful state, not an error

Use neutral labels when the information matters:

| Missing information | Appropriate treatment | Avoid |
| --- | --- | --- |
| Commitment owner | Owner not identified | Unassigned task |
| Deadline | No deadline recorded, or omit | Overdue / invented date |
| Identity | Identity unresolved + source context | Automatically guessed surname |
| Role/employer | Omit or Not recorded | Inference from meeting membership |
| Conversation origin | Conversation not recorded/unavailable | Link to the currently open chat |

A handle or single-word name may be a complete identity. Use “surname unresolved”
only when that specific uncertainty is actually recorded. A contextual label
such as “NVIDIA participant” is not automatically an employment relationship.

### 3. Keep four independent concepts separate

| Concept | What it means |
| --- | --- |
| Assertion origin | Source statement, user statement, or agent inference |
| Attribution confidence | Confidence in a speaker/identity attribution, with a basis |
| Record lifecycle | Active, superseded, withdrawn |
| Real-world completion | Whether an action happened; not inferred from record lifecycle |

“From source” does not mean true. “Original retained” means the file/locator was
verified, not that the claim or speaker identification is correct. “Active” does
not mean an unfinished task. Capturing a commitment schedules nothing.

Canonical origin values are `source`, `user_belief`, and `agent_inference`.
“User statement” must not become “You said” unless the actual speaker is known to
be the current viewer. Confidence must never replace origin or become an
unqualified truth score. Missing confidence means unrecorded, not low.

### 4. Give lifecycle an appropriate visual weight

Keep correction, replacement, withdrawal, reason, and explicit historical
inspection designs. All-active current lists are normal; a repetitive Status
column need not dominate Browse. Use isolated fixtures to exercise uncommon
states rather than adding synthetic corrections to the user's knowledge.

Current discovery must not quietly resurface withdrawn assertion bodies as
struck-through previews. Historical content belongs behind explicit inspection.
Keep lifecycle activity distinct from ordinary source-import grouping.

### 5. Show event time separately from save time

- Meetings/events: prominently show when they occurred.
- Recent: show when knowledge was saved or changed, clearly labeled as such.
- Updated: retain as secondary file/history information.
- Preserve date-only precision; do not manufacture midnight or shift the day.
- Render instants with an explicit timezone convention. UTC next-day storage is
  not evidence of a date error for a Pacific-evening meeting.
- Do not parse or strip arbitrary date-like text from titles as a data contract.

### 6. Group activity without inventing provenance

Prefer expandable source/meeting groups over dozens of attendance rows. Show
meaningful counts and links to the underlying saved records.

Call these **source groups**, not “one ingest,” unless the backend supplies an
actual ingestion-operation identity. Same timestamp, source, or conversation
does not prove one batch or a completed ingestion. Grouping and totals must be
computed over the same authorized data before pagination.

Meeting-page and meeting-event representations can share a presentation when an
explicit association establishes they describe the same meeting. Entity
association alone is not attendance; use the attendance relationship for that.

### 7. Treat assertion continuity as distinct from correction

Similar wording is a candidate for inspection, not a duplicate verdict.

- Repeated import of the same assertion: reuse it.
- Reaffirmation in another meeting: preserve additional source context without
  suggesting a second obligation.
- Updated plan: preserve chronology and what changed.
- Correction: show the explicit replacement chain.
- Independent conflicting accounts: preserve both attributions.

A continuity link must not look like a supersession unless the lifecycle actually
changed. Do not label a commitment completed just because discussion moved on.

### 8. Evidence is broader than a polished quotation

Support full quoted spans, line-derived excerpts, uncertain speaker attribution,
truncated previews, retained originals, verification failures, and unavailable
files. Label excerpts as excerpts. Inferences still have premise evidence even
when no source directly states the inferred conclusion.

Distinguish **unique files** from **citations into files**. Group multiple passages
under their source, but retain locators and differing attributions. An original
export, its derived transcript, and another recorder's transcript are not
automatically duplicate files. Preserve downloadable originals and portable
Markdown source references even when the UI collapses them.

### 9. Resolve ambiguity through chat

Possible-match and correction actions should prepare a contextual request with
the record identity. They must not merge identities, mutate knowledge, or send a
message automatically. Preserve an existing draft; require the user to Send.
Where the host cannot prefill, accurately label the copy-request/open-chat fallback.

No merge dialog, page editor, promotion workflow, or approval queue is implied.
Candidate matches remain possibilities until supported by evidence.

### 10. Live updates must not interrupt reading

Unchanged polling should leave the actual DOM, focus, scroll, open sections, and
unsent chat handoff alone. Real changes should preserve reading state where the
referenced record still exists. Background failure should leave the last readable
view with a status indication. Disconnects and vault changes remain explicit.

## Engineering commitments versus design assumptions

Engineering owns owner/date projection, source-versus-citation counting,
non-disruptive refresh, fixture isolation/filtering, entity synthesis quality,
and evidence-backed reconciliation. We are also resolving typed uncertainty,
source grouping, and assertion-continuity contracts.

This handoff describes agreed semantics, **not proof that every API is deployed**.
Implementation and validation status belong in the accompanying implementation
record. Do not infer fields or availability from this design brief. Keep honest
fallbacks for older records and feature-detect additive read capabilities.

## Acceptance examples for the next design pass

1. A person known only by a handle and one meeting contribution.
2. A commitment with an owner and no deadline; another with neither.
3. A source-only dataset with no preferences or inferences.
4. A meeting yielding many attendance records, grouped without lost drill-down.
5. One transcript with several cited ranges and a separate retained original.
6. A date-only event and an evening meeting crossing a UTC date boundary.
7. Two similar statements that reaffirm each other, and two that conflict.
8. A corrected claim, a withdrawn relationship, and explicit history navigation.
9. Missing evidence and unknown attribution confidence.
10. An expanded evidence section surviving an idle poll and a genuine update.

Use isolated synthetic fixtures for uncommon cases. Never seed the live vault to
make mockups look realistic.
