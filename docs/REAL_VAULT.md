# Real-vault read foundation

Implemented 2026-09-22. This is the access/identity prerequisite for Slice 2, not
recoverable publication or a completed writable vault.

## Storage and configuration

One configured agent vault is supported by this first adapter. Other agents fail
closed; there is no model-facing vault, agent, path, or scope selector. An empty
plugin configuration retains the explicitly labeled synthetic sample mode.
Invalid real-vault configuration never falls back to samples.

```text
<vault-root>/
  vault.json
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
  "operatorRead": true
}
```

The manifest's identity is also bound, atomically if absent, to `agent:<agentId>`
in the plugin-owned SQLite database selected by `statePath`, outside the editable
vault. This path stays unchanged when moving the vault. The database has an
application ID and version; an unrelated, corrupt, or linked file is rejected.
This is operational metadata, not a knowledge record write. A conflicting
checkpoint is never replaced automatically, even if configuration is changed.
Manifest identity, checkpoint, scope directory identity, and authority are checked
before and after a query. No projections are persisted or served in this slice.
Moving the same vault is allowed after updating its configured root; a different
vault at the same path is not. Missing or mismatched identities require explicit
recovery/configuration review, not automatic adoption.

Generation zero is the only supported publication state. Later generations,
publication ancestry, journals, and restore resolution must be introduced together
with the recoverable writer. This read foundation does **not** prove full-backup
recovery. A future full backup must include the plugin-owned operational SQLite database, not just
Markdown and the manifest. Restoring changed prose under an unchanged generation
is observed by rereading files; no older index is trusted.

## Host authority mapping

| Caller | Required trusted evidence | Scope |
|---|---|---|
| Control UI/operator | Authenticated connection ID, host `operator.read` (or its write/admin implication), configured `operatorRead: true` | Configured agent's private partition |
| Agent, owner direct chat | Matching host agent, session key and UUID, latest stored session entry with `chatType: direct`, trusted `senderIsOwner: true`, live invocation guard | Agent-private partition |
| Agent, other known direct/group/channel chat | Same current agent/session verification and live guard; known chat type | Exact host session UUID's conversation partition |
| Missing/unknown/stale context, command adapter, foreign agent | Insufficient authority | Denied |

A selected browser session is rejected on this first private-vault surface; it
cannot impersonate conversation authority. Operator browsing of shared scopes is
not exposed yet. An owner speaking in a group does not gain private access.
Missing chat type is denied, not guessed from a session key or sender ownership.
Agent authority is re-evaluated after asynchronous reads, including session reset
and invocation expiry.

Conversation identity currently follows the SDK's `sessionId`: `/new` or `/reset`
creates a new scope. Cross-reset channel continuity, cross-conversation recall,
background/delegated private access, and operator shared-scope browsing need
explicit policy and are not silently granted.

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
500 entries, depth 8, 64 KiB per file, and 8 MiB per scan. Incomplete scans fail;
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

Observed hashes/revisions are returned from authoritative reads. External changes
are visible on the next query, but do not yet create revision history. No durable
record catalog, journal, write service, editor, receipt/history API, watch service,
index, full restore, or ingestion capability is claimed. Existing memory files
and conversation archives are not migrated.

## Local activation sequencing

After changing a plugin's configuration schema, load the new plugin under the
previous valid configuration **before** adding new settings. The running gateway
can cache the old schema even while a fresh CLI validates the new manifest.
Otherwise it rejects the new setting and blocks plugin management. Preserve
unrelated settings and use compare-and-set guards for any temporary restoration;
do not run broad `doctor --fix` for this schema-cache case.
