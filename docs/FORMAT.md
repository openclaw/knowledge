# Read-only fixture format — v1

This milestone reads only `fixtures/sample-vault`. It is synthetic development data, exposed to authenticated Control UI (`operator.read`) and the agent tools through identical typed operations. **It is not a private knowledge store.** No configurable path, agent selector, ingestion, mutation, or background capture is enabled. Never place private information in this fixture directory. Real-vault activation requires trusted host agent/conversation authority and access tests first; `scope.visibility: sample` is deliberately not a production access model.

## Portable records

One UTF-8 Markdown file per page, claim, or relationship. The file begins with a closed `---` YAML 1.2 frontmatter block. Every record has:

- `format: knowledge-record-v1`, opaque `id`, positive integer `revision`.
- `kind: page | claim | relationship`, `title`, `recorded_at`, `updated_at` (UTC ISO timestamps).
- Explicit `scope: { visibility: sample }` for these synthetic fixtures only.
- Independent `acceptance: candidate | accepted` and `lifecycle: active | superseded | withdrawn`.
- Optional `aliases`, `tags`, and stable-ID `dependencies`.

A page has a declared domain `type` and schema-defined `fields`. Entity types are pages, not duplicate entity records. A project encompasses initiatives and workstreams; `fields.status` is active/paused/completed/cancelled, independent of record lifecycle.

A claim has `claim_kind` (fact/preference/decision/commitment/event/belief), `assertion_origin` (source/user_belief/agent_inference), `attribution`, evidence, and claim text in the Markdown body. Optional `entities` references page IDs. A relationship has `from`, `to`, a declared `label`, attribution, and evidence. Endpoints must be pages of permitted types.

Unknown frontmatter survives inspection. It is not discarded, normalized, or written back. Full original text and an observed SHA-256 are returned. Identity comes from the explicit ID, never from filename/title/alias; duplicate IDs remain listed but exact lookup returns no record. Invalid envelope/YAML files remain on disk and appear in diagnostics, not the typed catalog. Typed records whose schema or references are invalid remain inspectable and marked invalid. Listing includes all acceptance/lifecycle states: this is exhaustive inspection, not active-knowledge retrieval.

## Evidence

Fixtures retain original text under `artifacts/`. Each locator includes `path`, `sha256`, inclusive one-based `start_line`/`end_line`, and optional exact `quote`. A hash mismatch, absent file, unsafe path, or invalid range/quote produces a diagnostic. Detail shows only hash-matching source excerpts (up to 4,000 characters). There is no writable artifact service or durable acquisition claim.

## Declarative schemas

Independent YAML files under `schemas/` use `format: knowledge-schema-v1`, semantic `version`, `name`, `label`, `description`, `kind`, primary `directory`, and ordered `fields`. Each field has a name, label, primitive type, required flag, and optional string enumeration. Relationship definitions declare `from_types` and `to_types`. Definitions contain no code, inheritance, migrations, or remote imports.

The reader validates definitions before use. Duplicate names activate neither definition. Relationship endpoint definitions must be available page types. Invalid edits are shown with their raw YAML and associated-record count; the affected type is unavailable. This stateless slice has no last-known-good cache and never silently falls back or reinterprets records.

## gbrain alignment and explicit departures

Reviewed upstream checkout: `garrytan/gbrain` at `d13aa742fd68b71bfd6c98be3dda5813791f1d6c`, particularly `docs/GBRAIN_RECOMMENDED_SCHEMA.md`, `docs/architecture/schema-packs.md`, and `src/core/schema-pack/base/gbrain-base-v2.yaml`.

- Adopt YAML metadata, typed pages, one primary filing home, resolver guidance, aliases, declarative types/fields, and typed relationship endpoints. See [upstream schema packs](https://github.com/garrytan/gbrain/blob/master/docs/architecture/schema-packs.md).
- Ship a small taxonomy: person, organization, project, meeting, concept, note; leads/supports demonstrate directed relations. Specialized types remain additions driven by evidence, not an attempt to reproduce all upstream packs.
- Use `organization` instead of gbrain's company umbrella because our scope covers non-company organizations; do not infer types from paths. Explicit type/ID survives renaming, while filing deviations are diagnosed.
- Markdown is authoritative, unlike gbrain's database-backed generated-page model. Claims and edges therefore need independent portable files and opaque stable IDs.
- Timelines will be derived from referenced events/meetings rather than copied append-only histories on every entity. No timeline engine ships in this slice.
- Read-only validation uses a fresh in-memory catalog, not a database or watcher. Journaled publication/revisions/receipts come before any writes. Last-known-good schema persistence is not needed to inspect the fixture and is deferred.

The existing host stack already uses `yaml`; this plugin declares the same version directly instead of importing host internals. No new runtime service or schema framework is introduced.

## Operations and limits

`status`, `records`, `record`, `schemas`, `diagnostics` are shared UI/agent queries. Record lists paginate (default 50, max 100) and filter by kind/type and ID/title/alias substring. They are not ranked search. Connected records are explicit dependencies/entity/relationship references; Markdown links remain portable text and derived wikilink/backlink extraction is deferred.

Every query rereads authoritative files; Refresh and reconnect recover current data. No watcher or durable activity history is implied. Limits: 64 KiB per file, 500 filesystem entries, eight directory levels, 8 MiB scan-read budget, 20 metadata levels, no symlinks, YAML alias expansion, non-finite values, or duplicate YAML keys. An incomplete catalog fails closed. Diagnostics return at most 1,000 findings and report truncation. These are sample-explorer bounds, not intended production-scale limits.

## Verification

`npm test` covers byte-preserving reads, representative evidence, exhaustive pagination, schema rejection/duplicate activation, stable identity across renames, unknown metadata, duplicate IDs, changed evidence, unsafe paths, and malformed inputs. `npm run check`, `npm run build`, and `npm run validate` cover the host contract/build. Browser checks exercise record selection, evidence, raw metadata, schemas, diagnostics, filtering, refresh, and page remounting after reload.
