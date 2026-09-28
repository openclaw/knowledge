# Real-vault access and publication

Read foundation implemented 2026-09-22; extended with journaled page writes.
This is not a completed v1 ingestion, search or full-backup/restore system.

## Storage and configuration

One configured agent vault is supported by this first adapter. Other agents fail
closed; there is no model-facing vault, agent, path, or scope selector. An empty
plugin configuration retains the explicitly labeled synthetic sample mode.
Invalid real-vault configuration never falls back to samples.

```text
<vault-root>/
  vault.json
  .git/                       # initialized automatically in writable mode when Git is available
  private/
    ontology.yaml             # optional extension of the shipped ontology
    ontologies/               # optional local manifests
    people/, projects/, …     # ordinary record files
    claims/, relationships/
    artifacts/                # retained evidence within this scope
  conversations/<sessionId>/
    …                         # same layout, independently scoped
```

Partition directories are an enforcement aid, not separate logical stores.
Select the partition **before** traversal, ontology resolution, validation,
counts, references, evidence reads, or diagnostics. There are no cross-partition
links or artifact reads. The shipped ontology is available in each partition;
private custom definitions are not implicitly published to conversations.

`vault.json` is a strict JSON object:

```json
{
  "format": "knowledge-vault-v1",
  "vaultId": "11111111-1111-4111-8111-111111111111",
  "agentId": "main",
  "generation": 0,
  "publicationId": "22222222-2222-4222-8222-222222222222"
}
```

Initialize with fresh UUIDs in a new, empty directory; create `private/` and use
owner-only filesystem permissions. Do not turn sample data into private knowledge
by relabeling it. Configure `plugins.entries.knowledge.config.vault` with:

```json
{
  "root": "/absolute/path/to/vault",
  "statePath": "/absolute/path/to/knowledge.sqlite",
  "agentId": "main",
  "vaultId": "11111111-1111-4111-8111-111111111111",
  "publicationId": "22222222-2222-4222-8222-222222222222",
  "operatorRead": true,
  "writesEnabled": false
}
```

The manifest's identity is also bound, atomically if absent, to `agent:<agentId>`
in the plugin-owned SQLite database selected by `statePath`, outside the editable
vault. This path stays unchanged when moving the vault. The database has an
application ID and version; an unrelated, corrupt, or linked file is rejected.
This is operational metadata, not a knowledge record write. A conflicting
checkpoint is never replaced automatically, even if configuration is changed.
Manifest identity, checkpoint, scope directory identity, and authority are checked
before and after a query. Scoped observations and history are persisted; no keyword index is implemented.
Moving the same vault is allowed after updating its configured root; a different
vault at the same path is not. Missing or mismatched identities require explicit
recovery/configuration review, not automatic adoption.

Fresh database adoption requires generation zero. Once bound, successful publication advances the manifest generation/publication ID and SQLite checkpoint together through the recoverable journal. Identity mismatches and older-vault/newer-database combinations fail closed. This does **not** establish a full-backup restore procedure; retain the operational database, vault and artifacts together.

Set `writesEnabled: true` only for the configured writable vault. Trusted agent writes use the same scope mapping as reads. Operator writes additionally require `operator.write`/admin authority; operator read access alone cannot save. Sample mode never writes. The shared save API supports pages and retained supplied text evidence, not a completed multi-record ingestion or claim/relationship editor.

Published receipts, retained revision snapshots, scoped mutation material, external-change observations and interrupted-publication resume are available. Exact reads re-read files and record external changes on the next query; no filesystem watcher is installed. Pending/conflicted accepted publication blocks ordinary reads rather than serving a partial catalog. Pre-acceptance rejections do not journal drafts. See [model API and draft boundaries](MODEL_API.md).

## Shared storage service and local Git

`KnowledgeStorage` is the per-configured-vault stateful boundary. UI/tool adapters authorize the caller and delegate; they do not open SQLite, invoke Git, or bypass publication for reads. The service owns guarded reads/observations, the database adapter, publication/recovery, and local Git checkpoints. SQLite connections remain short-lived across operations/plugin reloads; stateful ownership does not require leaking native handles.

Writable vaults use Git by default, without a separate enable flag. Scoped scans checkpoint existing Markdown/ontology and later observed changes. Publication checkpoints its exact page/artifact batch. A missing executable leaves reads/writes available and reports `unavailable`; repository problems report a retryable `pending` gap. Read-only/sample mode does not initialize or mutate Git. [Full local-history contract](LOCAL_HISTORY.md).

## Host authority mapping

| Caller | Required trusted evidence | Scope |
|---|---|---|
| Control UI/operator | Authenticated connection ID, host `operator.read` (or its write/admin implication), configured `operatorRead: true` | Configured agent's private partition |
| Agent, owner direct chat | Matching host agent, session key and UUID, latest stored session entry with `chatType: direct`, trusted `senderIsOwner: true`, live invocation guard | Agent-private partition |
| Agent, other known direct/group/channel chat | Same current agent/session verification and live guard; known chat type | Exact host session UUID's conversation partition |
| Spawned child of the configured agent | Current child invocation plus host-stamped parent key, UUID, lifecycle revision and parent sender-owner bit at every spawn hop; all ancestor sessions still current | Same partition as the originating parent: owner-direct private, otherwise the parent's conversation UUID |
| Missing/unknown/stale context, command adapter, foreign agent | Insufficient authority | Denied |

