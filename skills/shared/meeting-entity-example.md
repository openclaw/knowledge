# Worked example: meeting → entity

Synthetic illustration only; never publish these records into a real vault.
Assume identity checks have resolved Morgan and the API returned
`meetings/reliability-review.md` and `people/morgan-hale.md`. These are observed
paths in this example, not filenames to guess in a real ingestion. The following
are final page bodies after revision-fenced link edits, not source transcripts
or client-authored frontmatter.

## Retained input and evidence

The complete supplied transcript has these six lines (numbers are explanatory,
not bytes to prepend to the original):

```text
1  Meeting: Reliability review
2  Date: 2026-09-23. Attendee: Morgan Hale. Speaker mapping: Morgan = Morgan Hale.
3  Morgan: I reviewed the failure logs. Two failure cases still need investigation.
4  Morgan: My decision is to hold the release until those cases are understood.
5  Morgan: I will send the failure report. I have not set a deadline.
6  Morgan: That is the end of this review.
```

Retain the exact supplied transcript with attribution. Reuse the returned
evidence object's path/hash; add verified `start_line`/`end_line` for each cited
span. Attach relevant evidence to the meeting, profile and structured assertions.
Line labels below do not replace those structured locators. Unknown duration,
employer, formal role and deadline remain absent.

## Meeting body

```markdown
# Reliability review

**Attendees:** [[people/morgan-hale|Morgan Hale]] (transcript roster and speaker mapping).
[[meetings/reliability-review|Transcript · line 2]]
**Date:** 2026-09-23. [[meetings/reliability-review|Transcript · line 2]]

## Summary
Morgan reported two unresolved failure cases and decided to hold the release
until they are understood. [[meetings/reliability-review|Transcript · lines 3–4]]
Morgan offered to send a failure report without setting a deadline.
[[meetings/reliability-review|Transcript · line 5]]

## Key Decisions
- Morgan decided to hold the release until the two failure cases are understood.
  [[meetings/reliability-review|Transcript · lines 3–4]]

## Action Items
- Morgan will send the failure report; no deadline was set.
  [[meetings/reliability-review|Transcript · line 5]]

## Notable Quotes
> My decision is to hold the release until those cases are understood.

— Morgan Hale. [[meetings/reliability-review|Transcript · line 4]]

## Source Context
The supplied transcript maps the raw label “Morgan” to Morgan Hale and lists
Morgan as the attendee. [[meetings/reliability-review|Transcript · line 2]]
```

## Resulting person body

```markdown
# Morgan Hale

Morgan's known context here is failure-log review: in the reliability review,
Morgan described investigating failures and deciding whether to release.
[[meetings/reliability-review|Reliability review · lines 3–4]]

## State
As of the September 23 review, Morgan had committed to sending a failure report
without a deadline. [[meetings/reliability-review|Reliability review · lines 2, 5]]

## Timeline
- **2026-09-23:** Participated in the reliability review and reported two failure
  cases requiring investigation.
  [[meetings/reliability-review|Reliability review · lines 2–3]]
```

The introduction describes Morgan's source-grounded context, State captures the
dated open commitment, and Timeline records participation/contribution. None
asserts an employer, job title, enduring personality trait or later completion.
For the noncontiguous State citation attach separate line-2 and line-5 evidence.

## Structured records and checks

- Use the observed meeting ID as `source_page` on extracted assertions and the
  attendance edge, and as a dependency where appropriate. The meeting itself
  does not point to itself through `source_page`.
- Create/reuse a source-attributed decision supported by lines 3–4 and a
  commitment supported by line 5. The commitment's `owner` is Morgan's observed
  page ID; omit `due_at`. Neither record schedules work or proves completion.
- Create/reuse one event for this meeting with `source_event: true`,
  `occurred_at: "2026-09-23"`, the meeting `source_page`, Morgan's ID in `entities`
  and lines 1–3 as evidence. Do not create another event for each profile.
- Inspect the ontology before publishing the evidenced `attended` relationship
  from Morgan → meeting. Retain the source speaker-mapping basis in qualitative
  `attribution_confidence`; this is attribution confidence, not truth scoring.
- Read both complete page bodies, metadata and evidence. All intended `links`
  must resolve to the observed IDs. Meeting `links` includes Morgan; Morgan
  `backlinks` includes the meeting. Morgan `links` includes the meeting; meeting
  `backlinks` includes Morgan. Follow connection pagination and check stable
  snapshots. Repeated citations yield one neighbor, not one edge per citation.
- Separately read `claims` and typed `incoming`/`outgoing` connections and verify
  retained passages. Source self-links open retained originals, not a specific
  transcript line. No hash inventory, raw filename citation, Sources footer or
  hand-written derived backlink list belongs in either page.
