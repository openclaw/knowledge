# Readable source links and filenames

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
