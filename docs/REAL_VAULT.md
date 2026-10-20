# Real-vault access and publication

Read foundation implemented 2026-09-22; extended with journaled page writes.
This is not a completed v1 ingestion, search or full-backup/restore system.

## Storage and configuration

Every agent has an effective knowledge store: its own isolated store by
default, or a named shared store assigned in configuration. Stores are created
lazily on an agent's first authorized use; inspecting them never creates one.
There is no model-facing store, agent, path, or scope selector. See
[stores and sharing](STORES_AND_SHARING_SPEC.md) for the full contract.

```json
{
  "operatorRead": true,
  "writesEnabled": true,
  "stores": { "personal": { "label": "Personal", "agents": ["main", "research"] } }
}
```

`operatorRead` and `writesEnabled` are plugin-wide gates (both default on).
`stores` is the only per-agent setting; an agent in no named store uses its own
isolated store. Duplicate membership makes the affected agents unavailable; it
is never resolved by first match. Membership edits do not reload the plugin
(`reload.noopPrefixes`); Knowledge applies them in-process.

Physical layout, under the host state directory:

```text
<state>/knowledge/
  registry.sqlite             # store identities, bindings, assignment journal
  registry.id                 # sentinel: a missing/emptied registry is recovery
  stores/<vaultId>/
    state.sqlite              # operational journal, history, index, Git queue, Recent projection
    vault/
      vault.json
      .git/                   # initialized automatically in writable mode when Git is available
      private/
        ontology.yaml         # optional extension of the shipped ontology
        people/, projects/, … # ordinary record files
        claims/, relationships/
        artifacts/            # retained evidence within this scope
      conversations/<sessionId>/
        …                     # same layout, independently scoped
```

A store converted from the single-vault layout keeps its original location,
recorded in the registry (see `scripts/convert-to-stores.mjs`). Paths are
registry facts, never configuration.

Partition directories are an enforcement aid, not separate logical stores.
Select the partition **before** traversal, ontology resolution, validation,
counts, references, evidence reads, or diagnostics. There are no cross-partition
links or artifact reads. The shipped ontology is available in each partition;
private custom definitions are not implicitly published to conversations.

`vault.json` is a strict JSON object owned by the store, not an agent:

```json
{
  "format": "knowledge-vault-v2",
  "vaultId": "11111111-1111-4111-8111-111111111111",
  "generation": 0,
  "publicationId": "22222222-2222-4222-8222-222222222222"
}
```

The manifest is bound to `store:<vaultId>` in the store's `state.sqlite`,
outside the editable vault. The database has an application ID and version; an
unrelated, corrupt, or linked file is rejected. A conflicting checkpoint is
never replaced automatically. Manifest identity, checkpoint, scope directory
identity, and authority are checked before and after a query. A provisioned
store whose directory, manifest or database disappears is reported unavailable;
it is never re-created empty.

Fresh database adoption requires generation zero. Once bound, successful publication advances the manifest generation/publication ID and SQLite checkpoint together through the recoverable journal. Identity mismatches and older-vault/newer-database combinations fail closed. This does **not** establish a full-backup restore procedure; retain the operational database, vault and artifacts together.

Trusted agent writes use the same scope mapping as reads and are attributed to the writing agent in history (`history.agent_id`), so a shared store keeps each revision's author. Operator writes additionally require `operator.write`/admin authority; operator read access alone cannot save. The shared save API supports pages and retained supplied text evidence, not a completed multi-record ingestion or claim/relationship editor.

Published receipts, retained revision snapshots, scoped mutation material, external-change observations and interrupted-publication resume are available. Exact reads re-read files and record external changes on the next query; no filesystem watcher is installed. Pending/conflicted accepted publication blocks ordinary reads rather than serving a partial catalog. Pre-acceptance rejections do not journal drafts. See [model API and draft boundaries](MODEL_API.md).

## Shared storage service and local Git

`KnowledgeStorage` is the per-store stateful boundary; each physical store has one runtime (worker, lane, watcher, Git queue) shared by every agent using it. UI/tool adapters authorize the caller and delegate; they do not open SQLite, invoke Git, or bypass publication for reads. The service owns guarded reads/observations, the database adapter, publication/recovery, and local Git checkpoints. SQLite connections remain short-lived across operations/plugin reloads; stateful ownership does not require leaking native handles.

Writable vaults use Git by default, without a separate enable flag. Scoped scans checkpoint existing Markdown/ontology and later observed changes. Publication checkpoints its exact page/artifact batch. A missing executable leaves reads/writes available and reports `unavailable`; repository problems report a retryable `pending` gap. Read-only mode does not initialize or mutate Git. [Full local-history contract](LOCAL_HISTORY.md).

## Host authority mapping

| Caller | Required trusted evidence | Scope |
|---|---|---|
| Control UI/operator | Authenticated connection ID, host `operator.read` (or its write/admin implication), `operatorRead` | Private partition of the default agent's effective store, or of an agent chosen through the operator-only `agent_query`/`agent_action` proxy |
| Operator changing assignments | `operator.admin` | `stores_change` only; never knowledge edits |
| Agent, owner-private audience | Host-minted `owner-private` memory audience, live invocation guard, current audience guard | Private partition of that agent's effective store |
| Agent, conversation audience | Host-minted `conversation` memory audience with its session key and UUID, live invocation guard, current audience guard | Exact audience session UUID's conversation partition in that agent's effective store |
| Spawned child | The host validates every stamped parent incarnation and gives the child its root's audience | Same partition as the originating root |
| Missing/stale audience, command adapter | Insufficient authority | Denied |

A selected browser session is rejected on this first private-vault surface; it
cannot impersonate conversation authority. Operator browsing of shared scopes is
not exposed yet. Knowledge does not inspect chat metadata, read session entries,
or reconstruct spawn lineage. OpenClaw resolves direct-owner, conversation, and
spawn inheritance once and supplies the resulting audience to providers and
plugin tools. A missing or foreign `memoryAudience` is denied. OpenClaw's
`assertMemoryAudienceCurrent` guard revokes stale lineage; Knowledge calls it
together with the invocation guard before and after asynchronous work.

Conversation partition identity follows the host audience's `sessionId`.
Cross-conversation recall, background host access and operator shared-scope
browsing need explicit policy and are not silently granted. Sandbox state remains
a separate provider restriction; Knowledge denies sandboxed provider calls.

Real records use exactly one store-owned scope:

```yaml
scope:
  visibility: private
```

```yaml
scope:
  visibility: conversation
  sessionId: 33333333-3333-4333-8333-333333333333
```

The partition belongs to the store; which agent wrote a revision is recorded in
history, never in the envelope.

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
shared service, with host-audience test doubles and a real plugin-owned SQLite identity store. It covers
UI/tool read agreement, foreign/missing/revoked authority, conversation isolation,
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
