# Knowledge

Build a native OpenClaw feature plugin. Control UI is the primary interface; Markdown is the future authoritative vault format.

- Follow docs/KNOWLEDGE_SCOPE.md for scope and docs/KNOWLEDGE_SPEC.md for contracts.
- Resolve open design decisions from gbrain first; record concrete reasons for departures.
- Keep ingestion skills aligned with gbrain wherever possible; depart only for Knowledge tool/semantic or host-authority differences, documented in docs/WORKFLOWS.md. Workflow progress belongs to the agent, not a new ingestion subsystem.
- Use supported OpenClaw SDK surfaces and the existing feature-plugin build/reload commands.
- Keep UI and agent operations on the same typed backend contract.
- Do not imply that unimplemented vault, retrieval, or write capabilities exist.
- Verify the running gateway before installing or reloading; merge existing configuration.
- Run npm run check, npm run build, and npm run validate for changes to this foundation.
