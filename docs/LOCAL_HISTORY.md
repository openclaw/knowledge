# Automatic local Git history

## Policy

Local Git is used by default whenever installed. There is no additional Git opt-in. With vault writes enabled, the first content checkpoint initializes `<vault-root>/.git` if absent; an existing repository at that exact root is reused. An enclosing repository is never adopted. Sample/read-only mode leaves Git untouched. An empty writable vault initializes its repository when the first content arrives.

GitHub, repository hosting, remote configuration, fetch/pull/push, and synchronization are not implemented. No credentials or network access are needed for local history.

## One storage owner

`KnowledgeStorage` owns the configured vault's reads, observations, publication journal, SQLite adapter and Git adapter. Feature handlers only authorize and delegate. Short-lived SQLite connections remain encapsulated in this stateful service; durable work survives service replacement.

A publication follows:

1. Validate and journal intent; publish the page and any retained evidence with the existing recoverable protocol.
2. In the transaction acknowledging publication, enqueue the exact changed portable bytes in SQLite.
3. Checkpoint that whole batch with native Git and record the commit in the receipt.

The queue is an outbox, not a second authoritative knowledge store. Markdown stays authoritative. The exact snapshots are retained so a Git outage followed by more edits cannot erase intermediate versions. The current page API groups a page and its supplied source artifact; it does not yet expose arbitrary multi-page publication. The Git adapter accepts multi-file batches, also used for external observations.

A failed Git step does **not** roll back publication or change `published` to `conflict`. Receipt `git.state` is `committed`, `pending`, or `unavailable`; `git.commit` is present on success. Activity & issues displays these separately, with a retry control. `knowledge_resume` retries the original publication's history; normal authorized scans retry waiting batches. A missing executable is retried on later operations, so installing Git does not require a configuration change. No background retry timer is installed.

## Commit contents and forensic meaning

- Each successful publication gets one commit containing exactly its page/artifact batch.
- First observation baselines eligible Markdown and YAML in the caller's authorized partition. Later scans group observed external edits, renames and deletions into one checkpoint. Verified referenced text evidence is included; originals are retained when references disappear. Unsafe files are never followed. Intermediate external edits between scans cannot be reconstructed; no watcher is installed.
- Existing unrelated working-tree edits and staged content are not swept into a publication commit. External Markdown in the same scope is checkpointed separately during observation, not attributed to the publishing agent.
- The adapter writes exact blobs from retained snapshots, with isolated staging. It synchronizes only previously unstaged paths into the working index, preserving staged bytes including same-path staged edits. It never checks out, resets or overwrites working files. This still requires one publishing instance per vault; finish manual merges/rebases before automatic history can continue.
- Commits identify the Knowledge service as committer and label the actor (`agent`, `operator`, or external observation) and durable checkpoint token. Agent/operator labels are coarse provenance, not cryptographically authenticated person identities. Scoped receipts map publication request IDs to commits.
- The branch and a durable `refs/knowledge/checkpoints/<token>` reference advance atomically. A crash after Git succeeds but before SQLite acknowledges can discover that reference and finish without another commit. Concurrent ref updates are compare-and-set; failures stay queued.
- Git hooks, clean/smudge filters, signing and network commands are not used. User/global Git configuration is not changed. Existing local exclude rules are preserved while adding recovery-state exclusions. A fallback service author works without user Git identity configuration.

## Boundaries and recovery

SQLite lives outside the vault. `.knowledge-history/` recovery files and the operational `vault.json` manifest are not added to commits; local excludes prevent accidental new staging. Files already tracked by an existing repository are not removed from it. Local Git is content history, not a full operational backup. Retain vault identity, SQLite and artifacts coherently as described in the recovery contract.

Repository errors are not treated as “Git absent.” Permissions, locks, detached HEAD, linked/worktree `.git` files, malformed repositories and active merges can leave visible pending checkpoints. Resolve the repository issue and retry. A lock left by a killed Git/index operation is not automatically removed as someone else may own it. History files and refs must be retained; deleting/replacing `.git` is not an automatic history restoration workflow.

The repository covers the whole physical vault. Plugin results, queue processing and counts are scoped, but filesystem access to `.git` can inspect all previously committed scopes. This matches the vault's existing filesystem trust boundary. Do not distribute the repository as though plugin access checks filter its contents.

## Existing-solution decision

The user's 2026-09-23 direction supersedes the former scope rule leaving commits to external tools. Native Git already supplies blobs, trees, per-file history, atomic ref updates and crash-safe object storage. Use its CLI rather than adding a Git implementation/library, GitHub dependency or custom synchronization engine. SQLite's existing operational journal supplies the cross-store retry boundary; Git is not substituted for publication recovery.

References: [Git commit-tree](https://git-scm.com/docs/git-commit-tree), [Git update-ref](https://git-scm.com/docs/git-update-ref), and [Git update-index](https://git-scm.com/docs/git-update-index).
