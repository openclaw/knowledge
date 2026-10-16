---
name: knowledge-meeting-ingest
description: Ingest meeting transcripts from any recorder into Knowledge with attendee enrichment, entity propagation, timeline merge, supported decisions and commitments, and verification of substance and sequence. Summary-only input is not a verified meeting ingestion.
---

# Meeting Ingestion Skill — Unified Pipeline

Follow gbrain's meeting-ingestion phases and verification gate. Read
[shared conventions](references/conventions.md),
[publication](references/publication.md), and `knowledge-entities`.
Source-specific fetch/parse is the host agent's job; normalize once, then run this
pipeline. Do not build a per-vendor pipeline or a Knowledge ingestion job.

## Contract

- One page per REAL meeting; split multi-meeting recordings first.
- Retain the full transcript and provenance; recorder summaries are claims,
  not facts. Speakers are resolved by evidence, never by guess.
- Meeting page includes attendees, Summary, Key Decisions, Action Items and
  Notable Quotes. Empty sections carry an explicit source-grounded reason.
- Every sufficiently identified actual attendee gets a substantive person page.
  Every relevant company/project/concept gets entity propagation.
- Timeline context and bidirectional back-links cover all resolved mentioned
  entities with pages. Unverified claims do not fan out.
- Supported decisions, commitments and events become independently retrievable
  claims. Explicit relationships carry evidence, not just co-mention.
- Never report a meeting fully ingested until every output and verification item
  is accounted for. Verify sequence independently from substance.

## The normalized transcript record

Reduce the input to this shape in task working context; it is not a new API:

```yaml
source: "<recorder name, or 'manual'>"
source_id: "<recording ID, if supplied>"
title: "Meeting Title"
date: YYYY-MM-DD               # null if unknown
time: "HH:MM TZ"               # null if unknown
duration: "45m"                # null if unknown
attendees:                     # source claims, not verified identities
  - name: "..."
    email: "..."               # only if source provides it
    role: "..."                # only if known
transcript_segments:
  - speaker: "..."             # resolved name OR explicitly unresolved
    speaker_raw: "..."         # retain original label for traceability
    text: "..."
raw_transcript_text: "..."     # complete available transcript, never truncate
source_summary: "..."          # recorder summary is a CLAIM, not a FACT
source_url: "..."              # if supplied
```

Retain source segment order/timestamps when present. A summary is two lossy
layers removed (transcription + summarization).
Retain the original export and transcript with `knowledge_attach`, then attach
returned evidence to the meeting page. Normalized text is a labeled derivative,
not a replacement for the original. Inspect for captured credentials before
retention; redact live secrets and label the redacted derivative honestly. Respect
requested privacy limits; never call a redacted file byte-identical to the input.

## Phases

### Phase 1: Normalize the input

Acquire the user-selected source with available host tools and normalize it.
Empty transcripts, summary-only payloads and in-progress recordings do not pass
this phase. Report the missing source; do not create a completed meeting from a
summary alone. If the user requested saving only notes, use `knowledge-capture`
for attributed notes and explicitly state that meeting ingestion is not complete.
Transcription is a host capability, not a Knowledge tool.
For API acquisition, read [source acquisition](references/source-acquisition.md):
verify date filters, follow every transcript cursor, and record coverage before
normalizing. It includes the Granola endpoint/parameter reference.

### Phase 2: Split detection — one recording is not always one meeting

Investigate roster shifts, topic hard-cuts, fresh introductions/context resets,
or an agenda naming multiple sessions. Two or more signals strongly suggest a
split. Same people in one flowing conversation changing topics is ONE meeting.

For a supported split, partition the transcript into contiguous nonoverlapping
segment ranges: no dropped or duplicated segments, original order preserved.
Run remaining phases once per meeting, with its own title/date/attendees. Identify
shared source ID and exact boundaries on each page; cross-link siblings after
IDs/paths are known so dedup does not merge them back. Flag uncertain boundaries.

### Phase 3: Dedup across recorders

Search existing meetings by source ID, title/attendees and date. Gbrain's date
±1 day, attendee overlap ≥50%, similar title rule is a candidate screen, not
proof. Read the candidates and coverage before deciding.

If the same meeting exists, reconcile into it instead of creating a duplicate.
Retain both source IDs/originals and coverage differences. Use the richer
transcript for coverage; source completeness is not speaker-label accuracy.
Record source identifiers in prose or allowed ontology fields, never arbitrary
frontmatter. Inspect existing assertions/connections as well as the meeting page.

### Phase 4: Speaker resolution — before writing the page

1. Start with the source attendee list and explicit roster/user evidence.
2. **Never guess.** Use `[Room]` or `UNKNOWN` with an uncertainty flag when needed.
3. Resolve candidates through `knowledge-entities`; read existing evidence.
4. Record raw label → supported identity or unresolved, with basis and qualitative
   confidence (high/medium/low). Confidence is attribution confidence, not truth.
   A roster-confirmed attendee still needs evidence linking them to the track.
5. **Content-identity check:** compare a speaker's claimed role/company with the
   named person's evidence. A contradiction signals possible mislabeling; inspect
   before reattributing a whole track. Do not treat every new role as an error.
