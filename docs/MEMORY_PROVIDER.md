# Knowledge as a memory provider

This branch targets OpenClaw's unreleased provider-neutral Memory Runtime V2.
It uses the public `openclaw/plugin-sdk/memory-host-search` contract, not host
internals. The local development dependency points at `../openclaw-memory-runtime`;
this is a branch integration requirement, not a claim about a published release.
Build that checkout's SDK declarations before `npm run check` / `npm run build`.
Older hosts without `getActiveMemoryProvider` are rejected at registration.
The package's existing peer range is not sufficient to establish V2 support.

## Ownership and activation

`openclaw.plugin.json` declares `kind: memory`. The host must select `knowledge`
for `plugins.slots.memory` and enable/configure the plugin to activate this branch.
An unselected memory plugin can be disabled by the host slot gate; this branch
is not a simultaneous standalone companion mode. Its existing native tools,
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
  embeddings. Scores are query-local. Source constraints never cause a search
  of transcripts; a mixed request reports partial coverage, and session-only
  requests fail explicitly. Curated project-key requests are unsupported.
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
- Health reports scoped vault/ontology validation; it does not invent embedding
  health or claim keyword-index readiness before a search.

Operator reads require a current host capability, connection ID, read/write/admin
scope, configured agent, and `operatorRead`. Session reads require current host
session authority, session incarnation, and latest matching session metadata.
Owner-direct sessions and their host-authorized spawned descendants read
agent-private records. Other recognized chats and their spawned descendants read
the originating parent's exact conversation partition. Spawn inheritance uses
host-stamped parent incarnation and sender authority, never the worker's launch
owner bit; stale or incomplete lineage fails closed. The same session-scope
resolver and ancestor revalidation serve native tools. Host/background and
sandboxed shared calls are denied rather than
reconstructed as owner tool calls. Some host consumers lack sufficient authority;
registering V2 does not make those consumers work automatically.

## Prompt and lifecycle boundaries

The selected-provider prompt routes recall to lookup/search/read and procedures
to the six shipped skills. It enables selective ordinary-turn remembering, not
post-turn extraction. Write-disabled vaults and missing tools omit save guidance;
sample mode emits no memory prompt and cannot supply memory records. Citation-off
mode is explicit. The host exposes tools but no enabled-skill inventory, so skill
references are conditional on availability and associated tools, not a guarantee
that disabled skills were delivered.

No trigger/project candidates or automatic-injection eligibility are advertised.
Keyword search is not a trusted-instruction selection mechanism. No pre-compaction
save plan is supplied; an explicit null resolver prevents a Memory Core sidecar
from donating its file flush plan. Workspace bootstrap files, reset hooks,
consolidation/dreaming, standing intents, standard Memory Core tools/CLI, and
file-oriented Memory UI are not replaced by this adapter. The Knowledge UI and
native Knowledge tools remain the rich inspection/mutation surfaces.

Offline tests establish contracts, scope isolation, concurrency, revision/cursor
fences and prompt capability branches. Fresh-session agent behavior and live
selected-provider hot reload require separate acceptance; test fixtures do not
prove extraction quality or complete remembering.
