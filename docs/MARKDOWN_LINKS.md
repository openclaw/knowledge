# Readable source links and filenames

## Knowledge page addresses

The native Knowledge page persists navigation through the public Control UI
`navigation.openPage` contract. The host encodes page parameters as `p.*` query
parameters and delivers them through page `context.props` and `update`.

- `p.agent` selects an authorized operator viewing context; `p.vault` pins the
  observed store identity. It is not an access grant or an arbitrary vault path.
  If that agent now uses a different store, the page explains the mismatch and
  does not open a record there. An explicit “Open current store” action starts a
  new view. Unknown agents do not fall back to the default agent.
- `p.record` is the stable record ID, not its title or filesystem path. Renames
  therefore do not change the page address.
- `p.view`, `p.section`, `p.kind`, `p.type`, `p.q`, `p.filter`, `p.history`,
  `p.origin`, and `p.offset` retain the selected view, submitted search, browse
  filters, settings section, and pagination. `p.upper`/`p.before` retain a recent
  activity cursor. `p.back` retains validated prior Browse offsets so Previous
  survives host remounts, reloads, and variable-size pages. Links without that
  trail offer First. Defaults are omitted; invalid bounds reset to safe defaults.
- Navigation creates history entries; initial store resolution canonicalizes
  the current entry. Refresh and browser back/forward restore the addressed
  view. Restoring an older activity page offers “Latest activity” when its
  in-memory newer-page stack is unavailable.
- Expansion toggles, scroll position, unsent chat handoffs, and source passage
  locators are not part of this URL contract yet. No chat citation renderer or
  sidebar click routing is installed by this change.

Use the host's `pageHref({id: "overview", params})` API when generating links
from browser code so the configured Control UI base path is preserved. Do not
hardcode the Gateway origin or put credentials in a page address.

- Records keep immutable IDs in frontmatter; creation uses a title-based slug in
  the ontology's directory (`people/josh-lehman.md`). Collisions receive a short
  ID suffix. Saves retain the current path; external renames preserve identity.
  After a rename, reread the record API before editing: observation can advance
  its operational revision even though the Markdown bytes are unchanged.
- `[[path/to/page|Label]]`, `[[Title]]`, `[[Alias]]`, and relative Markdown `.md`
  links resolve against the authorized current catalog. Paths may omit `.md` in
  wikilinks. Old UUID paths still resolve by frontmatter ID after a rename.
  Descriptive path links must be updated during a rename; no fuzzy matching.
- Ambiguous names and missing targets remain unlinked and diagnosed; they do not
  invalidate the containing page. Code, image destinations, raw HTML and generated
  `<!-- backlinks:start --> … <!-- backlinks:end -->` sections do not add edges.
- The same Marked parser drives rendering and extraction. `record` returns bounded
  `links` plus `linksTruncated`; `connections` accepts `links` and `backlinks` as
  directions, separate from `incoming`/`outgoing` evidenced relationships. One
  neighbor appears once per direction even when several passages reference it.
- References/Referenced by are recomputed from the scoped scan (currently bounded
  to 500 filesystem entries), not persisted as another authority. This departs
  from the planned SQLite backlink projection to avoid an unnecessary second
  freshness path at the current vault size. A cached projection remains an
  optimization, not a different link or access contract.
- Source citations belong inline as readable wikilinks with retained line
  locators in the label. Artifact hashes and ranges remain in structured evidence.
  Originals are available under File details → Retained originals. A self-link on
  a source page opens that disclosure. Links open pages, not arbitrary files;
  source-line fragments are preserved in Markdown but not a transcript-jump API.
  No redundant page-level Sources footer is generated.

Reference: gbrain `src/core/link-extraction.ts` (code-aware Markdown and wikilink
candidates) and `src/core/derived-links.ts` (derived link provenance separate from
explicit edges), inspected from the existing local checkout. We reuse the
installed Marked dependency, not gbrain's engine or pack-inferred relationship
labels. A document reference is navigation, not evidence of a typed relationship.
