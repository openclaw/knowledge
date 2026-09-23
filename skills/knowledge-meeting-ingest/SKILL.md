---
name: knowledge-meeting-ingest
description: Ingest meeting transcripts or notes into Knowledge with retained sources, evidence-based speaker resolution, decisions, commitments, chronology checks, and relevant entity updates. Summary-only input is explicitly partial, never transcript-verified.
---

# Ingest a meeting

Read [shared conventions](references/conventions.md),
[publication](references/publication.md), and
`knowledge-entities`.

## Normalize and retain

Use the available host connector/file tools to acquire the user-selected source.
Normalize recorder name, source ID/URL, title, known date/time/timezone, candidate
attendees, raw speaker labels, segment order/timestamps, full available transcript
and any recorder summary. Unknown values stay unknown. Preserve the original
export and full transcript as evidence; normalized text is a separately identified
derivative. Do not replace the transcript with the recorder's summary.

If only manual notes or an automated summary exist, retain and attribute them as
such. A notes-based page can be saved, but report transcript verification as
unavailable and the ingestion as partial. Never fabricate quotes or attendee
certainty from that input. Empty/in-progress sources need a partial-status report,
not a completed meeting. Transcription is a host capability, not a Knowledge API.

## Identify the meeting and speakers

1. Detect recordings spanning genuinely separate meetings: roster changes plus
   context resets are evidence; a topic change alone is not. Keep ordered,
   nonoverlapping segment ranges covering the whole recording. For justified
   splits, write one page per meeting, identify the shared source and boundaries,
   and cross-reference sibling pages after their IDs/paths are known.
2. Deduplicate against existing meetings using source ID, date/time, participants
   and substance. Two recorders can cover one meeting: preserve both originals
   and their coverage differences rather than make a second page automatically.
   Fuller coverage does not necessarily mean more accurate speaker labels.
3. Resolve people from stored Knowledge and explicit source/user evidence before
   new profile creation. Preserve a map of raw label → supported identity or
   `unresolved`, with the basis. Invitees are not necessarily attendees; attendees
   do not automatically map to a specific voice. Conflicting roles, extra speaker
   tracks and garbled names warrant review, not automatic reattribution/merging.
4. User corrections are new attributed evidence: update the interpretation and
   explain what changed while preserving the original transcript. Keep remaining
   uncertain statements on the meeting page; don't propagate them into profiles.

## Summarize, publish, verify

- Use the current `meeting` definition (or another suitable available type).
  Capture summary/outcomes, decisions, action items, substantive discussion and
  useful exact quotes. Say when no decision/action was recorded, rather than
  infer agreement from enthusiasm or jokes. Include owners/deadlines only when
  supported; keep unresolved ownership explicit. Capturing an action does not
  create a task, send a message or schedule a reminder.
- Cite the transcript location for material claims, decisions and quotes. Check
  surprising role/ownership/deal claims against the actual passage and existing
  evidence. Flag contradictions with both citations; do not let a recorder
  summary overwrite a profile. Mark interpretation separately from statements.
- Check chronology independently of substance. Verify any before/after/causal
  sequence against segment order and timestamps; distinguish discussion of a past
  event from something occurring during the meeting. Do not invent transitions
  to make a narrative flow. Fix unsupported sequence claims or label ambiguity.
- Publish the meeting, then make relevant, supported entity edits with references
  back to it. Preserve existing prose, cite evidence and avoid duplicate timeline
  bullets. Unknown speakers do not get invented person pages. These are separate
  page saves; structured attendance edges/timelines are not available.
- Before reporting completion, read back every changed page and evidence locator,
  verify quoted spans exactly against the retained transcript, check speaker
  uncertainty labels, confirm links target real records, and retrieve the meeting
  by a distinctive keyword. Check the work log for unfinished entity edits or
  conflicts. An unresolved speaker can remain explicitly unresolved; it must not
  masquerade as verified attribution.

Report page IDs/paths, sources retained, entity pages changed/reused, captured
decisions/actions, and checks actually completed. State partial work, contradictory
evidence, uncertain attribution and unavailable transcript verification explicitly.
Do not claim gbrain-style enrichment, graph creation or multi-record job recovery.
