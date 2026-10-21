# Knowledge as a memory provider

Knowledge targets OpenClaw's provider-neutral memory runtime. It registers `providerRuntime` through the public `MemoryPluginCapability` contract
from `openclaw/plugin-sdk/memory-host-core`; it does not import the private-local
`memory-host-search` facade or host internals. Local types are derived from
`NonNullable<MemoryPluginCapability["providerRuntime"]>` in
`src/memory-provider-types.ts`.

The provider runtime contract is present in published OpenClaw (checked against
2026.10.5), and Knowledge builds against that package. Newer hosts also pass the
memory prompt a `projectKey`, which published types do not yet declare; Knowledge
reads it when present, and on a host without it the prompt simply omits the
repository-key guidance. See the README's Develop section. An older host ignores
`providerRuntime`, so it can still load Knowledge's native surfaces but cannot use Knowledge as the shared
memory provider. The package's peer range does not establish provider-runtime
support.

## Ownership and activation

`openclaw.plugin.json` declares `kind: memory`. The host must select `knowledge`
for `plugins.slots.memory` and enable/configure the plugin to activate it.
An unselected memory plugin can be disabled by the host slot gate; Knowledge
has no simultaneous standalone companion mode. Its existing native tools,
read-only UI, and memory adapter are registered together, sharing one storage
instance and one serialized operation lane. No second publisher, watcher or
write API is created. Per-request close releases a lease, not the service.

That storage instance runs in a worker thread: vault scans, evidence checks,
SQLite and Git never block the Gateway's main thread. Authorization stays on the
main thread; the worker receives only the resolved scope and asks the main thread
to re-check the caller's live authority each time storage revalidates before a
side effect. The worker keeps one scan per scope and reuses it only while every
record, ontology and cited file still has the same file stamp (inode, size,
mtime and ctime); any change rescans and observes as before.

Build/validation does not select the plugin or change the live configuration.
Before switching, preserve existing configuration, verify the compatible running
Gateway, and use supported plugin activation. Merely selecting Knowledge does
not migrate or delete Memory Core data. Switching back leaves the vault intact.
A service stop/restart, caller revocation, runtime retirement or manager close
fences retained leases; reload rollback can resume the drained old runtime.

## Shared reads

- Search uses current, eligible, scope-filtered records and keyword BM25, not
  embeddings. Scores are query-local and `minScore` is enforced. The provider
  declares only the `memory` source, so the host rejects any request containing
  `sessions` before calling Knowledge. Knowledge retains its own validation for
  direct contract use. Knowledge does not apply project filters during search.
- Opaque references contain the provider, record ID, and revision plus content
  hash. They grant no access and remain valid through a rename only when the
  record bytes/revision remain unchanged. Changed revisions reject reads.
- Search cursors bind query/filter/scope/vault and index snapshot. A changed
  snapshot rejects continuation. Pages report partial coverage until exhausted;
  validation issues also make coverage partial. Failed indexing is an error,
  never successful zero matches.
- Get returns only active eligible records, including pages, claims and explicit
  relationships. Historical, withdrawn, invalid and fixture records stay with
  native exact/history workflows. Reads use 1-based lines over the rendered
  title/attribution/body, up to 200 lines per request (100 by default), bounded
  by the vault's per-file limit. Continuations retain the reference revision.
- Search includes title, assertion origin and attribution. Get includes these
  plus up to 20 retained-evidence locators. The shared API is a projection, not
  a lossless replacement for native evidence/metadata/relationship tools.
  Evidence locators describe retained artifacts, not lines in the rendered body.
- Session and operator health reports scoped vault/ontology validation; it does
  not invent embedding health or claim keyword-index readiness before a search.
  Host authority opened with `purpose: "status"` receives a health-only handle:
  readiness has a generic message and no record counts, scope, IDs, or paths.
  Doctor and CLI status use this handle. Storage failures report `unavailable`
  without exposing their error details; caller and lease revocation still reject.

The handle declares `{ sources: ["memory"], pagination: true, candidates:
["trigger", "project"], projectFilter: false }`. Search cursors are supported.
The host applies the all-of active-project-key check because Knowledge declares
`projectFilter: false`.

`candidates({kind, limit})` is available only to an owner-private audience and
shares the search/get serialization and authority fences. The default limit is
48 and the maximum is 200. Results are active, valid, available records in the
agent-private partition with a complete service-issued `recall` block. Trigger
candidates require at least one trigger; project candidates require at least one
project key. Results sort by descending `importance`, then stable record ID.

Each candidate excerpt is exactly `recall.summary`. Record bodies, ingested
source text, and other metadata never enter the automatic excerpt. The hit marks
`automaticRecall.eligible: true`, joins trigger phrases with newlines, carries
optional importance/project keys, and cites the record revision/hash. Ordinary
search hits retain their existing excerpt and always mark eligibility false.

A conversation audience receives no candidates and the warning `Automatic recall
uses only owner-approved private records.` Operators cannot enumerate candidates,
and host status handles remain health-only. Invalid, superseded, withdrawn,
expired, fixture, ambiguous, or dependency-ineligible records are excluded.

