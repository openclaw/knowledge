# Knowledge

Evidence-backed knowledge vault and native explorer for OpenClaw.

**Current milestone:** a read-only explorer over a bundled, fictional Markdown vault. Records, Schemas, and Activity & issues are live. Inspect structured fields, original files, directed relationships, and hash-checked evidence. Invalid files remain intact and visible in diagnostics. No private agent vault is connected; writes are disabled.

See [the fixture format and design decisions](docs/FORMAT.md).

## Design

- [V1 scope](docs/KNOWLEDGE_SCOPE.md)
- [Design contracts](docs/KNOWLEDGE_SPEC.md)
- Use [gbrain](https://github.com/garrytan/gbrain) as the default for unresolved knowledge-model decisions, with explicit reasons for departures.
- Reuse OpenClaw's feature-plugin scaffold, typed operations, and native UI lifecycle. No separate frontend service or memory/context-engine slot.

## Develop

Requires Node 24 and OpenClaw 2026.9.5. The SDK is experimental; the first live verification uses host source commit `8a26ae487b5fb9b72ea2c12bf384e9c776659429`.

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

These flags acknowledge the local source and the reviewed plugin's capabilities. The checkout stays linked, so rebuilds update the installation. Open **Knowledge** in the sidebar. The shared queries are available to agents as `knowledge_status`, `knowledge_records`, `knowledge_record`, `knowledge_schemas`, and `knowledge_diagnostics` after their tool catalog refreshes. These explicitly expose sample data only.

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

Expand **Development status** on the page to see the UI revision, backend revision, backend instance, and last query time. **Refresh vault** rereads the sample files and refreshes the current view. Browser activation receipts alone do not prove that the status operation works—exercise the page too.

## Boundary

Only the bundled synthetic fixture is exposed. There is no caller-controlled path or private-vault configuration. Real-vault activation must implement the scope/spec access contracts before exposing data. Page disposal cancels pending UI updates and releases subscriptions; reconnect requests fresh state. This slice does not exercise durable-write recovery, because writes do not yet exist.
