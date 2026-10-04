# Knowledge

This branch adds optional selection as the host memory provider on the unreleased
provider-neutral OpenClaw branch. Native tools and the read-only UI remain intact.
See [Memory provider integration](docs/MEMORY_PROVIDER.md) for activation, authority,
capabilities, and limitations. Building does not switch the live memory slot.

Evidence-backed knowledge vault and native explorer for OpenClaw.

**Current milestone:** agent-driven knowledge changes with exact-target correction/withdrawal and a read-only, entity-centered Control UI. Tools publish journaled pages, sourced claims/relationships and entity metadata; the UI inspects them and hands change requests to chat. Writes require `vault.writesEnabled: true`; sample mode remains read-only. Owner-direct turns can access the configured agent’s private records; shared turns are restricted to their own conversation partition.

| Capability | Status |
|---|---|
| Scoped record listing, evidence inspection and ontology validation | Implemented |
| Model-facing inspection | Concise defaults, targeted views, opt-in metadata/raw sources and pagination; see [API guide](docs/MODEL_API.md) |
| Create/edit pages and retain supplied text evidence | Implemented, configuration/authority gated; saved pages are immediately available, with no approval step |
| Revision/hash preconditions, identical retries, receipts/history | Implemented |
| Local Git history | Automatic in writable vaults when Git is installed; one commit per publication or observed external-change batch; visible retryable gaps |
| Accepted-write interruption recovery and conflict retention | Implemented and exercised in isolated fault-injection/process tests; not a complete backup/restore protocol |
| Read-only Control UI | Recent/Browse, entity-linked claims and evidence, typed connections, file/history inspection, and copy-request/open-chat handoff; no direct Knowledge write controls |
| Keyword retrieval and exact identity | Scoped SQLite FTS5, filters, bounded citations and native Search; [retrieval guide](docs/RETRIEVAL.md) |
| Embeddings | Not implemented or required |
| Document/meeting ingestion | Gbrain-aligned agent workflows over page, evidence, claim and relationship tools; [workflow guide](docs/WORKFLOWS.md) |
| Structured claims, relationships and entity metadata | Implemented through agent tools, with evidence, temporal validation and retry recovery; inspected in native UI |
| Correction/withdrawal | Agent-only exact-target operations, recoverable two-record correction, durable lifecycle safeguards and dependency impact; [contract](docs/CORRECTIONS.md) |
| Ingestion continuation | Agent work log plus existing records and receipts; enumerable sources can retain discoverable coverage snapshots and manifests without a separate ingestion service |
| Live refresh | Private-vault filesystem invalidations, authorized snapshot refresh, reconnect and 30-second visible-page fallback; retired services are fenced |
| Full backup/restore | Not implemented |

See [setup and authority](docs/REAL_VAULT.md), [model-facing API](docs/MODEL_API.md), [ontology](docs/ONTOLOGY.md), and [record format](docs/FORMAT.md). Verification reports distinguish local checks from live activation; a build alone does not update the running backend.

## Bundled skills

`knowledge-recall`, `knowledge-capture`, `knowledge-ingest`,
`knowledge-meeting-ingest`, `knowledge-entities`, `knowledge-correct`,
`knowledge-source-ingest`, and `knowledge-automation` ship with the plugin. They
retain sources, resolve identities conservatively, and verify published pages, claims, relationships and entity propagation.
`knowledge-automation` creates and verifies ingestion jobs through OpenClaw's host scheduler.
They are agent workflows, not an autonomous ingestion engine; host extraction
and structured claim/relationship mutation have explicit limits. Source ingestion adds optional canonical source/snapshot provenance plus local diff scripts; it is not a connector daemon or scheduler. See the
[upstream operation map and verification boundaries](docs/WORKFLOWS.md).

## Local file history

With writes enabled, Knowledge uses Git automatically when the executable is available. It initializes a repository **inside the vault** if needed and commits each published change together with its retained evidence. Existing scoped Markdown and ontology files get a baseline on first scan; later external edits, renames and deletions get one checkpoint per observed batch. No Git opt-in, GitHub account, remote, or additional service is required.

Reads and writes go through one stateful storage service that owns the SQLite journal, file publication and Git checkpoint queue. Git is downstream of publication: a failed checkpoint does not undo a saved page. Receipts and file details show `committed`, `pending`, or `unavailable`; normal scans retry queued work, and the agent can use `knowledge_resume` to retry a publication explicitly. If Git is installed later, queued versions are committed in order.

