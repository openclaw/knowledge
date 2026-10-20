# Knowledge in this conversation

The Knowledge chat panel shows compact, clickable cards for records found, read,
and changed by the agent in that conversation. Each card shows the page title,
action and time; revision numbers stay out of the activity view. Open **Knowledge**
from the host's side-panel controls; there is no extra chat-header action. Use the
header icons to filter All / Reads / Writes, toggle chronological order,
load earlier entries, and select a record for a read-only preview. **Open full
page** uses the existing scoped URL and preserves modified-click browser behavior.

## Recording and scope

- Provenance comes only from host tool context: agent, canonical session key,
  session incarnation UUID, and tool-call ID. No tool payload can set these.
- Every newly accepted publication captures that provenance in its recovery plan.
  Publication inserts one write event per affected record in the same SQLite
  transaction as history and the receipt. Retries do not duplicate events; recovery
  by a different session retains the original session. Old plans still recover.
- Successful record, exact lookup, keyword search, record-list and connection
  results record the actual returned record identities/revisions, best effort.
  Search/list entries are labeled Found/Listed rather than implying a full-body read.
  Logging does not modify Markdown, revision numbers, Git, or the publication
  generation. Logging failure does not fail a read; live authority failure does.
- Operator inspection (including panel previews) never counts as agent activity.
  Automatic provider projections, evidence byte downloads, and revision-history
  reads are not yet tracked. This is not a comprehensive security audit log.
- Events live in the existing store's operational SQLite database. They are not
  reconstructible from vault Markdown or Git. Include operational state in backups.
  No legacy-session backfill, retention pruning, or cross-session inference occurs.
- The operator-only `session_activity` query uses normal store membership and
  private-partition authority. It cannot be used by model tools. The panel currently
  inspects private-store activity; conversation-partition/group activity is not
  exposed through an operator impersonation workaround. It filters by agent,
  session key AND incarnation so session resets cannot mix activity.
- Current record eligibility is applied before pagination. Withdrawn, removed,
  fixture and dependency-hidden records are not exposed, including old titles.
  A preview shows current content, not the historical revision captured by the event.

## Ordering and lifecycle

Activity has a monotonic database sequence, host invocation timestamp and tool-call
ID. The default is newest first; Oldest first reverses the loaded window. Load
more to inspect earlier windows. Cursor pages pin an upper sequence so new events
do not duplicate or skip entries. Reopening the panel starts at the latest window.
Ten-second polling runs only while presented, visible, connected, and on the newest
window; browsing earlier activity is not collapsed by background refresh. Vault
change hints are coalesced like the explorer's (see MODEL_API.md, Live state).
Ordinary host render updates do not refetch activity. Reopening the panel does.
Updates are automatic; there is no manual Refresh control. Inline previews and
full-page navigation are unchanged.

Session/scope changes fence pending results and clear previews. Reconnect refreshes
from durable state; disposal removes timers/subscriptions. Titles use text nodes;
body previews share the existing sanitized Markdown renderer.

## Host boundary and design choices

Uses public `registerPanel`, session roster, navigation,
and feature-contract APIs. No DOM interception, workspace replacement or host changes.
The existing plugin/session APIs are adequate; gbrain has session context tracking
but not this native OpenClaw panel/publication boundary, so its separate context-pack
session database is not imported.

Transcript scroll-following is not implemented: there is no supported visible-
transcript-position subscription in the inspected SDK. Tool-call IDs are retained
for a future host-supported jump/alignment API; do not label them transcript ordinals.
Click-to-open Knowledge links in chat remain the separately documented record-panel
proposal. Ordinary citations still open the dedicated Knowledge page.

## Verification

`test/session-activity.test.mjs` covers publication recovery, durable reads, replay,
reset and scope separation, current eligibility, cursor paging and fail-open logging.
`test/browser/session-activity.mjs` uses an isolated real service/store and verifies
filters, order, preview, scoped links, a late-response session switch, reconnect,
cleanup, narrow-width overflow, host rerender suppression, reopening, and
retained cards during polling. No synthetic records are written to the live vault.
