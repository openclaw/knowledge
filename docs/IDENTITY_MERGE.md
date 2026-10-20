# Identity merge

Status: design for kn-498. Implemented by `knowledge_merge` and `knowledge_unmerge`.

## Problem

Ingestion creates identity fragments as a matter of course. A meeting creates
"Jacob (Windows-node standup participant)"; Discord later creates "Jacob
Tomlinson". Once someone establishes that the two pages are one person,
Knowledge has no way to say so. The Discord pilot settled five such identities
by hand: a one-line pointer page per fragment, plus a `knowledge_correct` for
every claim whose `owner` or `entities` named a fragment (14 corrections, each
leaving a superseded original). Pointer pages still appear in search, and any
claim written later against a fragment ID has to be found and corrected again.

## Decision

A merge is a redirect resolved at read time. The absorbed page stays on disk
with a new lifecycle, `merged`, and a `merged_into` pointer. Records that name
the absorbed page are not rewritten; every read path treats such a reference
as a reference to the surviving page.

Rejected alternative: move or correct every dependent record (gbrain's phantom
redirect moves fact rows by ID). It creates a superseded revision per claim,
breaks provenance on what the source actually named, and still misses records
written later against the old ID. gbrain needed both a physical merge and a
retired-page redirect (`merged_into`, followed up to 5 hops) to cover those
cases; its redirect alone leaves facts on the retired page. Redirect-on-read
covers both without touching assertions. See kn-498 for the prior-art notes.

## Identity keys

People and other entities are matched across sources by namespaced aliases:
`discord:<user id>`, `github:<login>`, `email:<address>`, `slack:<user id>`.
They are ordinary aliases, so exact lookup already resolves them. Skills write
them on entity pages when a source provides a stable account identifier. Two
active pages of the same type sharing a namespaced alias are a duplicate by
construction. Display names and handles are not identity keys.

## Record format

The absorbed page, after a merge (only these keys change; body and other
metadata are preserved):

```yaml
lifecycle: merged
merged_into: <survivor id>
lifecycle_change: { reason, at, actor, request_id }
```

The surviving page gets a new revision:

- `aliases`: its own, plus the absorbed page's title and aliases. When the merge
  renames the survivor, its previous title becomes an alias too.
- `tags`: union. `evidence`: union. `fields`: the survivor's values win; keys
  only the absorbed page has are copied, and conflicting values are reported in
  the receipt.
- `title` and `body`: unchanged unless the merge request supplies them. Prose is
  never merged automatically; the agent writes the combined body when it wants
  one. The absorbed page's body stays readable by exact ID.
- `merged_from`: one entry per absorbed page recording exactly what the merge
  added, so an unmerge can remove it:

```yaml
merged_from:
  - id: <absorbed id>
    request_id: <merge request>
    at: <timestamp>
    added: { aliases: [...], tags: [...], fields: [...], evidence: [{ path, sha256 }] }
```

## Validation

Scan-time checks on every `merged` page; a failure marks the merged page invalid
and its redirect is not followed, so records naming it are hidden (fail closed)
and diagnostics explain why:

- `merged_into` is required for `lifecycle: merged` and forbidden otherwise.
- The target exists uniquely, is a page, and has the same type.
- Chains (A merged into B, later B merged into C) resolve to the final active
  page within 8 hops. A cycle, a dead end, or a chain longer than 8 is invalid.
- The final page must be `active`. If it is later withdrawn, records redirected
  to it are hidden like any dependent of a withdrawn page.

## Reads

One redirect map is built per scan from valid merged pages
(`src/merge.ts`). All reads use it through `eligible()`:

- **Eligibility.** A reference to a merged page counts as a reference to its
  survivor. Merged pages themselves are not current records: they leave search,
  lookup by title, Records listings and the keyword index, like superseded
  records. `lifecycle: all` still lists them.
- **Effective references.** Current records returned by `eligible()` carry their
  references (`owner`, `entities`, `from`, `to`, `dependencies`, `source_page`)
  resolved to survivors, plus a `redirected` map of old → new IDs. Connections,
  claim cards, Timeline, Chronicle, last-seen and session activity therefore
  attribute redirected claims to the survivor without per-feature code. Exact
  `knowledge_record` reads still show authored metadata, plus a `redirects`
  note naming each resolved reference.
- **Exact lookup.** `knowledge_lookup` by a merged page's ID returns the survivor
  and reports `redirectedFrom`. Its title and aliases already live on the
  survivor.
- **Exact record.** `knowledge_record` of a merged ID returns the merged page
  itself (it is history, like a superseded record) with `mergedInto` naming the
  survivor. A survivor's record lists `mergedFrom`.
- **Links.** `[[old-id]]`, `[[Old Title]]` and path links to a merged page
  resolve to the survivor; they are not broken-link diagnostics.

## Writes

`knowledge_merge` (agent-only, journaled like `knowledge_correct`):

```text
requestId, expectedVaultId?, reason,
survivor:  { id, expectedRevision, expectedHash },
absorbed:  { id, expectedRevision, expectedHash },
title?, body?, evidence?
```

- Both pages active, valid, distinct pages of the same type; both fences match.
- `evidence` (optional) is retained identity evidence, for example the user's
  statement or a self-introduction, appended to the survivor's evidence.
- One publication changes both files and returns one receipt: primary
  `id/revision/hash` is the survivor's new revision, `operation: "merge"`,
  `targetId` is the absorbed page, and `merge` reports the aliases added, field
  conflicts and how many current records now resolve to the survivor.
- New writes that reference a merged page are rejected with a message naming
  the survivor, so a stale ID never silently creates a new fragment.

`knowledge_unmerge` (agent-only): `requestId, reason, id, expectedRevision,
expectedHash` of the merged page, plus the survivor's current fences. It
restores the merged page to `active`, removes `merged_into`, and gives the
survivor a new revision without that page's `merged_from` entry and without the
aliases, tags, fields and evidence the merge added (values the survivor has
since edited are left alone). A body written during the merge is not reverted.

Merged pages carry no stale-restore guard: unmerge is a legitimate way back to
`active`, and the publication journal is the authority for both directions.

## Finding duplicates

`knowledge_diagnostics` adds `mergeCandidates`: groups of active pages of the
same type that share a normalized namespaced alias (strong) or an exact
normalized title (weak). It reports candidates and never merges.
`knowledge_lookup` already reports `ambiguous` when one key resolves to several
pages; skills treat that as a candidate to report, not a page to pick.

## UI

- A merged page shows a banner, "Merged into <survivor>", linking to it.
- A survivor shows "Merged from" with links to each absorbed page.
- Lifecycle badges and the historical filter include `merged`.

## Skills

- `knowledge-entities`: resolve identities through namespaced aliases before
  creating a page; on a confirmed duplicate, merge instead of correcting claims
  one by one or writing pointer pages.
- `knowledge-correct`: merge and unmerge replace the "keep separate pages
  explicitly linked" guidance.

## Out of scope

Automatic merging, rewriting prose links in other pages, merging claims or
relationships, and merging across page types.