Git commits use exact retained bytes, preserve unrelated changes and staged content, and do not run hooks or filters. SQLite, recovery staging and `vault.json` are not automatically tracked. Sample/read-only mode does not create or modify repositories. GitHub, remotes and synchronization remain out of scope. [Details and boundaries](docs/LOCAL_HISTORY.md).

## Design

- [V1 scope](docs/KNOWLEDGE_SCOPE.md)
- [Design contracts](docs/KNOWLEDGE_SPEC.md)
- [UI redesign: implemented features and interim limits](docs/UI_REDESIGN_IMPLEMENTATION.md)
- [UI support contracts and remaining backend/host work](docs/UI_REDESIGN_SUPPORT.md)
- Use [gbrain](https://github.com/garrytan/gbrain) as the default for unresolved knowledge-model decisions, with explicit reasons for departures.
- Reuse OpenClaw's feature-plugin scaffold, typed operations, and native UI lifecycle. Knowledge owns the selected memory slot; it does not add a separate frontend service or take the context-engine slot.

## Develop

Requires Node 24 and OpenClaw 2026.9.5. The SDK is experimental; use the checkout belonging to the running gateway, not just a matching version label. An older checkout can refuse a newer host state database; do not downgrade or alter that database to build this plugin. See [verification](docs/VERIFICATION.md).

```sh
npm install
npm run check
npm test
npm run build
npm run validate
```

For development against an existing built host checkout, start with a fresh dependency directory and use its SDK/CLI without changing the committed dependency declaration:

```sh
npm install --ignore-scripts --no-save --package-lock=false /path/to/openclaw
npm run check
npm test
npm run build
npm run validate
```

Use the CLI belonging to the actual running gateway. Inspect existing configuration before installation; preserve other plugins. Enable **Settings → Labs → Custom plugin UI** if needed (no gateway restart required).

```sh
openclaw plugins install --link --force --accept-capabilities /path/to/knowledge
```

These flags acknowledge the local source and the reviewed plugin's capabilities. The checkout stays linked, so rebuilds update the installation. Open **Knowledge** in the sidebar. The shared tools are available after a tool-catalog refresh: `knowledge_status`, `knowledge_records`, `knowledge_record`, `knowledge_ontology`, `knowledge_diagnostics`, `knowledge_save_page`, `knowledge_history`, `knowledge_revision`, `knowledge_mutation`, `knowledge_resume`, `knowledge_grep`, `knowledge_lookup`, `knowledge_create_claim`, `knowledge_create_relationship`, `knowledge_connections`, `knowledge_correct`, and `knowledge_withdraw`. These expose only the caller’s authorized scope, or labeled sample data when no real vault is configured.

## Live reload

Backend changes:

```sh
npm run build
openclaw plugins reload knowledge --json
```

UI-only changes:

```sh
npm run build
openclaw gateway call plugins.controlUi.reload --params '{"pluginId":"knowledge"}' --json
```

The UI reload is also available through **Plugins → Customize UI → Reload plugin UI**. Neither command requires restarting the gateway. A backend replacement may wait for active work to drain. If an installation reports that it was saved but superseded during configuration application, run `openclaw plugins reload knowledge` and verify its receipt.

Verify the live service and browser activation:

```sh
openclaw gateway call plugins.sessionAction --params '{"pluginId":"knowledge","actionId":"status","payload":{}}' --json
openclaw gateway call plugins.controlUi.status --params '{"pluginId":"knowledge"}' --json
```

The page identifies sample versus real-vault mode and remains a read-only inspector even when agent writes are enabled. Browser activation receipts alone do not prove that the status operation works—exercise the service too.

## Boundary

Real-vault operations enforce the [authority and identity contract](docs/REAL_VAULT.md). A published receipt means files were published, not keyword-indexed (`indexed: false`). Exact reads and history support read-after-write. Precondition rejection does not save a server draft; accepted publication conflicts retain recovery material and block unsafe publication. No automatic conflict merge is provided.

Page disposal cancels pending UI updates and releases subscriptions; reconnect requests fresh state. The redesigned UI does not mount or restore legacy editing drafts; existing browser draft storage is left untouched. Chat handoffs preserve the exact observed ID/revision/hash and do not send automatically. The upgraded ingestion skills still require real-content agent acceptance; full backup/restore and the remaining v1 workflows are not claimed complete. Preserve the operational database and evidence alongside the vault; a Markdown-only copy is not a complete application backup.

### Source file attachments

Pages can attach original source files, with no evidence-specific character or reference-count cap. Upload/download is chunked; previews and evidence lists are bounded/paginated without truncating originals. Existing text evidence remains readable. See [evidence storage and gbrain comparison](docs/EVIDENCE.md).
