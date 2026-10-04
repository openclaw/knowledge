# Temporal retrieval and Chronicle

Knowledge projects validated structured dates and entity associations into scoped SQLite tables. Markdown/frontmatter stays authoritative. Each Chronicle read reconciles its authorized source snapshot inside the existing storage identity/authority fence. Publication is immediately readable; the next temporal read updates the projection. External edits use the existing scan path. No new watcher, scheduler or model call is required.

## Date meanings and ranges

- occurred_at: event/assertion occurrence. Meeting pages use fields.occurred_at; claims use occurred_at.
- recorded_at: record creation in Knowledge.
- updated_at: authored modification timestamp, not a complete external-file observation log.
- due_at: commitment deadline, never a scheduled action.

Unknown dates stay absent; recording time never substitutes for occurrence. Search and inventory accept timeField (default occurred_at), since and until. Bounds accept real YYYY-MM-DD or ISO timestamps with seconds and explicit timezone. The host resolves relative dates. Bounds are inclusive; a date-only upper bound includes the full UTC day. Date-only records match overlapping ranges without asserting an exact instant. Results preserve authored values and day/instant precision.

## Operations

- knowledge_timeline: dated records, optionally filtered by entity ID, kind (claim kind or page type), timeField, since/until, order, eligibility and includeSources.
- knowledge_chronicle_day: day or its Monday–Sunday week. Timestamp calendar days use the requested IANA timezone (UTC default); date-only values stay on their authored day.
- knowledge_chronicle_since: occurrence-time range, oldest first; not recently imported knowledge.
- knowledge_chronicle_last_seen: latest dated context involving an entity at/before occurredOnOrBefore (now default). A mention does not prove attendance or contact; no match does not prove absence.
- knowledge_grep and knowledge_records: timeField/since/until filters before ranking, counts and pagination.

For newly recorded/updated records without keywords, query timeline with the respective timeField. This is a current-record query, not a durable change cursor. History/recent remain the operational audit. Ordering uses date values and stable IDs; date-only versus instant ordering is not an inferred causal sequence.

## Events and provenance

One shared event claim references the relevant entities, source_page, evidence and source dependency. source_event=true identifies only the source meeting itself. On occurrence timelines its matching date row replaces the source page when both are candidates; other dated assertions from that meeting stay separate. A kind=meeting query still returns the meeting page. Entity filters use explicit entities/owner/endpoints/source associations, not Markdown co-mentions.

Human-readable Timeline sections remain contextual prose. Dates in those bullets do not create structured records. Unlike gbrain's Markdown parser, this first pass uses Knowledge's independently identified, evidenced claims and does not invent another event identity. Inconsistent source-event dates are not silently repaired.

Results contain record ID/path/revision/hash, original date and precision, bounded text, visible entity/source IDs and evidence counts. Read the record with includeEvidence=true for source verification.

## Eligibility and consistency

Default results include current eligible records. eligibility="include_inactive" includes eligible superseded/expired assertions and dependencies, never withdrawn records. This is not a historical snapshot of what the system knew. Fixture, invalid, ambiguous and unavailable-dependency records are excluded before indexing/counts. Host authority and store binding apply throughout; model selectors cannot grant access.

Follow nextOffset with unchanged filters and the returned snapshot, which binds authorized records and query parameters. Changed content/query requires restarting. Row/byte limits bound responses. Coverage reports validation issues and omission of undated/Markdown-only events. Invalid bounds/timezones and unavailable indexes fail explicitly.

SQLite temporal_records_v1 tracks record hashes; temporal_dates_v1 stores authored date values plus query-only interval bounds; temporal_entities_v1 indexes associations. Reconciliation and selection share a transaction. Missing tables trigger rebuilds. Removed/changed records clear old derived rows. No new dependencies are required. Operational mutation history and withdrawal safeguards are NOT rebuildable projection state.

## Reference and limits

Reference: gbrain 739e5cc89 core/effective-date.ts, engine-sql/timeline.ts, ops/chronicle.ts and persistence/canonical-projections.ts. Borrow chronological operations and separation of world/storage time while retaining Knowledge record/evidence/access contracts. This pass does not add free-prose extraction, anniversary queries, recency ranking, trajectory analytics, validity-at snapshots, durable delta cursors or dreaming.

Tests: test/chronicle.test.mjs covers late imports, range precision, timezone/day/week, shared-event grouping, scope/lifecycle, edits, pagination, rebuilds and normal publication. Live Granola ingestion is a separate semantic acceptance test.

## Compact source context and freshness

Set includeSources=true to include deduplicated source summaries for the returned
page. Summary bytes share the 24 KiB budget with items; follow actual nextOffset
and snapshot. Summaries carry identity, title, type, revision/hash and lifecycle,
not source bodies. A page item without source_page represents its own source.
Temporal references expose lifecycle, an accessible supersededBy when present,
and expiresAt when set. Association is not attendance evidence.

Last-seen returns selection.timeField=occurred_at, selection.onOrBefore and
selection.eligibility. The input occurredOnOrBefore bounds occurrence, not when
Knowledge learned the fact. eligibility defaults to current. Removed inputs asOf
and historical are rejected; no aliases are provided on temporal tools.

Query outputs report freshness.queriedAt (query execution), scannedAt (validated
source scan, reused while unchanged), and indexedAt for keyword reconciliation.
An older scannedAt is not evidence of stale results. Temporal snapshot tokens
bind filters, source projection and eligible corpus; compare only while continuing
the same query. A new query or eligibility selection can have a different token.
