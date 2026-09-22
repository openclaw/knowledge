# Filing resolver

1. A human has one page in `people/`.
2. An organization has one page in `organizations/`.
3. An initiative or workstream has one project in `projects/`; status is independent of lifecycle.
4. A meeting belongs in `meetings/`; its claims and relationships reference it rather than copying a timeline.
5. A general idea belongs in `concepts/`; other authored notes belong in `notes/`.
6. Independently attributed claims belong in `claims/`.
7. Explicit directed relationships belong in `relationships/`.
8. Retained sample originals belong in `artifacts/`; declarative definitions belong in `schemas/`.

Stable IDs, not paths or names, establish identity. Renaming a file must not change its ID.
