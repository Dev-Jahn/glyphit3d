# glyphit3d — Claude Code project guide

glyph-constrained 3D renderer: 3D G-buffers → per-cell glyph+fg/bg via closed-form
two-color least squares. Design/theory in `DESIGN.md` (SSOT).

<!-- jahns-workflow:begin (managed block — edit via /jahns-workflow:init) -->
## Workflow (jahns-workflow)

- **SSOT**: `DESIGN.md` — binding but falsifiable. Read sections via `docs/ssot/INDEX.md`; never re-read the whole file; cite by §-anchor, never line numbers. If implementation evidence contradicts it: STOP, register a `decision/...` task, get a ruling, amend via ADR. Never silently comply or diverge.
- **Task registry**: every unit of work gets an ID `<type>/<kebab-slug>` (feat|fix|perf|gate|spike|decision|docs|chore) registered in `tasks.yaml` with an explanatory title BEFORE first use. Bare codenames (P0, E3, Q1…) are banned. `ROADMAP.md` is generated — never edit it.
- **Read & mutate the registry through the CLI, not raw** (it grows to thousands of lines): `jw task list [--status/--type/--milestone/--round]` and `jw task show <id>` to read; `jw task add <id> --title … [--severity/--deps/…]`, `jw task set <id> <field> <value>`, `jw task drop <id>` to mutate (validated, comment-preserving). Reading `tasks.yaml` whole is redirected here by a hook.
- **Severities** on review findings: blocker > major > minor (field, not ID). Blockers resolve before the next round.
- **Rounds**: close each work round with `/jahns-workflow:round` (updates registry, PROGRESS, roadmap, digest, review packet). Ingest external review replies with `/jahns-workflow:review`.
- Full convention: `docs/CONVENTIONS.md`.
<!-- jahns-workflow:end -->
