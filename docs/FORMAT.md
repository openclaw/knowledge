# Read-only fixture format — v1

This document describes **sample mode**. Configured real-vault layout and scope enforcement are documented in [REAL_VAULT.md](REAL_VAULT.md); the portable record fields below are shared.

This milestone reads only `fixtures/sample-vault`. It is synthetic development data, exposed to authenticated Control UI (`operator.read`) and the agent tools through identical typed operations. **It is not a private knowledge store.** No configurable path, agent selector, ingestion, mutation, or background capture is enabled. Never place private information in this fixture directory. Real-vault mode uses separate trusted host agent/conversation authority and access tests; `scope.visibility: sample` is deliberately not a production access model.

## Portable records

One UTF-8 Markdown file per page, claim, or relationship. The file begins with a closed `---` YAML 1.2 frontmatter block. Every record has:

- `format: knowledge-record-v1`, opaque `id`, positive integer `revision`.
- `kind: page | claim | relationship`, `title`, `recorded_at`, `updated_at` (UTC ISO timestamps).
- Explicit `scope: { visibility: sample }` for these synthetic fixtures only.
- `lifecycle: active | superseded | withdrawn`. Saved records have no candidate/accepted state or approval workflow. Legacy `acceptance` frontmatter is ignored for discovery and removed on the next journaled page save.
- Optional `aliases`, `tags`, and stable-ID `dependencies`.

A page has a declared domain `type` and ontology-defined `fields`. If the type is absent, ordered ontology path prefixes provide a read-time classification without rewriting metadata. Entity types are pages, not duplicate entity records. A project encompasses initiatives and workstreams; optional `fields.status` is active/paused/completed/cancelled, independent of record lifecycle.

A claim has `claim_kind` (fact/preference/decision/commitment/event/belief), `assertion_origin` (source/user_belief/agent_inference), `attribution`, evidence, and claim text in the Markdown body. Optional `entities` references page IDs. A relationship has `from`, `to`, a declared `label`, attribution, and evidence. Endpoints must be pages of permitted types.

Unknown frontmatter survives inspection. It is not discarded, normalized, or written back. Full original text and an observed SHA-256 are returned. Identity comes from the explicit ID, never from filename/title/alias; duplicate IDs remain listed but exact lookup returns no record. Invalid envelope/YAML files remain on disk and appear in diagnostics, not the typed catalog. Typed records whose ontology or references are invalid remain inspectable and marked invalid. Listing includes all lifecycle states: this is exhaustive inspection, not active-knowledge retrieval.

## Evidence

Fixtures retain original text under `artifacts/`. Each reference includes `path` and `sha256`. Whole-file attachments add filename, media type, byte size and attribution. Text citations may additionally include inclusive one-based `start_line`/`end_line` and an optional exact `quote`. There is no evidence-reference count cap. A hash mismatch, absent file, unsafe path, or invalid range/quote produces a diagnostic. Detail shows only hash-matching source excerpts (up to 4,000 characters). Sample mode remains read-only. Real-vault attachment upload/download and retention are documented in [EVIDENCE.md](EVIDENCE.md).

## Declarative ontology

The shipped `ontologies/knowledge-default.yaml` is the named/versioned default. A vault's optional `ontology.yaml` supplies a local extension; other local manifests live under `ontologies/`. A shared resolver validates and composes whole definitions, with explicit aliases, primitives, behaviors, typed fields, endpoint constraints, and filing rules. It fingerprints the effective result, including inherited definitions.

See [ONTOLOGY.md](ONTOLOGY.md) for syntax, precedence, taxonomy review, deliberate gbrain departures, and failure behavior. Independent `schemas/*.yaml` from the earlier prototype are no longer activated and produce an explicit diagnostic. No files are automatically migrated.

The visible sample uses the shipped default unchanged. Invalid records and legacy schema examples live under `test/fixtures`, not the product sample. Sample mode remains read-only and fixture-only. Real-vault reads are a separate configuration; neither mode has a journaled publisher, watcher, or last-known-good activation cache.

## Operations and limits

`status`, `records`, `record`, `ontology`, `diagnostics` are shared UI/agent queries. Record lists paginate (default 50, max 100) and filter by kind, type/ontology-alias, and ID/title/record-alias substring. They are not ranked search. Connected records are explicit dependencies/entity/relationship references; Markdown links remain portable text and derived wikilink/backlink extraction is deferred.

Every query rereads authoritative files; reopening a view and reconnect recover current data. No watcher or durable activity history is implied. Catalog limits: 64 KiB per record/ontology file, 500 filesystem entries, eight directory levels, 8 MiB scan-read budget, 20 metadata levels, no symlinks, YAML alias expansion, non-finite values, or duplicate YAML keys. An incomplete catalog fails closed. Diagnostics return at most 1,000 findings and report truncation. These are catalog-explorer bounds, not source-file size/count limits. Original attachments are hash-verified using streaming reads outside the catalog scan-byte budget.

## Verification

`npm test` covers byte-preserving reads, representative evidence, exhaustive pagination, ontology composition/rejection/duplicate activation, stable identity across renames, unknown metadata, duplicate IDs, changed evidence, unsafe paths, and malformed inputs. `npm run check`, `npm run build`, and `npm run validate` cover the host contract/build. Browser checks exercise record selection, evidence, raw metadata, ontology, diagnostics, filtering, refresh, and page remounting after reload.
