# Knowledge UI redesign: implementation boundary

The September 23 design prototype is implemented against the existing typed
Knowledge operations. The UI is an inspector; all knowledge changes go through
an agent. It no longer mounts the page/claim/relationship editor, recovers browser
editing drafts, uploads sources, resumes saves, or retries Git writes. Existing
browser draft storage is left untouched.

## Available now

- **Recent** is the default, with paginated observed history grouped by date.
  Rows identify the observed revision and open the current authorized record.
- **Browse** uses ontology categories/counts, hides empty page types, and switches
  among pages, claims, and relationships. No full-vault client-side loading.
- One search input offers **exact** title/alias matches as you type and explicit
  ranked full-text search. Ranked search is distinguished from inventory.
- Entity detail combines its body, aliases, ontology-labeled fields, linked claims
  grouped by canonical kind (including events), typed connections in both
  directions, evidence, and collapsed file details.
- Owner-only commitments are labeled separately from claims about the entity.
- Typed connections open the other endpoint; a separate link opens relationship
  evidence. Portable references are labeled as non-asserted links.
- Claim cards distinguish source assertions, user statements, and agent inference.
  An inference does not claim to quote a source statement, but retains and exposes
  its premise evidence. Unknown origin is not guessed.
- Evidence previews, verification status, locators, progressive source listing,
  and byte-exact original downloads use the existing shared service.
- Correction/ask handoffs show a **read-only copyable request** containing the
  target ID, observed revision, and content hash. Opening a chat never sends it.
  A passive refresh preserves an unsent request.
- Lifecycle reason and original/replacement navigation appear when those metadata
  fields are supplied by the correction backend.
- Vocabulary and vault diagnostics are secondary views. The navigation icon is
  the supported `book` glyph. Layout uses host tokens with scoped fallbacks.

## Explicit interim limits

These are not simulated or filled with prototype sample data:

- The host cannot prefill its composer or attach structured reference chips.
  The fallback is **Copy request → Open chat → paste, review, send**.
- No trusted conversation origins or conversation-grouped recent operation exist;
  date-grouped history is shown instead. “Learned in” says provenance is unavailable.
- No attention operation/unresolved-mention storage exists; no fabricated
  “Needs a look” section or totals are shown.
- Record summaries lack timestamps and eligible claim/connection counts. Browse
  omits those columns and does not pretend to sort by last saved.
- Browse lacks stable snapshots and its server offset is capped at 500. The UI
  states the paging limitation and stops instead of sending invalid offsets.
  Inventories beyond 550 records are explicitly labeled partial browse access.
- Suggestions are exact identity matches, not prefix matches.
- Connections hydrate at most 20 links/claims per request and expose load-more.
  A snapshot change stops mixed-page rendering. Combined entity response/counts
  remain backend follow-up work.
- Entity body summaries are safe text paragraphs. Raw Markdown is available in
  File details with hash-checked paging. A supported sanitized Markdown renderer
  remains a follow-up; arbitrary source HTML is never inserted.
- Reverse labels use `← label` until ontology inverse labels are supported.
- Host styles are tokens plus scoped fallback CSS, not a new claimed stable host
  component contract. No new icon library is bundled.

## Verification

Run `npm run check`, `npm run build`, `npm run validate`, and
`node test/browser/live-state.mjs`. The browser suite seeds an isolated vault
through the service, prohibits every browser knowledge action, tests claim/evidence
presentation and chat handoff, and writes desktop/mobile screenshots to its printed
temporary artifact directory. `test/browser/structured-writes.mjs` is a compatible
entrypoint for the same read-only browser suite; backend structured write tests
remain in `test/structured-writes.test.mjs`.

The lifecycle browser case calls `correct` and `withdraw` through a trusted
agent-tool fixture (not browser/operator actions), verifies live replacement and
withdrawal, and inspects reason/original/replacement navigation. In Recent,
inactive records get minimal historical notices with their **current** lifecycle;
old history timestamps are not relabeled as correction/withdrawal event times.
Their assertion titles do not appear as current feed cards. Search also stops
before the server's maximum paging offset.

For reference-fidelity dark screenshots, set `KNOWLEDGE_DESIGN_ROOT` to the
extracted design archive directory when running the browser suite. It loads that
archive's exact color/typography/spacing tokens and embeds its local Instrument
Sans and JetBrains Mono font assets. No network font requests are made. Without
that directory, the test uses dark host-token values and the system font fallback.

## Visual-fidelity refinement

The follow-up pass uses the supplied `KnowledgeV2Screen.jsx` design directly:

- One three-column header, centered text tabs with the actual page inventory
  count, a live-status dot, and a compact vocabulary icon action. Vault status
  remains available inside Vocabulary.
- A 1,120px content frame, 210px Browse type rail, 300px entity sidebar, and the
  reference title/body/eyebrow sizes, surface radii, hairlines, and spacing.
- A small static subset of the supplied SVG glyphs, not a runtime icon library.
  Type-colored tiles appear in the feed, facets, table, entity header, and linked
  entities; claims have kind and provenance icons. Vocabulary uses the same
  glyph system instead of Unicode symbols.
- Compact grouped claim rows. Their chevrons reveal retained evidence,
  attribution, and correction actions; the statement still opens its record.
- Search in the Browse table toolbar, exact-match suggestions, and `/` to focus
  search. Enter explicitly runs ranked search; typing does not pretend to filter
  the complete paginated inventory.
- Unavailable backend information is still omitted, not populated from the mock.
  Explanatory implementation limitations are under “About this list/activity.”

For production-style visual verification, set `KNOWLEDGE_HOST_UI_ROOT` to the
running host's `dist/control-ui` directory as well as `KNOWLEDGE_DESIGN_ROOT`.
The browser suite loads the host's built stylesheet before the plugin stylesheet,
uses the prototype's equivalent 1,182px content viewport (1,440px minus its
258px sidebar), checks key layout measurements and icons, and captures desktop,
760px, and 390px views. Assertions continue to prohibit browser knowledge writes.
