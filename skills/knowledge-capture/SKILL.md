---
name: knowledge-capture
description: Save a short user-provided thought, idea, snippet, or note to the Knowledge vault with attribution and readback. For full documents or meeting transcripts use the corresponding ingestion workflow; do not replace host memory preferences.
---

# Capture a note

Read [shared conventions](references/conventions.md) and
[publication](references/publication.md).

1. Preserve the supplied wording, especially original ideas. Choose a concise
   title and an available page type (normally `note`; inspect its definition).
   Do not add unsupported facts or turn a tentative thought into established fact.
2. Check for an already-captured item. If the same source/text is already saved,
   report that page rather than create another. A similar thought is not proof
   of identity: keep genuinely distinct versions with attribution.
3. For a short inline thought, save the exact text via `source: {text,
   attribution}` and cite it in the body. Identify the speaker/context/date when
   known. Attach a supplied original file with `knowledge_attach` instead of
   treating a paraphrase as the original. User beliefs stay attributed to the user.
4. Publish using the shared retry rules, read back the body/evidence and check
   exact lookup or keyword discovery. Report the returned page and verified save
   state. Do not schedule reminders or execute commitments mentioned in the note.

Route a complete document to `knowledge-ingest`,
or a meeting to `knowledge-meeting-ingest`.
