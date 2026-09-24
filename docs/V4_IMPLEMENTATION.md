# Knowledge V4 implementation

Implemented from the September 24 design archive's `V4_CHANGES.md`. V4 takes
precedence over the older V2/V3 mock and proposal report. The supplied archive is
left untouched and is not part of the implementation commit. No fixture data is
installed in a real vault, no browser write is added, and no live plugin reload is
performed by this change.

## Delivered

- Shared neutral unresolved-identity tags, three-bar attribution confidence with
  an explicit unrecorded state, canonical origins, and event/belief labels.
- Source groups, server-paged group continuation, claim cards and collapsible
  attendance, based only on explicit source/attendance metadata. Lifecycle
  activity is separate, observed changes are not called new, and corrected
  events identify the current title when the replacement remains eligible.
- Occurrence versus saved/updated time; explicit timezone display, date-only
  precision, and a UTC storage-day note on entity headers. Titles stay verbatim.
- Commitment details with unknown owner/deadline fallbacks; evidence labels,
  file verification, missing-file locators, and per-file citation grouping.
- Read-only incoming/outgoing continuity, versions navigation, historical banners,
  no historical correction action, and separate owner-only commitments.
- Entity attendance from relationships, recorded identity context and disclaimer,
  possible-match requests and verified candidate excerpts, plus a source-files
  rail with distinct file/passage totals.
- A native dialog with keyboard dismissal/focus return, selectable read-only
  request, ID/revision/hash, Copy and Open chat. Nothing is pasted or sent;
  passive refresh preserves the modal and its state.
- Exact identity suggestions plus explicitly ranked full-text search; Browse
  inventory filters run on the server before pagination. Current claim facets
  exclude fixtures and unavailable records; origin filters only appear for
  multiple origins. Pages sort by updated time, and history is explicit.
- Idle polling retains the actual DOM. Recent changes wait behind Show; a
  disconnect retains the last readable view and reports the last check time.

## Deliberate capability boundaries

- The update pill counts **activity updates**, not ingestion jobs or individual
  writes: a source group is not proof of one ingest operation.
- No trusted conversation origin, composer prefill, attention API, stable browse
  snapshots, original/derived file-role metadata, or typed recorder-label-to-person
  attribution mapping exists. These are not guessed. No surname-specific tag is
  inferred from a handle or free text.
- The Sources rail counts distinct cited passages from eligible claims explicitly
  associated through `source_page`. Source-only retained files remain separately
  visible. Files attached only to a claim are downloaded from that claim rather
  than broadening the source page's attachment authority.
- Entity connections/attendance retain existing progressive pagination and label
  partial counts as shown. Versions inspect up to ten linked records, and source
  file summaries inspect up to 100 files with an explicit bound. More files and
  history remain accessible through their individual records.
- Old records without `source_page` are not silently assigned to meetings. Meeting
  claims require that explicit association. Event entity associations are never
  counted as attendance.
- Mobile is not a new design target, but existing 760px/390px overflow coverage is
  retained. Existing host tokens/icons and sanitized Markdown are reused; no UI
  framework or package dependency is added.

## Verification

`npm run check`, `npm run build`, `npm run validate`, `npm test`, and
`node test/browser/live-state.mjs`. The isolated browser suite checks actual
navigation, downloads, no browser knowledge writes, light/dark layouts, mobile
bounds, handoff preservation, lifecycle/history, server filtering, and V4
source-group/attendance/update/disconnect interactions. Artifacts are emitted to
the suite's temporary directory, not the production vault.

## Visual alignment follow-up — September 24

The selected OpenClaw theme owns typography; a different font from the prototype
is not a design-fidelity defect. This follow-up preserves the host font and color
tokens while aligning Recent with `KnowledgeV4Screen.jsx`:

- Full-width source groups without stacked outer/body/row padding; compact save,
  attendance, and claim rows share one alignment and subtle separators.
- Occurrence and saved-time metadata below the source title, with explicit
  Collapse/Expand labels. The source opens from its normal save row.
- Secondary icon/text save states and navigation chevrons instead of New/Updated
  pills. Lifecycle correction/withdrawal labels remain distinct.
- Styled Show all/Hide attendance disclosure with attribution/confidence retained
  in an inset list. Native details retain keyboard interaction and reading state.
- Group pagination keeps subsequent pages and claims in their respective sections.

The browser integration check measures row alignment and compactness, exercises
keyboard disclosure and attendance controls, verifies dynamic host-font inheritance
and mobile bounds, and emits desktop/mobile/theme screenshots. Build, type checking,
and plugin validation are required as usual. The design archive remains untouched
and excluded from implementation commits.
