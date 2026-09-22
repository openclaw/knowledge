# Explorer verification — 2026-09-22

Milestone: read-only synthetic vault explorer, not v1 completion or private-vault activation.

- `npm test`: nine tests cover read preservation, representative records/evidence, pagination/filtering, rename identity, unknown metadata, duplicate IDs, schema rejection/ambiguity, evidence tampering, unsafe paths, malformed YAML/scope, and scan budget refusal.
- `npm run check`, `npm run build`, `npm run validate`: passed.
- Live gateway `status` and `record` queries: valid shared-contract responses, writes disabled, sample clearly identified.
- Control UI: record selection, structured metadata, verified source excerpt/line locator, schema cards (eight effective, one invalid), six diagnostics, name/alias and kind filters, empty state, explicit refresh, browser reload/remount. No page errors during smoke checks.
- Initial live reload acknowledged the four additional read-only tools with `--accept-capabilities`; reload receipt reported `restartRequired: false`. Both connected Control UI clients reported activation.

Expected fixture snapshot: 11 envelope-valid records (7 fully valid), 8 effective schemas, 6 findings. The malformed record is preserved and diagnosed outside the typed catalog. The invalid schema is preserved outside the effective schema set.

No external ingestion, journaled writes, production access enforcement, automatic file watching, durable activity log, ranked retrieval, or recovery guarantees are claimed.