A selected browser session is rejected on this first private-vault surface; it
cannot impersonate conversation authority. Operator browsing of shared scopes is
not exposed yet. An owner speaking in a group does not gain private access.
Missing chat type is denied, except for a spawned child with complete trusted
lineage. A worker's synthetic launch owner bit or copied chat type never upgrades
its parent's access. Nested children follow the same rule. Cross-agent, missing,
cyclic, or stale lineage is denied; older children without a host authority stamp
must be respawned. A dashboard/navigation parent link alone is not a spawn grant.
This applies to OpenClaw-created child sessions. Native runtime child threads
still require that runtime's supported host-tool bridge; Knowledge cannot
authorize a tool call that the host never dispatches.
Resetting only a worker retains its inherited scope while its parent remains
current; the worker's old invocation capabilities are still invalidated.
Agent authority is re-evaluated after asynchronous reads, including session reset
and invocation expiry, and includes every ancestor's incarnation and lineage.

Conversation partition identity follows the SDK's `sessionId`. A host reset may
retain that UUID while rotating its lifecycle revision; existing child grants
are invalidated in either case. Cross-conversation recall, background host access
and operator shared-scope browsing need explicit policy and are not silently granted.

Real records retain the existing envelope and use exactly one of:

```yaml
scope:
  visibility: agent-private
  agentId: main
```

```yaml
scope:
  visibility: conversation
  agentId: main
  sessionId: 33333333-3333-4333-8333-333333333333
```

Scope metadata must match its partition. Missing/invalid/mismatched scope content
is withheld; it is never relabeled. Diagnostics describe problems without echoing
malformed document values. File access uses the host's guarded root reader and
bounded directory iterator with symlink and hardlink rejection. Limits remain
500 catalog entries, depth 8, 64 KiB per record/ontology file, and 8 MiB per catalog scan. Original source files use streaming verification outside those text/scan-size limits; see [EVIDENCE.md](EVIDENCE.md). Incomplete scans fail;
an unavailable vault is not reported as an empty successful result.

## Existing-solution review and decisions

- Inspected gbrain's `src/mcp/http-transport.ts` token-to-source grants in the
  existing upstream research checkout (`7cdc3e30a898665a8c87b0c06937f6366f759f6c`).
  Retain its principle that an authenticated grant constrains source selection.
  Depart from its bearer-token/source federation: Knowledge uses trusted native
  OpenClaw context, one agent vault, and local record/evidence partitions.
- Reuse `openclaw/plugin-sdk/file-access-runtime` (`root.read`, `root.entries`)
  instead of expanding our previous handwritten filesystem reader. The current
  gateway runtime exports this supported subpath but omits its declaration file;
  `src/host-file-access.d.ts` declares only the exercised subset.
- Initially evaluated `api.runtime.state.openKeyedStore`. Live activation proved
  that the host reserves it for trusted published plugins and refuses locally
  linked plugins. Respect that boundary: use Node's built-in `node:sqlite` for a
  **separate Knowledge-owned database**; never open or modify the host database.
  Connections close after each short identity operation, use FULL synchronous
  durability, and atomically insert an absent binding without overwriting one.
- The current `defineFeaturePlugin` helper has no config option. Compose its
  adapters through public `definePluginEntry`, `buildJsonPluginConfigSchema`, and
  tool build metadata. Verify the built manifest retains the vault schema.

## Verification and remaining work

`test/real-vault.test.mjs` exercises actual guarded filesystem operations and the
shared service, with host-authority test doubles and a real plugin-owned SQLite identity store. It covers
UI/tool read agreement, foreign/missing/stale authority, group-owner isolation,
all read surfaces, invisible-scope changes, empty conversation scopes, scope
mismatches, file preservation, identity replacement/restart/move, post-read
revocation, hardlinks/symlinks, and external edit/rename/delete observations.
Live activation separately exercises the actual configured identity store.

Observed hashes/revisions are returned from authoritative reads. External edits, renames and deletions are recorded on the next scan. Publication tests exercise accepted-work recovery and concurrent edits separately from the access tests. No watch service, keyword index, complete restore procedure, or document/meeting ingestion is claimed. Existing memory files and conversation archives are not migrated.

## Local activation sequencing

After changing a plugin's configuration schema, load the new plugin under the
previous valid configuration **before** adding new settings. The running gateway
can cache the old schema even while a fresh CLI validates the new manifest.
Otherwise it rejects the new setting and blocks plugin management. Preserve
unrelated settings and use compare-and-set guards for any temporary restoration;
do not run broad `doctor --fix` for this schema-cache case.
