# Bundled workflows

Knowledge ships five automatically discoverable, repository-owned skills through
`openclaw.plugin.json` (`skills: ["./skills"]`) and the package file allow-list.
They are semantic ports, not a gbrain runtime dependency or a Workshop install.

| Skill | Route |
|---|---|
| `knowledge-recall` | Answer from saved Knowledge with inspectable citations; read-only |
| `knowledge-capture` | Save a short thought/snippet with exact source text |
| `knowledge-ingest` | Documents/articles, source retention and relevant entity updates |
| `knowledge-meeting-ingest` | Transcripts/notes, speaker uncertainty, decisions, chronology |
| `knowledge-entities` | Resolve identities; scoped, sourced profile creation/updates |

Read the selected SKILL.md, then its linked references. Shared guidance is authored
once in `skills/shared/`; `npm run skills:sync` embeds copies inside each skill.
This is intentional: OpenClaw's per-skill bundle reader/materializer does not
include siblings or allow `../` reference traversal. Build and prepack synchronize
copies; tests reject drift. Cross-workflow routing uses discoverable skill names,
not filesystem links to sibling bundles. No global skill installation is needed.

## Upstream review and operation map

Read in full and byte-compared to gbrain commit
[`7cdc3e30a898665a8c87b0c06937f6366f759f6c`](https://github.com/garrytan/gbrain/tree/7cdc3e30a898665a8c87b0c06937f6366f759f6c):
`skills/{query,capture,ingest,meeting-ingestion,resolve-before-asking,enrich,brain-link-discipline}/SKILL.md`,
`skills/_brain-filing-rules.md`, and `skills/conventions/{quality,untrusted-content}.md`.
The upstream MIT attribution is retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
Existing Knowledge tools and host acquisition are sufficient for this page-based
slice; no new runtime, connector, extraction dependency or paid service is added.

| Upstream operation / practice | Knowledge port or explicit boundary |
|---|---|
| query/recall, search, get_page | `knowledge_lookup`, `knowledge_grep`, `knowledge_record`; agent synthesis over evidence, no semantic search |
| capture / put_page | `knowledge_save_page`; observed revision/hash for edits, exact request replay, readback |
| content-hash capture dedup | Agent checks source IDs/hashes/content and existing pages; backend dedup is only same request ID/payload |
| upload-raw / put_raw_data | `knowledge_attach`, file evidence on page, `knowledge_attachment`; local originals, no cloud routing |
| filing rules | Inspect `knowledge_ontology`; canonical type and server-generated UUID path; no assumed slug |
| raw transcript / attribution | Retained original + labeled derived transcript; exact locators, unresolved speaker map, source-vs-inference distinction |
| resolve/enrich | Exact lookup plus evidence-aware candidate comparison; selective supported entity page edits |
| timeline-add / add_link / graph | Dated prose and verified relative links only; no structured timeline/relationship writes or automatic backlinks |
| sync / embed | No sync command: saves publish; keyword search reconciles its own index |
| bulk job checkpoints | Itemized agent work log + individual upload/publication receipts; no atomic/resumable multi-record job |
| aliases/tags/frontmatter writes | Preserved existing metadata, but not exposed as save fields; no invented write API |
| claim correction/withdrawal | Not shipped as a skill: backend lifecycle/claim mutation still missing. Supported page edits can explicitly correct prose without deleting evidence |
| media extraction/OCR/transcription | Host capability if available; otherwise source retention and explicit partial result. Dedicated media skill deferred |
| curation/dreaming / automatic inbound enrichment | Deferred; no ambient capture, broad profile research or scheduling |
| push-before-link | Returned local path/ID or verified host link; no private-vault GitHub push to manufacture a URL |

Deliberate quality departures: a name/roster match does not establish speaker
identity; older synthesis does not outrank original evidence automatically;
uncertainty is allowed instead of fabricated profile completeness. Summary-only
meetings can be retained as attributed partial notes, not transcript-verified
ingestion. Chronology checks compare actual events and timestamps, not the order
of headings in a topic-organized summary. Unknown facts stay unknown. Source
instructions never authorize unrelated actions.

## Verification scope

`test/workflows.test.mjs` exercises the public feature adapter against isolated
temporary vaults: original documents/transcripts, source locators, entity
resolution, contradictory meeting evidence, explicit corrections, lost-response
replays, service replacement, readback and retrieval. It checks deterministic
backend support for representative authored outputs, **not** an LLM's ability to
choose the right skill or reason from a new source. No synthetic trial data is
written into the user's vault.

Package tests check skill metadata, local reference closure, tool references,
generated reference freshness and npm payload inclusion. Host discovery is checked
separately with the installed plugin catalog. User-provided real-content trials
and agent behavioral evaluation remain the next milestone; bundling these skills
does not complete the v1 structured claims/relationships acceptance criteria.
