# Agents architecture

How the plugin's agent set is layered, distributed, and overridden. Reference doc — bro reads this on demand, not on every turn.

## Two layers

### Layer 1 — Workflow backbone (always global)

`swe.md` and `pr-reviewer.md` ship in the plugin's `agents/` directory and are **always available**. No copy step, no onboarding wait — they work in any project the moment the plugin is installed.

| Agent | Role | Override |
|---|---|---|
| `swe.md` | Executor — one task per spawn, isolated worktree, atomic close | Drop a project-local `<project>/.claude/agents/swe.md` to override |
| `pr-reviewer.md` | Push gate — runs at `git push` over a batch of unsigned tasks | Drop a project-local `<project>/.claude/agents/pr-reviewer.md` to override |

**Resolution rule:** when bro spawns `swe` or `pr-reviewer`, CC dispatches by name — local wins if present, global serves as fallback. The global prompts are deliberately the smallest sufficient prompt for general work; projects with specific demands (medical-device review checklists, finance-compliance gates, etc.) drop in a custom local file that overrides only what they need.

**Local creation triggers:** bro creates a project-local agent only if (a) the Human explicitly asks for one, OR (b) bro determines the global default genuinely doesn't fit the project's tasks. Both cases route through `tmb_agent-creator` with explicit Human approval. The global file is **never edited** — overrides are additive at the project level.

### Layer 2 — Consultants (templates, opt-in per project)

`architect`, `cto`, `ceo`, `pm` ship in `templates/agents/` and are **only** instantiated when the Human asks for that consultant's read on something. First ask in a project triggers `tmb_agent-creator` template-copy mode → copies the template into `<project>/.claude/agents/<name>.md` → spawns it. From then on, the project-local copy serves the consultant.

| Template | Spawned when |
|---|---|
| `architect.md` | Human asks `@bro get the architect's read on X` |
| `cto.md` | Human asks for cto opinion |
| `ceo.md` | Human asks for ceo opinion |
| `pm.md` | Human asks for pm opinion |

User-created project consultants (via `tmb_agent-creator` from-scratch flow) follow the same pattern.

## Composition rule (three layers, never confused)

- **Agent file = identity** — immutable for global; project-local overrides allowed for backbone, project-local creation required for consultants.
- **`skills:` array = capabilities** — additive via `tmb_skill-creator`; same agent grows new capabilities by attaching skills.
- **Spawn prompt = task context** — per-call; the message bro sends when invoking `Task(subagent_type=..., prompt=...)`.

Never confuse layers: a "more skilled SWE" means swe.md plus added skills, not a different swe.md.

## Default skills (always global)

`skills/` holds both the `tmb_*` protocol skills (immutable, reserved by plugin) AND the default workflow skills used by global agents:

- `swe-checklist`
- `code-quality`
- `docs-conventions`
- `git-conventions`
- `naming-conventions`
- `review-protocol`
- `review-findings`

All are globally discoverable. Project-local `<project>/.claude/skills/<name>/SKILL.md` overrides by name. Onboarding does NOT copy skills into projects — the global ones serve every project until a customization is needed.
