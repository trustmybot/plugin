# Agents architecture

How the plugin's agent set is layered, distributed, and overridden. Reference doc — bro reads this on demand, not on every turn.

The canonical registry for all known agents is the SQLite `agents` table in the trajectory DB. It is seeded at DB init with the two backbone agents (`swe`, `pr-reviewer`) and the four shipped consultant templates (`architect`, `cto`, `ceo`, `pm`). Use `agent_list` to query it and `agent_register` to add project-local agents. This doc is the prose explainer of the architecture; the DB is the runtime source of truth.

## Two layers

### Layer 1 — Workflow backbone (always global)

`swe.md` and `pr-reviewer.md` ship in the plugin's `agents/` directory and are **always available**. No copy step, no onboarding wait — they work in any project the moment the plugin is installed.

| Agent | Role | Override |
|---|---|---|
| `swe.md` | Executor — one task per spawn, isolated worktree, atomic close | Drop a project-local `<project>/.claude/agents/swe.md` to override |
| `pr-reviewer.md` | Push gate — runs at `git push` over a batch of unsigned tasks | Drop a project-local `<project>/.claude/agents/pr-reviewer.md` to override |

**Resolution rule:** when bro spawns `swe` or `pr-reviewer`, CC dispatches by name — local wins if present, global serves as fallback. The global prompts are deliberately the smallest sufficient prompt for general work; projects with specific demands (medical-device review checklists, finance-compliance gates, etc.) drop in a custom local file that overrides only what they need.

**Canonical override creation path:** use `/tmb:agent-create` Template-copy mode — the user is asked to confirm, and the copy is verbatim from `plugin/templates/agents/<name>.md`. After copy, the user can extend by attaching skills (`tmb_skill-creator`) or hand-editing the local file.

**Defense-in-depth:** an optional L1 lint (`tests/lint/local-agent-primitives.sh`, #106) catches hand-edits that accidentally drop critical workflow primitives.

**Local creation triggers:** bro creates a project-local agent only if (a) the Human explicitly asks for one, OR (b) bro determines the global default genuinely doesn't fit the project's tasks. Both cases route through `/tmb:agent-create` with explicit Human approval. The global file is **never edited** — overrides are additive at the project level.

### Layer 2 — Consultants (templates, opt-in per project)

`architect`, `cto`, `ceo`, `pm` ship in `templates/agents/` and are **only** instantiated when the Human asks for that consultant's read on something. First ask in a project triggers `/tmb:agent-create` template-copy mode → copies the template into `<project>/.claude/agents/<name>.md` → spawns it. From then on, the project-local copy serves the consultant.

| Template | Spawned when |
|---|---|
| `architect.md` | Human asks `@bro get the architect's read on X` |
| `cto.md` | Human asks for cto opinion |
| `ceo.md` | Human asks for ceo opinion |
| `pm.md` | Human asks for pm opinion |

> **Note:** `swe` and `pr-reviewer` also ship as templates at `plugin/templates/agents/` in addition to their live globals at `plugin/agents/`. Byte-identity between the two is enforced by the `agent-template-byte-identity.sh` lint (#104). This means Template-copy mode for override creation always produces an exact-match starting point.

User-created project consultants (via `/tmb:agent-create` from-scratch flow) follow the same pattern.

## Agent ownership states

Every agent file in `<project>/.claude/agents/` is in one of three ownership states, declared via the `tmb_owner` field in YAML frontmatter. `tmb_owner` is a frontmatter-only convention (read by `/tmb:agent-create` from the file at decision time); it is not persisted to the agents DB table.

| Marker | Meaning | Plugin behavior |
|---|---|---|
| `tmb_owner: bro` | Plugin-managed | `/tmb:agent-create` may update freely. User hand-edits will be overwritten on next plugin update. |
| `tmb_owner: user-adopted` | User-authored, opted in for plugin management | `/tmb:agent-create` may update. Initial content was preserved at adoption time. |
| (no field) | User-owned | Plugin never touches. Resolution rule still applies (local file wins over shipped templates). |

### Adopting an existing agent

If you've hand-rolled `.claude/agents/<name>.md` and want bro to manage it going forward, run `/tmb:agent-create` with the same name. The collision dialog offers an "Adopt + manage" option that preserves your content and adds `tmb_owner: user-adopted` to the frontmatter.

### Plugin-shipped agents

The plugin's globally-shipped agents (`agents/swe.md`, `agents/pr-reviewer.md`) and consultant templates (`templates/agents/{architect,cto,ceo,pm,swe,pr-reviewer}.md`) all carry `tmb_owner: bro` for convention consistency. The `agent-tmb-owner-frontmatter` L1 lint enforces this.

## Composition rule (three layers, never confused)

- **Agent file = identity** — immutable for global; project-local overrides allowed for backbone, project-local creation required for consultants.
- **`skills:` array = capabilities** — additive via `tmb_skill-creator`; same agent grows new capabilities by attaching skills.
- **Spawn prompt = task context** — per-call; the message bro sends when invoking `Task(subagent_type=..., prompt=...)`.

Never confuse layers: a "more skilled SWE" means swe.md plus added skills, not a different swe.md.

## Default skills (always global)

`skills/` holds both the `tmb_*` protocol skills (immutable, reserved by plugin) AND the default workflow skills used by global agents:

- `tmb_swe-checklist` (SWE)
- `tmb_review` (pr-reviewer)
- `tmb_docs-conventions` (SWE — prompt-editing discipline)

Reference content used by these skills lives at
`docs/contributing/CODE_QUALITY.md` (qualitative criteria) and
`docs/contributing/REVIEW_FINDINGS.md` (living patterns catalogue) — read,
not auto-loaded.

All shipped skills are globally discoverable. Project-local
`<project>/.claude/skills/<name>/SKILL.md` overrides by name. Onboarding
does not copy skills into projects — the global ones serve every project
until a customization is needed.

Naming, git, and code-quality conventions are enforced deterministically by hooks
(`scripts/hooks/naming-lint.sh`, `scripts/hooks/commit-msg-lint.sh`,
`scripts/hooks/code-quality-lint.sh`) — the authoritative enforcement layer.

## Slash commands

The plugin ships explicit-trigger slash commands that wrap skills:

- `/roundtable <topic>` → runs the roundtable ceremony defined in `commands/roundtable.md`
- `/monitor <PR_number>` → invokes `tmb_review` skill (PR comment triage section)

Runtime location: `plugin/commands/<name>.md`. Public design docs: `plugin/docs/commands/<name>.md`. Catalog index: `plugin/docs/commands/README.md`. L1 lint: `tests/lint/command-frontmatter.sh`.

## pr-reviewer MCP availability self-test (#97)

The pr-reviewer subagent's first output line is `MCP available: yes` or `MCP available: no — honor-system fallback`. Bro greps the announcement to route validation recording deterministically. Detail in `agents/pr-reviewer.md`.