6. **Phantom-speaker check:** more tracks than confirmed attendees, mid-thought
   handoffs or labels never addressing each other suggest over-splitting. Merge
   labels only when evidence supports the identification, not from counts alone.
7. **User ground truth:** an explicit user identification corrects the mapping.
   Retain it as attributed evidence; preserve the original recorder transcript.
   Route repairs of existing assertions through `knowledge-correct`.
8. Search plausible spelling variants before creating a transcript-only person.
   Once identity is confirmed, reuse the page and optionally add the alias while
   preserving existing aliases. A near-match alone is not a confirmed identity.

### Phase 5: Create meeting page

Use a clean source title; store the occurrence date/time in the meeting ontology's
`fields.occurred_at` at source precision. Include source timezone context in the
body. Do not append an ingestion date to a title or guess a timezone to resolve a
relative deadline. A date-only value is not a midnight instant.

Use the current ontology's meeting definition and actual resolved page links:

```markdown
# {Meeting Title}

**Attendees:** {resolved people with links; uncertain identities flagged}
**Date:** {known date, otherwise unknown}
**Duration:** {if available}

## Summary
{3–5 key outcomes, each citing the lines that support it}

## Key Decisions
{Decisions with context and citations.
If none: _No decisions — discussion only._}

## Action Items
{Supported commitments, owners/deadlines when known, citations.
If none: _None — exploratory conversation._}

## Notable Quotes
{Verbatim transcript spans, attributed, in blockquotes with citations.
If none: _No notable quotes — operational/logistics meeting._}

## Discussion Notes
{Structured notes by topic, with citations}

## Source Context
{Only relevant provenance: source ID/URL, raw speaker label → supported identity
or unresolved with basis, coverage/split boundaries or transcription limitations.
Use readable inline citations, not artifact paths or hashes.}
```

Summary, Key Decisions, Action Items and Notable Quotes are required. Additional
sections are additive. Before writing “none”, check the transcript. A bare `None`
is not a reason. Quotes are VERBATIM; paraphrase in a quote block is fabrication.
The transcript remains an attachment, not a truncated page-body replacement.
Source Context is optional when this information is already clear in allowed
fields or nearby prose; speaker-resolution evidence must still be retained.
Cite the meeting's own observed path for transcript passages, with verified line
labels, and resolved entity paths for attendees/mentions. Keep hashes and exact
locators in attached evidence, originals in File details, and no Sources footer.
Follow publication's create-then-link procedure rather than predicting filenames.
For a complete paired example, read
[meeting and entity example](references/meeting-entity-example.md).

### Phase 6: Claim verification + consistency check (gate for every entity write)

Reconcile each proposed assertion against earlier meetings about the same entity,
not only reruns of this source. Use shared publication guidance to distinguish
reuse, additional support, dated reaffirmation, updated plan, contradiction and
explicit correction. Similar titles alone never authorize supersession.

| Claim type | Verification bar |
|---|---|
| Role/relationship change | Explicit transcript passage, not enthusiasm or implication |
| Ownership/attribution | Explicit ownership language or corroborating evidence; saying a name is not owning it |
| New proper noun | Search Knowledge for canonical spelling, then public sources if appropriate; otherwise label unverified spelling |
| Major life/deal event | Verbatim support; inspect existing evidence and chronology |

Also check existing Knowledge for contradictions and logical plausibility.
Surprising claims deserve extra scrutiny, not a story that rationalizes them.
Preserve conflicting accounts with both citations; neither older synthesis nor
newer transcript automatically wins. An explicit correction is distinct from a
changed plan or independently conflicting source.

**Downgrade:** an inference or uncertain identity stays labeled on the meeting
page; it must not enter entity State, metadata, timelines or relationships as
fact. Failed verification must not fan out.

After this gate, create/reuse separately useful claims with
`knowledge_create_claim`: decisions, commitments, material facts/beliefs and dated
events. Use `assertion_origin: source` for transcript statements and name the
speaker in attribution, including unresolved labels. Preserve conditions such as
“subject to review”. Use resolved
entity IDs and a meeting dependency, plus exact transcript evidence. Known owner
and due date belong on a commitment; omit unknown ones. Relative dates require
sufficient source date/timezone context. No task or reminder is created.

### Phase 7: Attendee enrichment (MANDATORY)

For EACH actual attendee, run `knowledge-entities`:

1. Search and read the existing person page, or create a sourced one if identity
   is sufficient. Participation and actual contribution are meaningful context;
   do not create a content-free stub or fabricate a profile for UNKNOWN.
2. Rewrite a State topic only if this meeting changes it.
3. Add a one-line dated “Attended {meeting}” Timeline entry, newest first, with a
   link back and citation, in the `knowledge-entities` Timeline format.
4. Create/reuse an evidenced attendance relationship via
   `knowledge_create_relationship`; inspect the current label/direction first.
   In the shipped ontology, `attended` runs **participant → meeting**, unlike
   gbrain's meeting auto-link direction. Knowledge has no auto-link post-hook.

