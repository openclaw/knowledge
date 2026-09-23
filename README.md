# Knowledge

Evidence-backed knowledge vault and native explorer for OpenClaw.

**Current milestone:** authorized real-vault browsing and journaled pages, sourced claims/relationships and entity metadata edits, shared by Control UI and agent tools. Writes require `vault.writesEnabled: true`; sample mode remains read-only. Owner-direct turns can access the configured agent’s private records; shared turns are restricted to their own conversation partition.

| Capability | Status |
|---|---|
| Scoped record listing, evidence inspection and ontology validation | Implemented |
| Model-facing inspection | Concise defaults, targeted views, opt-in metadata/raw sources and pagination; see [API guide](docs/MODEL_API.md) |
| Create/edit pages and retain supplied text evidence | Implemented, configuration/authority gated; saved pages are immediately available, with no approval step |
| Revision/hash preconditions, identical retries, receipts/history | Implemented |
| Local Git history | Automatic in writable vaults when Git is installed; one commit per publication or observed external-change batch; visible retryable gaps |
| Accepted-write interruption recovery and conflict retention | Implemented and exercised in isolated fault-injection/process tests; not a complete backup/restore protocol |
| Browser drafts | One tab-local draft per authorized agent/vault/scope; survives navigation, page reload and plugin UI remount, retaining original edit preconditions and uncertain-save request |
| Keyword retrieval and exact identity | Scoped SQLite FTS5, filters, bounded citations and native Search; [retrieval guide](docs/RETRIEVAL.md) |
| Embeddings | Not implemented or required |
| Document/meeting ingestion | Five bundled agent workflow skills over supported page/file tools; [workflow guide](docs/WORKFLOWS.md) |
| Structured claims, relationships and entity metadata | Implemented through tools and native UI, with evidence, temporal validation and retry recovery |
| Correction/withdrawal and durable ingestion checkpoints | Not implemented |
| Live refresh | Private-vault filesystem invalidations, authorized snapshot refresh, reconnect and 30-second visible-page fallback; retired services are fenced |
| Full backup/restore | Not implemented |

See [setup and authority](docs/REAL_VAULT.md), [model-facing API](docs/MODEL_API.md), [ontology](docs/ONTOLOGY.md), and [record format](docs/FORMAT.md). Verification reports distinguish local checks from live activation; a build alone does not update the running backend.

## Bundled skills

`knowledge-recall`, `knowledge-capture`, `knowledge-ingest`,
`knowledge-meeting-ingest`, and `knowledge-entities` ship with the plugin. They
retain sources, resolve identities conservatively, and verify published pages.
They are agent workflows, not an autonomous ingestion engine; host extraction
and structured claim/relationship mutation have explicit limits. See the
[upstream operation map and verification boundaries](docs/WORKFLOWS.md).

## Local file history

With writes enabled, Knowledge uses Git automatically when the executable is available. It initializes a repository **inside the vault** if needed and commits each published change together with its retained evidence. Existing scoped Markdown and ontology files get a baseline on first scan; later external edits, renames and deletions get one checkpoint per observed batch. No Git opt-in, GitHub account, remote, or additional service is required.

Reads and writes go through one stateful storage service that owns the SQLite journal, file publication and Git checkpoint queue. Git is downstream of publication: a failed checkpoint does not undo a saved page. Receipts and Activity & issues show `committed`, `pending`, or `unavailable`; normal scans retry queued work, and **Retry Git history** / `knowledge_resume` retries a publication explicitly. If Git is installed later, queued versions are committed in order.

Git commits use exact retained bytes, preserve unrelated changes and staged content, and do not run hooks or filters. SQLite, recovery staging and `vault.json` are not automatically tracked. Sample/read-only mode does not create or modify repositories. GitHub, remotes and synchronization remain out of scope. [Details and boundaries](docs/LOCAL_HISTORY.md).

## Design

- [V1 scope](docs/KNOWLEDGE_SCOPE.md)
- [Design contracts](docs/KNOWLEDGE_SPEC.md)
- Use [gbrain](https://github.com/garrytan/gbrain) as the default for unresolved knowledge-model decisions, with explicit reasons for departures.
- Reuse OpenClaw's feature-plugin scaffold, typed operations, and native UI lifecycle. No separate frontend service or memory/context-engine slot.

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

These flags acknowledge the local source and the reviewed plugin's capabilities. The checkout stays linked, so rebuilds update the installation. Open **Knowledge** in the sidebar. The shared tools are available after a tool-catalog refresh: `knowledge_status`, `knowledge_records`, `knowledge_record`, `knowledge_ontology`, `knowledge_diagnostics`, `knowledge_save_page`, `knowledge_history`, `knowledge_revision`, `knowledge_mutation`, and `knowledge_resume`, `knowledge_grep`, and `knowledge_lookup`. These expose only the caller’s authorized scope, or labeled sample data when no real vault is configured.

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

The page identifies sample versus real-vault mode and exposes the editor when writes are enabled for the caller. Browser activation receipts alone do not prove that the status operation works—exercise the service too.

## Boundary

Real-vault operations enforce the [authority and identity contract](docs/REAL_VAULT.md). A published receipt means files were published, not keyword-indexed (`indexed: false`). Exact reads and history support read-after-write. Precondition rejection does not save a server draft; accepted publication conflicts retain recovery material and block unsafe publication. No automatic conflict merge is provided.

Page disposal cancels pending UI updates and releases subscriptions; reconnect requests fresh state. Draft recovery uses sessionStorage and does not promise recovery after closing the tab, clearing browser data or browser failure. A draft is not published knowledge. The bundled page-ingestion workflows do not complete the structured v1 ingestion contract; full backup/restore and the remaining v1 workflows are not claimed complete. Preserve the operational database and evidence alongside the vault; a Markdown-only copy is not a complete application backup.

### Source file attachments

Pages can attach original source files, with no evidence-specific character or reference-count cap. Upload/download is chunked; previews and evidence lists are bounded/paginated without truncating originals. Existing text evidence remains readable. See [evidence storage and gbrain comparison](docs/EVIDENCE.md).
