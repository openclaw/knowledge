# Knowledge

Evidence-backed knowledge vault and native explorer for OpenClaw.

**Current milestone:** real-vault identity and authorized read access, with writes disabled. Configure one agent vault to browse private records through Control UI and trusted owner-direct agent turns; shared turns are restricted to their own conversation partition. With no vault configuration, the fictional sample remains available. Records, Ontology, and Activity & issues use the same typed service.

See [real-vault setup, authority, and limitations](docs/REAL_VAULT.md), [the ontology contract](docs/ONTOLOGY.md), and [the fixture format](docs/FORMAT.md).

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

These flags acknowledge the local source and the reviewed plugin's capabilities. The checkout stays linked, so rebuilds update the installation. Open **Knowledge** in the sidebar. The shared queries are available to agents as `knowledge_status`, `knowledge_records`, `knowledge_record`, `knowledge_ontology`, and `knowledge_diagnostics` after their tool catalog refreshes. These expose only the caller’s authorized scope, or labeled sample data when no real vault is configured.

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

The page identifies sample versus private-vault mode and remains read-only. Browser activation receipts alone do not prove that the status operation works—exercise the service too.

## Boundary

Real-vault reads enforce the [documented authority and identity contract](docs/REAL_VAULT.md). Writes, durable revisions/conflicts, publication recovery, and ingestion remain disabled/unimplemented. Page disposal cancels pending UI updates and releases subscriptions; reconnect requests fresh state. This foundation does not claim writable-vault recovery or a complete backup/restore protocol.
