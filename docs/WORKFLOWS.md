# Bundled workflows

Knowledge ships six automatically discoverable, repository-owned skills through
`openclaw.plugin.json` (`skills: ["./skills"]`) and the package file allow-list.
They are semantic ports, not a gbrain runtime dependency or a Workshop install.

| Skill | Route |
|---|---|
| `knowledge-recall` | Answer from saved Knowledge with inspectable citations; read-only |
| `knowledge-capture` | Save a short thought/snippet with exact source text |
| `knowledge-ingest` | Documents/articles, source retention and relevant entity updates |
| `knowledge-meeting-ingest` | Transcripts/notes, speaker uncertainty, decisions, chronology |
| `knowledge-entities` | Resolve identities; scoped, sourced profile creation/updates |
| `knowledge-correct` | Exact-target correction/withdrawal, retained evidence and impact inspection |

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
| remember / timeline-add / add_link | `knowledge_create_claim` (dated event claims for timeline material), `knowledge_create_relationship`, `knowledge_connections`; no separate timeline store or automatic backlinks |
| sync / embed | No sync command: saves publish; keyword search reconciles its own index |
| bulk job checkpoints | Itemized agent work log + individual upload/publication receipts; no atomic/resumable multi-record job |
| aliases/tags/dependencies | Supported collection replacement through `knowledge_save_page`; omitted fields preserve existing values |
| claim correction/withdrawal | `knowledge_correct` atomically replaces and supersedes a claim/edge; `knowledge_withdraw` retracts an exact record; page prose uses revision-fenced `knowledge_save_page` |
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
separately with the installed plugin catalog. Structured writes are now available;
full workflow upgrades and real-content agent trials follow durable ingestion
checkpoints. Bundling skills alone does not complete v1.

## Correction workflow port

The correction-pipeline skill at the same pinned gbrain commit was read in full.
Knowledge keeps target identification, evidence attribution, owning-record repair,
propagation inspection and a concrete outcome report. Deliberate departures:
Knowledge's existing file/SQLite journal replaces separate forget/remember calls
with one two-record correction; page prose remains revision-based. No automatic
MEMORY/SOUL/USER edits, fabricated guard facts, semantic search, or promise to
repair every prose copy is imported. Structured chat references are accepted as
primary targets when the host supplies them; this does not implement host draft
composition. See [CORRECTIONS.md](CORRECTIONS.md).
