# Knowledge stores & sharing

Date: 2026-09-28  
Status: proposed implementation specification; not a delivery or deployment claim.
Amended 2026-09-28 after a host SDK audit; see [§12](#12-host-integration-contract).

## 1. Goal and scope

Give every agent an isolated knowledge store automatically, and let an operator
explicitly assign agents to a shared store. Provide a small native settings
surface that makes those assignments and their consequences understandable.

A store owns its knowledge, evidence, indexes, operational state and local Git
history. An agent uses one effective store at a time. Multiple agents assigned
to the same store use the same storage service and publication coordination.
Each write still identifies the actual writing agent.

This specification combines the agreed backend direction, the September 28 V4
design archive, and the interactive design review. It supersedes the older
one-vault-per-agent/configured-single-agent restrictions for this feature only.
The evidence, publication, correction, retrieval and conversation-isolation
contracts remain in force. Knowledge pages are immediately available when saved;
there is no candidate/accepted state or promotion/approval workflow.

In scope:

- Automatic isolated defaults and explicit named-store membership.
- Lazy, recoverable provisioning; store-owned identity and runtime lifecycle.
- Native inspection and direct operator assignment controls.
- A one-time, backed-up conversion of the existing installation.

Not in scope: copying or merging stores, deleting stores, per-agent filesystem
paths, read-only member roles, cross-owner sharing, federation, remote sync,
connectors, a new ingestion/job engine, scheduled dreaming, or a knowledge editor.
Future maintenance checkpoints belong to the store; this feature does not
implement maintenance itself. No changes to LCM ownership or its context slot.

## 2. Design reference and implementation baseline

Archive: `Openclaw design system.zip`, retained in Git history; see
[DESIGN_REFERENCE.md](DESIGN_REFERENCE.md) to retrieve it. Reviewed
SHA-256: `fc05abfc67704378c6784b5cd083fa26fe179ab6745d19b8a98fa8a4e015d2c2`
(not a committed version; the reference doc explains the difference).

Use these files **inside the archive**:

- `ui_kits/control-ui/knowledge-v4.html`: interactive entry point.
- `ui_kits/control-ui/KnowledgeV4Screen.jsx`: `StoreBar`, `StoresSection`,
  `ChangeMenu`, `StoreDialog`, `SettingsPage` and `VaultFacts`.
- `handoff/knowledge-redesign/V4_CHANGES.md`: earlier V4 reading-view semantics.

The latest store UI is in the top-level V4 prototype. Do not mistake the older
`handoff/knowledge-redesign/prototype/` V1/V2 copies for this feature's reference.
Prototype fixtures, hard-coded counts, simulated health, local React state and
review controls are not production contracts. Port the design into the existing
native Control UI implementation; do not introduce React or a separate app.

The working tree inspected for this spec had base commit `a25b923`. The
host-audience authorization work it depended on has since landed as `515e35d`
(Knowledge) on top of host commit `8b578561b8d`. Observed baseline, not a
guarantee about later commits:

| Area | Current implementation | Required change |
| --- | --- | --- |
| Configuration | `VaultConfig` and plugin manifest accept one `vault` with explicit root, state path and agent | Named membership plus automatic defaults and internal path resolution |
| Identity | `RealVault` binds `vault.json` and SQLite checkpoints to `agent:<id>` | Bind identity/checkpoints to the immutable store identity |
| Service | One `StorageClient`, serialized lane and live-state watcher | Reusable per-store runtime registry; one lane per physical store |
| Access | Trusted host audiences, but configured-agent equality | Resolve membership from trusted agent context; preserve audience restrictions |
| Provider | Opens only the configured agent's store | Resolve each authorized agent through the same store registry as native tools |
| UI | Native read-only knowledge inspector and V4 reading behavior | Settings navigation, agent viewing selector, assignment operations and states |

Relevant sources: [service](../src/service.ts), [access](../src/access.ts),
[real vault](../src/real-vault.ts), [identity store](../src/identity-store.ts),
[storage](../src/storage.ts), [memory provider](../src/memory-provider.ts),
[model](../src/model.ts), [UI](../src/control-ui.ts).

Reuse the existing SQLite operational journal, storage worker, filesystem guards,
Git integration, typed feature contracts and supported host configuration APIs.
The [existing-solution review](REAL_VAULT.md#existing-solution-review-and-decisions)
and [local Git decision](LOCAL_HISTORY.md#existing-solution-decision) remain
applicable. No new storage engine or third-party service is needed. The
[memory SDK direction](MEMORY_SDK_DIRECTION.md) supplies host authority and
provider integration, not a universal store-management or knowledge schema.

## 3. Invariants

1. No assignment means an agent uses its own isolated store.
2. An agent belongs to at most one configured named store. Duplicate membership
   is invalid configuration, never first-match-wins behavior.
3. Membership grants read and update access, subject to existing host authority,
   conversation partitioning and global write-disable controls.
4. Joining, leaving or switching never copies, merges or deletes knowledge.
5. Naming and sharing an existing isolated store preserves that same store's
   identity, records, evidence, receipts, publication lineage and Git history.
6. Settings discovery and operator inspection never provision storage.
7. Only a never-provisioned store can be initialized automatically. Missing or
   invalid previously provisioned storage is an error, not an empty store.
8. Agent tools cannot choose an arbitrary store, agent, path or audience.
9. Two agents sharing a store do not create two workers, writers or maintenance
   owners for it. V1 still assumes one OpenClaw publishing instance.
10. Revocation blocks future access but cannot erase material already returned
    into conversations. Sharing is not a filesystem encryption boundary.

## 4. Configuration, identities and standard layout

### 4.1 Authored membership

The minimal plugin configuration remains:

```json
{
  "stores": {
    "personal": { "agents": ["main", "research"] }
  }
}
```

All other agents use isolated defaults. Keep existing operator-read and
write-enable policy as plugin-wide gates when retiring the old `vault` object;
migration preserves their effective values. Those gates do not create per-member
roles, and possession of an assignment never overrides them.

Use validated stable keys for named stores. An optional `label` on each named
entry supports the UI's human-readable name without making that label a path or
identity. Without a label, display the key. Validate names server-side; reject
blank names and case-insensitive duplicate display names for this UI. UI-created
keys are generated collision-safely on the server, not trusted from a browser
slug. Routine renaming is not required for v1.

An empty member list is valid: a named store with no assigned agents remains in
the inventory. Removing a configuration entry also must not delete its storage;
retain its registry identity/name reservation and display the retained store as
unassigned. Joining it can restore an authored named entry. Do not silently reuse
its key for different data. Removed host agents lose access without deleting
their stores; stale configured membership is diagnosed rather than erased.

Configuration is the authority for membership. The storage registry is the
authority for provisioned identities, isolated-default bindings, named bindings
and initialization/recovery state. It must not become a second independently
editable membership list.

The **settings revision** is a SHA-256 of the canonical JSON of the plugin's
`stores` section, not the whole-file config hash. The host exposes no file hash
outside a write, and `config.get` returns a projected hash that differs from the
file snapshot hash. A section revision also keeps unrelated config edits from
conflicting with assignment saves. The registry records the revision it last
reconciled. That recorded revision is the **assignment generation** carried by
runtimes, handles and fences.

Knowledge reads membership from `api.runtime.config.current()` when resolving a
store, never from `api.pluginConfig`. `api.pluginConfig` is fixed at
registration and goes stale once a stores-only edit stops reloading the plugin.

### 4.2 Stable store identity

Use the existing `vaultId` UUID as the immutable physical store identity; do not
add a second interchangeable UUID. Logical bindings have separate namespaces:
`agent:<agentId>` and `named:<storeKey>`. Both resolve through the registry to a
physical store, or to an explicit never-provisioned logical binding.

The host has no per-plugin data directory. The Knowledge state root is
`path.join(api.runtime.state.resolveStateDir(), "knowledge")`. New stores use
this standard layout:

```text
knowledge/
  registry.sqlite
  stores/
    <vaultId>/
      vault/
        vault.json
        private/
        conversations/<trusted-conversation-id>/
        .git/
      state.sqlite
```

Retain current per-partition records, evidence and artifact layout. SQLite remains
outside the editable vault. Never derive the root from the active workspace or
expose per-agent path configuration. Keep registry/config recovery records
outside editable content.

Each registry entry records its store's physical vault and database locations.
Stores that Knowledge provisions always use `stores/<vaultId>/`. A store adopted
by the one-time conversion (§9) keeps its existing location, recorded in the
registry. Paths are registry-internal facts, never configuration. Trade-off:
the adopted store's directory keeps its historical `agents/main/` path even if
it later becomes a named store. That label is only cosmetic. The alternative,
moving the vault, SQLite state and Git repository during conversion, carries
much more risk. A later relocation can be a separate, explicit maintenance
operation.

Sharing changes logical bindings, not this physical location. On converting an
isolated store into a named store, remove that agent's isolated-default binding
to the converted store. If the originating agent later chooses its own store,
it gets a fresh isolated default on first authorized use. There is no hidden
private copy. Agents that merely joined retain their previous isolated stores.

Use a new manifest version with store identity in place of owning `agentId`.
Keep publication generation/checkpoint and replacement/restore fences. Record
access scope must likewise become store-owned, distinct from writer identity:
private store partition or store plus trusted conversation partition. Preserve
historical author attribution; never rewrite all authors to the current viewer.

## 5. Provisioning and runtime ownership

### 5.1 Inspect versus use

Registry/status/inventory inspection can return an unprovisioned default without
opening or creating its operational database. This includes opening Knowledge,
changing the viewing selector, opening Settings and polling status.

The first authorized agent knowledge operation, or authorized provider data
read/search, may initialize a never-provisioned effective store. A background
health probe or unsupported/denied operation may not. Merely selecting a memory
provider or constructing its handle must not provision all agents' stores.

Initialization creates the vault identity, required directories, SQLite schema
and index state, and local Git history using the existing Git-availability policy.
Missing Git remains a reported limitation, not a new block on knowledge use.
An empty named store declared directly in configuration follows the same lazy
initialization rules. Assignment saves alone do not provision it.

### 5.2 Recoverable initialization

Persist a provisioning reservation and intended UUID before publishing storage.
Serialize concurrent first uses by logical binding; stage initialization, verify
the complete manifest/database pair, then publish the ready registry entry.
Durable checkpoints must let a retry resume the same UUID after interruption.
Do not infer never-provisioned state merely from a missing directory or database.

Expose distinct states: `unprovisioned`, `initializing`, `ready`, `unavailable`,
and `recovery-required`. A completed store whose directory, identity, database
or registry binding disappears must not enter the initialization path. Registry
loss/corruption itself requires recovery, not discovery-and-adopt guessing.

### 5.3 One runtime per store

A store runtime owns its storage worker/client, serialized read/write/recovery
lane, live-state watcher, index bindings and Git queue. Both the memory-provider
adapter and feature tools resolve to that runtime. Different stores may operate
independently; all agents using one store share its publication coordinator.

Close/reload drains or fences work through the existing lifecycle machinery.
Closing one agent's provider handle must not dispose a runtime still in use by
another agent. Handles and caches carry store and assignment generation; stale
handles cannot silently operate against either the former or replacement store.

Runtimes start lazily, on the first operation that §5.1 allows to touch a
store. Inspection never starts a worker. A runtime stops when its store leaves
every assignment (after draining, per §6) and on plugin disposal. There is no
idle-timeout shutdown. Trade-off: memory grows with the number of distinct
stores used since the Gateway started. Each worker holds a SQLite connection
plus scan and link caches. The live Gateway already logs memory pressure near
1.4 GB RSS. The foundation phase measures per-worker RSS on a copy of the live
vault. An idle-shutdown timer is a separate decision, taken only if that
measurement warrants it.

Fencing reuses the worker's existing synchronous authority round-trip. The
main-thread `assertCurrent` check a worker makes before each side effect also
compares the runtime's assignment generation with the registry's active
generation. That extends an existing check; it is not a new mechanism.

## 6. Authority, partitions and assignment changes

Resolve the effective agent from the host-minted memory audience and current
invocation guard. For delegated execution, preserve the host's existing audience
semantics; do not reconstruct ancestry or choose a store from prompt text.
Keep executing-agent provenance separate when the host exposes it. If execution
identity is unavailable, preserve that uncertainty rather than inventing it.
The current host audience carries only the effective `agentId`
(`owner-private` or `conversation`), with no executing-agent field. Writer
attribution is therefore the effective agent, and records store no
executing-agent field until the host provides one.

| Caller | Allowed surface |
| --- | --- |
| Eligible owner-direct agent audience | Effective store's private knowledge |
| Eligible conversation audience | Effective store's exact host-minted conversation partition only |
| Authenticated authorized operator | Registry/settings metadata and selected agent's private-store inspection |
| Operator holding `operator.admin` (the scope core `config.patch` requires) | Assignment mutation; still no browser knowledge editor |
| Missing/stale audience, unauthorized background call, unsupported adapter | Denied; no provisioning or fallback |

Membership does not turn group conversations into private readers or grant
cross-conversation access. Do not equate a display channel name or URL with a
host conversation identity. Two agents only share conversation-scoped data when
their host-issued audiences identify the same partition.

All record, evidence, attachment, revision, history, search, relationship and
mutation/resume paths use the same resolution and fences. A cached citation or
attachment reference is not a capability to a former store. Bind cursors,
provider references, result caches and in-flight responses to store identity and
partition; reject stale or mismatched references instead of searching another
store for a coincidentally matching record ID.

Before acknowledging an assignment change, fence affected invocations and
serialize the cutover with relevant store lanes. Queued old-assignment work must
fail. Already accepted publications must reach a durable recoverable boundary;
do not abandon their recovery journal or reroute their retries into the new
store. Recheck authority before returning reads and before publication commit.
State the linearization point: once a save reports `applied`, no old-assignment
invocation may subsequently release data or begin a new publication.

Registry recovery may finish an already accepted publication without granting
its former caller continued access. Request IDs/receipts remain bound to their
original store and actor. A retry after switching stores must not turn a pending
old-store operation into a new-store write.

## 7. Typed operator operations and configuration persistence

Add operator-only typed feature operations; names below are proposed, not
existing endpoints. Do not expose assignment mutations as model-callable tools.

| Operation | Input / result |
| --- | --- |
| `stores_snapshot` | Non-provisioning inventory: host agents, effective assignments, logical/physical store identity where present, members, availability, permitted actions and an opaque settings revision |
| `stores_change` | Idempotency key, expected settings revision, affected agent, and one of `share_existing`, `use_named`, `use_own`; returns authoritative applied state or a typed error |
| `stores_change_status` | Reconcile a request whose response was lost; report applied, not applied, pending/recovery or conflict |

`share_existing` contains the new display name and selected additional agents.
`use_named` contains a registry-resolved named target. `use_own` contains no
arbitrary path/store payload. Validate all referenced agents against host state,
all targets against the authorized registry, and every permission server-side.
An operator viewing selector is allowed only after operator authorization; this
does not add an agent/store selector to native model tools.

Inventory includes preserved isolated stores and unassigned named stores. Counts
are authorized private-partition counts, not accidental totals across private and
conversation data. Unknown counts remain unknown; never render unavailable as
zero. Capability flags distinguish a policy denial from an unavailable host API.

Persist through supported host configuration read/validate/patch facilities,
using revision comparison and preserving unrelated settings and SecretRefs.
Require the host's actual configuration-write authorization; do not assume that
ordinary knowledge-write permission authorizes changing membership. No shell
editing, whole-config reconstruction or bypass through a browser file write.

Concretely:

- **Authorization.** `defineFeaturePlugin` registers mutations at
  `operator.write`, and the host has no config-specific scope. `stores_change`
  and `stores_change_status` stay typed feature operations. Their handlers also
  reject callers whose `action.client.scopes` lacks `operator.admin`, with a
  typed `forbidden` error. `stores_snapshot` stays at `operator.read`. The
  snapshot's capability flags report whether the caller may change assignments.
- **Write.** Use `api.runtime.config.mutateConfigFile` with
  `afterWrite: { mode: "auto" }`. The `mutate` callback recomputes the `stores`
  section revision from the draft, which is the current file. On a mismatch it
  throws a typed conflict before changing anything. The host's config write lock
  makes that check-and-write atomic against other lock-holding writers. The host
  validates the whole resulting config against the plugin schema and preserves
  SecretRefs.
- **No plugin reload.** The plugin entry declares
  `reload: { noopPrefixes: ["plugins.entries.knowledge.config.stores"] }`.
  Narrow rules take precedence over the broad `plugins` hot-reload rule
  (`config-reload-plan.ts`, `compareReloadRules`). A stores-only change is then
  a no-op plan, which still publishes the runtime config snapshot
  (`onNoopConfigCommit`) without reloading any plugin. This is required, not an
  optimization: a hot plugin reload admits no new model runs Gateway-wide while
  it drains, and in production it has failed and retired every plugin. Do not
  use `afterWrite: { mode: "none" }`: it skips runtime publication
  (`runtimeApplied: false`), so `config.current()` would not show the change.

An assignment transaction validates the entire resulting membership map. Moving
an agent removes its old named membership and adds the new one in one semantic
transaction. Never publish an intermediate duplicate or isolated assignment.

Configuration and the registry cannot share a SQLite transaction. Journal the
intent, expected config revision, previous/next bindings and request ID before
cutover. Fence affected access, apply the host config patch, reconcile the
registry, activate the new generation, then acknowledge success. While these
disagree, affected access is unavailable; do not guess a binding. On interruption,
compare actual host config with the journal and complete or safely roll back the
same operation. Unexpected external edits produce a conflict, not an overwrite.

Repeated identical requests return the same outcome; reusing a request ID for a
different intent is rejected. A timed-out response is not proof of failure.
Retain operation status across a host-triggered plugin reload. Apply this same
validation/reconciliation path to externally edited configuration.

The journal lives in `registry.sqlite`. Detecting external edits needs no host
notification. Every store resolution compares the `stores` revision in
`config.current()` with the registry's reconciled revision. On a mismatch with
no journaled operation in flight, affected bindings become unavailable until
the same validate/fence/reconcile path completes in-process. Invalid external
membership, such as a duplicate agent, keeps affected agents unavailable and is
reported through `stores_snapshot`. It never falls back to first match.

Host preflight result (isolated Gateway, 2026-09-28): a stores-only write with
`noopPrefixes` causes no plugin stop or replacement, and `config.current()` is
**not** yet updated when `mutateConfigFile` resolves (it follows about a second
later). Knowledge therefore enforces the registry's reconciled section, keeps
the previous revision as expected lag in memory, and confirms it against the
persisted file (read under the config lock by aborting inside `mutate`) before
ignoring it. It does not poll or delay. A pending change is settled against the
persisted file, never `config.current()`.

## 8. Native UI and flows

### 8.1 Reading context and settings

Replace the header Vocabulary action with **Settings**. Settings contains:

1. Stores & sharing.
2. Vocabulary.
3. Vault status.

The reading view shows `Agent: Main ▾` and
`Personal · Shared with Research`, or `Main’s knowledge · Not shared`.
Selecting an agent changes only the viewed effective store. It does not change
membership, impersonate an agent invocation or initialize a store. Chat handoffs
use the selected agent's effective context and preserve existing draft behavior.

Use **“Knowledge saved here, and where it came from.”** for named stores even
when only one agent remains. Membership count is not authorship. A named store
may say “No other agents” or “No agents assigned” without losing its identity.

All counts, search, recent activity, vocabulary, diagnostics, downloads and
navigation resolve against the selected store. Clear old-store results at a
store boundary and reject late responses; never show one store's content under
another store's label. Preserve reading state for ordinary same-store refreshes.
When an assignment changes the viewed store, reset store-bound navigation and
announce the switch. Keep selected agent/store context clear in Vault status.

Vocabulary remains an inspector of the effective store's ontology. Do not copy
the prototype's assertion that every store uses the default vocabulary if real
local ontology definitions differ.

### 8.2 Stores & sharing page

Intro: **“Each agent gets its own knowledge store unless you assign it to a shared
one.”** Table columns: Agent / Knowledge store / Access / Change… . Below, list
stores, membership, known record counts and availability, including unused
previous isolated stores and unassigned named stores.

Direct changes here are operator configuration, not knowledge editing. Omit JSON,
filesystem paths, role matrices, delete buttons and merge controls. Availability
and permission messages must explain disabled actions without requiring users to
understand internal storage details.

### 8.3 Share this store…

From an agent using an existing isolated store:

- Enter a name and select one or more other agents.
- Explain that the existing store gets a name; it is not copied or replaced.
- Allow agents already using another named store. Show their current assignment
  and explicitly preview that they will switch, not gain a second assignment.
- Keep every displaced store unchanged. For an agent with no previous store, do
  not claim a previous store exists.
- Preview access to existing knowledge and unchanged group-chat boundaries.
- Commit once with **Share store**.

Example consequence: “Research will switch from Personal to Team and be able to
read and update the knowledge already saved there in owner-direct conversations.
Personal remains unchanged. Group chats still see only their own conversation’s
knowledge.” For isolated joiners, name the previous isolated store instead.

Disable this action for an unprovisioned or unavailable source store. The former
has nothing to name/share yet; the latter needs recovery. An initialized empty
store can be shared. The UI does not need a separate create-empty-shared-store
wizard in v1; direct configuration can declare one lazily.

### 8.4 Use shared store…

Select an existing named store, including an unassigned retained store. Show its
members and availability. Preview read/update access and the current store left
behind: “Assistant will use Personal. Nothing from Assistant’s current store will
be moved or merged.” Save with **Use Personal**.

This same flow switches between two named stores. An unprovisioned configured
target remains lazy; an unavailable previously provisioned target is disabled
with a recovery explanation. Name explicitly that an agent will stop using its
old store when relevant; do not imply revocation erases prior conversation text.

### 8.5 Use own store

- Previous isolated store exists: **“Resume Research’s previous store.”**
- No previous isolated store exists: **“Use a new, empty store for Main.”**
  Supporting copy: **“Created on first authorized use. Viewing it here does not
  create it.”**
- Previous store is unavailable: show recovery required, not the fresh-store path.

Explain that nothing from the shared store is copied or removed, identify who
continues using it, and preserve it if no members remain. Save with **Use own
store**. Never call this “Make private.” Returning after sharing one's original
store is explicitly a fresh default, not recovery of a duplicate private copy.

### 8.6 State and interaction refinements

| State | Required behavior |
| --- | --- |
| Never provisioned | “Created on first use”; explanation uses first authorized use, not first save |
| Initializing | Clear progress status; not an empty ready store |
| Ready and empty | “Nothing saved here yet” |
| Previously provisioned but unavailable | “This store couldn’t be opened”; retain assignment and offer retry/diagnostics, never silently replace |
| Saving assignment | Disable duplicate submit; show “Saving…”; do not optimistically switch content |
| Applied | Refresh authoritative assignments/inventory and any affected reading view; announce the specific change |
| Rejected/not applied | Keep dialog and selections; explain that the assignment was not changed and how to retry |
| Outcome unknown | “Checking whether the change was saved…”; reconcile the same request ID before declaring success/failure |
| Concurrent config edit | Refresh revision and consequences, preserving inputs where possible; require a new deliberate save, not silent overwrite |
| Disconnected | Distinguish last-known state from confirmed current state; block saves until authority/state is available |

Render Change… menus outside the assignment table's clipping boundary; the
prototype's overflow clips lower options. Preserve keyboard navigation, focus
trapping/return, Escape behavior, accessible row-specific button names and
announced status. Dismissing a saving dialog must not be described as cancelling
an already accepted operation. Keep existing narrow-window/light/dark coverage.

The only confirmation is the consequence preview plus the save button. Do not
add an approval workflow. No review fixtures or implementation jargon in the
product reading path.

## 9. One-time conversion of this installation

This is a controlled migration, not a permanent legacy compatibility framework.
Implementation of the spec does not itself authorize deployment or data movement.

1. Inspect the actual running gateway, loaded plugin/config and active vault;
   do not infer them from workspace paths. Record effective write/read policies.
2. Quiesce reads/writers and resolve or explicitly preserve pending publication,
   attachment and Git recovery work. Back up config, vault, retained artifacts,
   Git repository and consistent SQLite operational state; include required WAL
   state or use SQLite's backup facility. Record an integrity inventory.
3. Convert in place; do not relocate (§4.2). Preserve `vaultId`, record IDs,
   revision chains, evidence locators, withdrawals, receipts and Git lineage.
   Convert manifests, checkpoint keys and record access envelopes to store-owned
   identity. Preserve prior history blobs with their historical format metadata;
   migrate operational references needed for safe retry, not their meaning.

   Rewriting every record's `scope` envelope (334+ files at the time of
   writing, all `agentId: main`) changes every record's content hash. The
   conversion is one journaled operation:
   - Its observation, `git_files` and history entries record the new hashes
     with conversion provenance, so the live-state watcher never sees the
     rewrite as external edits.
   - It lands as a single local Git commit.
   - Record revision numbers are unchanged; the envelope is storage metadata,
     not a knowledge revision.

   Count the actual files at conversion time; ingestion adds records daily.
4. Create the registry binding for `main`'s isolated default. If immediate sharing
   is selected in the rollout configuration, register that same store as a named
   store and assign the chosen agents instead. Never create a second empty vault.
5. Validate identity/checkpoint alignment and every partition, rebuild only
   derived indexes as necessary, and verify retained evidence and history.
   Account for absolute operational paths changed by relocation; preserve
   portable relative links. Do not reset publication lineage to evade fences.
6. Atomically/recoverably activate the new config and registry, removing the old
   `vault` configuration shape. Preserve unrelated host settings. Verify native
   tools, provider reads and UI against the actual runtime before resuming work.
   Activation loads new plugin code, so it needs a Gateway restart approved for
   that task. Do not use `openclaw plugins reload`: it has failed in production
   and retired every plugin. The live Gateway must also run a host build that
   includes `8b578561b8d` (host-resolved memory audience).

Migration stages need a durable journal: interruption leaves either the intact
old installation or a recognized recoverable cutover, never ambiguous partial
adoption. Retain backups. Rollback restores a matched config/registry/vault/DB
set, not just Markdown; once new writes occur, do not discard them by blindly
reverting to the pre-conversion backup. Old-format data after cutover is an
explicit migration/recovery condition, not a silent fallback mode.

## 10. Implementation sequence

1. **Contracts and host preflight:** exercise the §12 host contract in an
   isolated Gateway: section-revision conflicts inside `mutate`, the
   `noopPrefixes` no-reload behavior, and `config.current()` freshness after a
   write (§7 gate). Define registry/manifest/scope schemas, settings operations,
   errors and capabilities. Update the built plugin schema.
2. **Store foundation:** implement registry, lazy provisioning and per-store
   runtime ownership; convert identity, checkpoint, retrieval and actor bindings.
   Measure per-worker RSS (§5.3).
3. **Access and switching:** route tools/provider through one resolver, implement
   fencing, assignment transaction/reconciliation, scoped references and reload.
   At the end of this phase, isolated per-agent stores work without the UI or
   named sharing. This is the first integration checkpoint.
4. **UI:** port V4 settings/selector/dialogs with the refinements above, using
   the typed service rather than prototype state. Keep existing reading behavior.
5. **Conversion and verification:** build and exercise the one-time migration on
   isolated copies, document recovery, then separately perform authorized live
   activation with actual-runtime verification.

Update [REAL_VAULT.md](REAL_VAULT.md), [FORMAT.md](FORMAT.md),
[MEMORY_PROVIDER.md](MEMORY_PROVIDER.md), [LOCAL_HISTORY.md](LOCAL_HISTORY.md),
[KNOWLEDGE_SCOPE.md](KNOWLEDGE_SCOPE.md) and [MODEL_API.md](MODEL_API.md) when
implementation lands. Keep delivery status in an implementation record rather
than silently treating this proposed spec as completed work.

## 11. Acceptance criteria

Use isolated fixtures/copies; never seed the live store for demonstrations.

| Scenario | Required evidence |
| --- | --- |
| Two unassigned agents | First authorized uses create different stores; neither can retrieve the other's private records |
| Passive discovery | Opening settings, selecting agents, status polling and health probes create no store artifacts |
| Concurrent first use/crash | One logical binding converges on one UUID and coherent ready store; interrupted initialization resumes safely |
| Missing existing store | Missing vault, DB or registry produces unavailable/recovery, never a new empty identity |
| Share existing data | Original UUID, records, evidence and history persist; added agent reads and updates through the same runtime |
| Switch named stores | Agent leaves A and joins B in one semantic change; A's data and remaining members are untouched |
| Return to own | Joiner resumes its old isolated records; originating sharer gets a lazy new default; unavailable old default does not get replaced |
| Zero members | Retained named store remains visible and reassignable with its original data |
| Validation/conflict | Duplicate membership, invalid agents/names and stale settings revisions are rejected without partial application |
| Authorization | Read-only operator cannot change assignments; forged store/agent/session inputs cannot broaden tool/provider authority |
| Conversation isolation | Shared membership never exposes private or another conversation's records, evidence, history, counts or attachments |
| Revocation race | Delayed reads/queued writes/old handles cannot succeed across cutover; accepted publication recovery stays bound to its original store |
| Retry/reload | Lost save response reconciles to one outcome; crash between config and registry is recoverable; reload does not duplicate writers |
| Provenance | Writes by distinct agents retain distinct actual actor attribution; changing viewer/membership never changes old authors |
| Store switching UI | Counts, queries, downloads, vocabulary and late responses cannot leak the prior store under the new label |
| Named store with one member | Header remains store-centered; prior contributors are not relabeled as the remaining agent |
| Dialog behavior | All three flows show consequences; saving, error, unknown outcome and conflict states preserve truthful feedback |
| Layout/accessibility | Menus are fully visible; keyboard/focus behavior and existing narrow-window/theme coverage pass |
| Conversion | Integrity inventory, evidence, IDs, correction history, receipts and Git history survive; interrupted cutover and coherent restore are exercised |

For implementation run `npm run check`, `npm run build`, `npm run validate`,
focused store/access/publication/migration tests and the rendered browser suite.
Run the existing regression suite before claiming integration complete. A design
prototype or successful assignment table refresh alone does not prove backend
isolation, revocation, recovery or live deployment.

## 12. Host integration contract

Verified against the host source at `8b578561b8d` (openclaw
`feat/provider-neutral-memory` runtime). This feature needs no host changes
beyond that commit. The live Gateway must run a build that includes it.

| Need | Host surface | Source |
| --- | --- | --- |
| Membership read | `api.runtime.config.current()` | `src/plugins/runtime/types-core.ts` (`config`) |
| Membership write | `api.runtime.config.mutateConfigFile({ afterWrite, mutate })`; revision checked inside `mutate` (§7) | `src/config/mutate.ts` |
| Stores-only edits don't reload the plugin | Plugin entry `reload.noopPrefixes`; narrow rules sort ahead of `plugins` | `src/plugins/plugin-definition.types.ts`, `src/gateway/config-reload-plan.ts` |
| Operator authority | `PluginSessionActionContext.client.scopes` contains `operator.admin` | `src/plugins/host-hooks.ts`, `src/plugin-sdk/feature-plugin.ts` |
| Agent inventory | `listAgentIds(config)` from `openclaw/plugin-sdk/agent-scope-runtime`, applied to `config.current()` | `src/plugin-sdk/agent-scope-runtime.ts` |
| State root | `api.runtime.state.resolveStateDir()` + `knowledge/` | `src/plugins/runtime/types-core.ts` |
| Per-agent authority | `MemoryProviderRuntime.open` per request, with a host-minted `audience` | `src/plugins/memory-provider-types.ts` |

Known host limitations, accepted here rather than worked around:

- There is no per-plugin data directory, so Knowledge chooses its own
  `knowledge/` subdirectory.
- There is no config-specific operator scope, so assignment changes require
  `operator.admin`.
- There is no executing-agent identity in the memory audience (§6).
- `openclaw plugins reload` is unsafe with in-flight work. Neither this feature
  nor its rollout depends on it.