The memory capability declares `knowledge_grep`, `knowledge_lookup`, and
`knowledge_record` in `recallToolNames`. Active Memory defaults deep recall to
these tools and passes the parent turn's host-minted `MemoryAudience` to the
child run. Grep and lookup expose the returned page's `resultCount`, so Active
Memory distinguishes an empty result from a result that can ground a summary,
including an empty page after earlier matches.

Every provider call resolves the requested agent's effective store through the
same resolver as native tools, so an agent's provider and tools share one store
runtime. Operator reads require a current host capability, connection ID,
read/write/admin scope and `operatorRead`; they never create a store. Session
reads consume the host-resolved audience on the provider authority, and only an
agent session's own search or read may create its never-provisioned store. An
`owner-private` audience maps to the store's private partition; a
`conversation` audience maps to its exact session UUID partition. References
carry their store identity (`revision@vaultId`), and search cursors bind to
store and partition, so a reference or cursor from a former store is rejected
instead of matching a coincidental ID elsewhere. Native tools consume `memoryAudience` from their tool
context. Knowledge does not read session entries, infer owner status, or walk
spawn lineage. OpenClaw owns those decisions, gives spawned children their
validated root audience, and revokes stale lineage through the audience currency
assertion. Missing and foreign audiences and sandboxed provider calls are denied.
Host authority can open only with `purpose: "status"`; its handle denies search
and get. Every other host-purpose combination is denied at open.

## Prompt and lifecycle boundaries

The selected-provider prompt routes recall to lookup/search/read and procedures
to the six shipped skills. It asks for unprompted ordinary-turn remembering through
`knowledge_remember` before the final reply, not post-turn extraction. Write-disabled vaults and missing tools omit save guidance;
sample mode emits no memory prompt and cannot supply memory records. Citation-off
mode is explicit. The host exposes tools but no enabled-skill inventory, so skill
references are conditional on availability and associated tools, not a guarantee
that disabled skills were delivered.

When the host supplies a repository `projectKey` (not a `path:` key), the prompt
names it as the alias of the repository's project page and asks the agent to pass
it as the `knowledge_remember` subject for claims about that repository's work, so
those claims link by exact alias rather than name inference. Choosing that subject
stays the agent's judgment: a repository run also produces claims about people and
other projects, so Knowledge never applies the key as a default subject. Tool calls
do not receive the key; only the prompt section does. With page tools available,
the prompt also asks the agent to add the alias or create the project page when
none answers to the key.

Automatic injection uses only the summary explicitly approved through
`knowledge_recall`; keyword search is not a trusted-instruction selection
mechanism. Corrections require a new approval on the replacement record.

Knowledge owns the pre-compaction memory flush when a real vault has
`writesEnabled: true`. Its tools-mode plan has two persistence tools:
`knowledge_remember` for discrete claims and `knowledge_save_page` for notes.
It also declares `knowledge_grep`, `knowledge_lookup`, `knowledge_record` and
`knowledge_ontology` as read-only lookup tools for the note path. The host
supplies its standard `read` tool and delegates the source turn's audience to
the flush session. It counts only successful save calls as persistence
evidence; lookup success does not complete the flush. Write-disabled and sample
configurations return a null plan, which also prevents a Memory Core sidecar
from supplying a file flush.

The flush saves durable decisions, preferences, corrections, commitments,
project-state changes and facts about people or projects. It uses one
`knowledge_remember` call with the supporting quoted excerpt and a subject
only when its exact page title or alias is known; an omitted subject is
inferred when the text names exactly one entity page. Exact repeats come back
as duplicates, so it does not search first. Unmatched subjects are saved
unlinked, not guessed, and no page is created. Saving a preference does not configure the assistant or
guarantee its inclusion in future turns.

The flush never runs for CLI-backend sessions, including `claude-cli/*`. The
host skips it for CLI runtimes and for backends that own native compaction,
and the Claude CLI backend compacts internally without calling memory hooks.
For those sessions, the prompt's "before your final reply" save is the only
capture point.
The prompt excludes secrets and credentials, treats transcript content
as data, and performs no recall. The host's silent token completes a flush that
has nothing new to save.

The delegated audience determines the partition through the normal
`authorizeVault` path. Owner-private turns write under the agent-private
partition. Conversation turns write under that conversation's exact session UUID.
The flush grants no additional Knowledge authority.

During a host flush, `knowledge_save_page` and `knowledge_remember` may omit `requestId`. Knowledge derives
a lowercase UUIDv8 from SHA-256 of the host `flushId` and the NFKC-normalized,
lowercased title. The host keeps `flushId` stable across fallback and retry, so
an identical retry returns the original receipt. Reusing the same derived ID with
a changed payload reaches the normal payload-mismatch rejection. A caller-supplied
ID remains unchanged, and every save outside a flush requires one.

Workspace bootstrap files, reset hooks,
consolidation/dreaming, standing intents, standard Memory Core tools/CLI, and
file-oriented Memory UI are not replaced by this adapter. The Knowledge UI and
native Knowledge tools remain the rich inspection/mutation surfaces.

Offline tests establish contracts, scope isolation, concurrency, revision/cursor
fences and prompt capability branches. Fresh-session agent behavior and live
selected-provider hot reload require separate acceptance; test fixtures do not
prove extraction quality or complete remembering.
