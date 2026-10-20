# Maintenance and relink

Knowledge runs one small, scheduled maintenance pass. Its only job today is
**relink**: link claims that `knowledge_remember` saved without a subject to the
one entity page they name. Relink never calls a model, never creates pages or
stores, and never changes claim text, evidence or lifecycle.

## Relink

A claim qualifies when it is an active, valid claim with no linked entities and
its evidence includes a retained `knowledge_remember` excerpt
(`artifacts/<request>/excerpt.txt`). Each one gets one of three outcomes, in
stable ID order:

| Outcome | Rule |
|---|---|
| `linked` (tier `page`) | The claim's recorded `source_page` is an active entity page. |
| `linked` (tier `mention`) | The claim's text names exactly one entity page by ID, title or alias, with no competing name. This is the same inference `knowledge_remember` uses. |
| `ambiguous` / `no_subject` | Anything else. The claim stays unlinked; nothing is guessed. |

A link is an `entities` annotation on the claim, published through the normal
journal, receipt and local Git path. Each link's request ID is derived from the
claim ID, revision and subject, so an interrupted pass replays its publication
instead of duplicating it. A link that cannot publish, because of a conflict or
a changed record, counts as `failed` and is retried on the next pass.

### On demand: `knowledge_relink`

Agents can run relink in their authorized scope. Publishing links needs writes
enabled; with writes disabled, the memory prompt does not offer the tool.

- `dryRun: true` reports counts and up to 10 examples per outcome without
  publishing. Run it first.
- `limit` (1–500, default 100) bounds how many unlinked claims one call examines.
- Follow `nextCursor` with the same `dryRun` value until it is `null`.

## Scheduled pass

The pass is **on by default**. With no configuration it runs daily at 03:30 in
the Gateway host's time zone, using the host's plugin service scheduler. It is
not an OpenClaw automation and does not appear on the Automations page. It runs
only while `writesEnabled` is true (also the default).

```json5
// plugins.entries.knowledge.config
{
  maintenance: {
    enabled: true,           // false turns the pass off
    schedule: "30 3 * * *",  // five-field cron: minute hour day month weekday
    timezone: "America/Los_Angeles" // IANA zone; default: Gateway host zone
  }
}
```

An invalid schedule or time zone does not disable the plugin. The pass is not
scheduled, a warning is logged, and Settings shows the error.

Each pass visits every store the operator has defined, and every conversation
partition inside it, in 500-claim pages. Stores that are not created yet, or not
ready, are skipped and never created. One failing store does not stop the
others. A plugin reload or store reassignment ends the pass. Runtimes started
only for maintenance are released afterwards.

The next slot and the last pass's results persist in
`<state dir>/knowledge/maintenance.json`. If a slot passes while the Gateway is
down, the pass catches up 60 seconds after the next start. The pass never runs
twice at once.

## Inspecting it

**Settings → Maintenance** in the Knowledge page shows the schedule, the next
run, the last run and each store's counts. The same data comes from the
`maintenance_status` operation, which is limited to operator sessions with
`operator.read` or higher and requires `operatorRead` (default on):

```sh
openclaw gateway call plugins.sessionAction --params '{"pluginId":"knowledge","actionId":"maintenance_status","payload":{}}' --json
```

Each pass also logs one summary line, as a warning if any store failed.

## Relationship to gbrain

Relink is adapted from gbrain's `src/core/facts/relink.ts` (commit
`e45f13f052c06e6f92b4e31204e34edc0634b9da`); see `THIRD_PARTY_NOTICES.md`.
Knowledge keeps gbrain's free `page` and `mention` tiers and departs in two
ways:

- **No model tier.** gbrain can ask a model to pick a subject, under a USD cap.
  Knowledge stays zero-LLM, so an unresolved claim stays unlinked rather than
  receiving a model guess without evidence.
- **Scheduled, not only on demand.** gbrain runs relink as a command. Knowledge
  also runs it on a schedule, because `knowledge_remember` saves claims
  unlinked by design and nobody runs a manual relink after every conversation.