Back-link known people mentioned or speaking in the transcript too, not just
attendees, but only supported identifications.
Unknown speaker attribution can remain flagged without a fabricated entity.

### Phase 8: Entity propagation + timeline merge (MANDATORY)

For each relevant company, project or concept discussed, check existing pages,
create/update as appropriate under `knowledge-entities`, add sourced timeline
context and back-link to the meeting. Link back from the meeting to each entity.

The same event belongs on ALL resolved relevant entities' timelines. Represent
it as one event claim with `occurred_at`, all relevant `entities`, a meeting
`dependencies` reference and evidence. That makes it discoverable from every
entity's `knowledge_connections({id, direction: "claims"})`. Chronicle projects
these structured dates into a queryable timeline. Set
source_page and source_event=true on the single claim representing the meeting
itself; its occurred_at must match the meeting field at source precision. Other
events discussed retain their own dates and are not source_event.
Retain dated human-readable timeline links on profiles.
Different companies' feedback gets its own context, not a session-wide blob.

Create additional relationships only when evidenced and supported by ontology
labels/endpoint types. Preserve original thinking worth capturing in the user's
exact words; label analysis separately. No unavailable signal-detector or
background enrichment workflow is implied.

### Phase 9: Sync / retrieval

No sync command is needed: published saves are immediately readable and search
reconciles its own index. Check receipts and fresh retrieval. A pending index/Git
checkpoint is not permission to create another copy.

## Verify before declaring done (HARD GATE)

Run every check for every meeting, including quick logistics meetings.

- **V1 — Required sections have substance.** Summary has concrete outcomes;
  Decisions, Actions and Quotes have content or a verified reason for absence.
  Independently useful assertions were created/reused, not left only in prose.
- **V2 — Every entity link has a page AND timeline backlink.** Read each linked
  page; verify the source backlink, dated context, connected event claims and
  evidenced attendance edges where applicable. Inspect all changed records,
  compact metadata and relevant evidence (`includeEvidence: true`), following
  pagination. No guessed paths or empty stubs. Use `knowledge_verify` with
  independently planned `expectedLinks` for both authored directions and expected
  event associations/attendance endpoints. Discover graph context or investigate
  failures with compact connections and record links; do not repeat successful
  structural checks merely to obtain larger responses. Automatic reverse
  navigation does not prove an authored contextual link.
- **V3 — Speaker map resolved or flagged.** No raw label silently masquerades as
  a known person. Every named speaker has an evidence basis/confidence.
- **Structured readback.** Known commitment owners are resolved page IDs, not just
  names in prose. Supported deadlines and event dates retain source precision.
  Attendance edges have `source_page`; qualitative speaker-attribution confidence
  carries its basis and retained evidence in `attribution_confidence`. Unknown
  values stay absent. Meeting-event associations use `source_event` only for the
  meeting itself. Use aggregate expectations for exact owners/dates/source pages,
  associations and endpoints. Read compact metadata and explicitly requested
  evidence to judge attribution confidence and its basis; structural success
  does not replace that semantic review.
- **V4 — Every quote grounded VERBATIM.** Locate each quoted span in retained
  transcript text. Read the exact lines, not just `evidence.verified`. Restore
  spoken phrasing or choose a supported contiguous span if it fails; never keep
  paraphrases in blockquotes. A summary cannot verify a transcript quote.
- **V5 — Fabricated-attendee sanity checks.** Names absent from transcript and
  roster evidence, or email domains conflicting with known identity, require
  inspection. Do not auto-rename or fill addresses. Repair affected outputs
  within scope, then recheck. Uncertain identities stay explicitly uncertain.
- **V6 — Sequence verify (order, not substance).** Extract narrated event atoms
  (before/during/after, place, people). Check claimed sequence against timestamps
  and source context independently of thematic heading order. A phase inversion
  or incompatible locations/times is a hard contradiction; never invent transit
  to connect them. Inspect dated connected claims for corroboration where useful.
  Use knowledge_chronicle_day with the meeting date and known timezone, and
  knowledge_timeline with relevant entity IDs. Verify source-event grouping and
  world dates independently from recorded_at. A missing event is a signal to investigate,
  not proof someone was absent. Fix contradictions and rerun, or record an
  explicit user waiver as acknowledged, NOT resolved. Genuinely ambiguous order
  stays flagged.

Check the work log against receipts and records; verify exact lookup and a
characteristic keyword. On repeat/interruption reconcile sources, existing claims
and relationships before new writes, using the publication retry rules.
Fix → re-check until checks pass or clearly report partial/not fully ingested.
A user sequence waiver applies only to V6, not other failed checks.

## Sensitive meetings

For legal or deeply personal content, keep the page factual and restrain
biographical propagation/back-links. Respect the user's requested scope; clarify
when needed before spreading sensitive content into other profiles.

## Output Format

Report per real meeting: page ID/path, retained sources, attendees enriched,
entities updated/reused, claims/actions/relationships captured, verification
passed or specific failures, sequence PASS or explicit WAIVED with the remaining
contradiction. List withheld claims, unresolved identities and missing work.
Never say fully ingested before the checklist passes; a partial report is honest
progress, not completion. No multi-record job or rollback guarantee is claimed.
