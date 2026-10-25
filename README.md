# TMB Plugin

<p align="center">
  <img src="docs/assets/tmb-hero.svg" width="640" alt="Animated pixel-art story. Coding agents call broken work done, forget everything, drift off task, need babysitting and delete your data. How can I trust my bot? With TMB, bro plans from a persistent memory (world model and trajectory DB) and splits work across swe agents, and code-reviewer rejects failures and gates every push to GitHub. Trust me bro, it works.">
</p>

> **Trust me bro, it works.**

**An agentic engineering harness for Claude Code — multi-agent orchestration, a persistent memory system, and guardrails enforced in code, not convention. MIT, free forever.**

TMB turns Claude Code into a production-grade agent harness. Three roles split the work — `bro` plans and gates, `swe` executes in an isolated worktree, and `pr-reviewer` signs off independently — backed by a two-tier memory system that carries state across context resets.

> **Claude Code is the complete workflow today.** Codex supports explicit local planning and can install two standalone project-level Agents for implementation and advisory review. It does not yet provide TMB task orchestration, trusted validation, Push gates, or lifecycle Hooks. Cursor / OpenCode / Gemini CLI remain placeholders. See [`CODEX.md`](CODEX.md) and [`docs/reference/MULTI_PLATFORM.md`](docs/reference/MULTI_PLATFORM.md).

---

## Who is TMB for?

**Any engineer shipping real production code with Claude Code — solo dev to large org.** Pure Claude Code is a brilliant code generator; TMB adds the guarantees production work needs: structural gates against agent drift, state that survives session resets, an auditable record of every decision, and role separation so the agent that writes code never signs off on it.

That structure earns its keep on **long-horizon, multi-task work** — a codebase you keep returning to, a slate of related changes, anything run unattended — and anywhere a wrong "it works" is expensive. For a single quick edit, raw Claude Code is leaner, and that's the right tool for the job.

---

## Install

Requires **Claude Code 2.1.295 or later** (`claude --version`): TMB registers its gates with `"onFailure": "block"`, which earlier versions ignore: there a gate that times out lets the action through.

From the project root:

```bash
claude plugin marketplace add trustmybot/marketplace --scope project
claude plugin install tmb@trustmybot --scope project
```

Install at project or local scope, never user scope; [INSTALL.md](docs/reference/INSTALL.md#recommended-scope-project-or-local) explains why and lists the update commands.

Use `trustmybot/marketplace-rc` + `tmb@trustmybot-rc` with `--scope local` for the rc channel (pre-promotion testing — tolerate occasional breakage). Pick one channel per CC install; to switch, run `claude plugin uninstall tmb@trustmybot --scope project` (or `claude plugin uninstall tmb@trustmybot-rc --scope local`), then add the other.

Refresh after upstream changes: `claude plugin marketplace update trustmybot`, then `claude plugin update tmb@trustmybot --scope project` (rc: `claude plugin marketplace update trustmybot-rc`, then `claude plugin update tmb@trustmybot-rc --scope local`).

---

## How to use

```
@bro write a todo cli
```

Saying `@bro` activates the persona for the rest of the session. First trigger in a project runs ~30s of silent onboarding (one shape question + 0–3 follow-ups). Code-touching asks route through bro → SWE → pr-reviewer at push time. Read-only asks are answered inline. Messages that don't address `@bro` are answered by regular Claude Code.

Walkthroughs: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md).

---

## Why TMB

Four structural innovations, each closing a specific single-agent failure mode.

### 1. Agent Harness — planner and executor, kept apart

`bro` plans + gates (full picture, long-term). `swe` executes (single task, isolated worktree). **Bro never writes source; swe never self-approves.** Out-of-role calls are rejected at the wire. No more "the same context that wrote the code marks its own homework."

Details: [`CLAUDE.md`](CLAUDE.md), [`agents/swe.md`](agents/swe.md), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 2. Memory System — persistent state + long-context management

Two complementary memory tiers, both project-local and gitignored:
- **Trajectory store** (`trajectory.db`, SQLite) — *procedural memory*: issues, discussions, ADR decisions, task specs, validation verdicts, append-only audit. Survives context resets and session kills — bro rehydrates and resumes.
- **World model** (`wm_` tables in `trajectory.db`, SQLite + FTS5 + embeddings) — *semantic memory + long-context management*: the codebase compressed into a navigable directory tree (README-derived summaries, parent/child links, one-line file purposes), queried via `world_model_get` / `world_model_search`. The agent reasons from a small, stable map instead of re-ingesting the repo every turn — the context-engineering layer that keeps cold starts cheap and deterministic.

Refreshed by `/scan` + the post-task-close rescan.

Details: [`docs/architecture/ERD.md`](docs/architecture/ERD.md), [`docs/architecture/WORLD_MODEL.md`](docs/architecture/WORLD_MODEL.md).

### 3. Verification & Evaluation — auditable, gated quality control

**Two gates** close around every commit:
- **Bro's task gate** (per task) re-runs the spec's verification after SWE returns.
- **PR-reviewer's push gate** (per push) blocks `git push` until every commit has been signed off.

Verdicts persist in the DB next to the code they judged — six months later "why did we ship this commit?" is still queryable.

Details: [`docs/architecture/FLOWS.md` § Push gate](docs/architecture/FLOWS.md#6-push-gate--pr-review), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 4. Agentic Orchestration — composable, not monolithic

Workflow shape scales by ask: simple task picks defaults inline; difficult task asks scope questions + captures ADR decisions; multi-task batch amortizes planning + fires the push gate once. Doctrine is wire-enforced, not aspirational.

Details: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md).

---

## Roster on disk

The plugin ships a **layered agent model**. Bro is a CLAUDE.md persona. Two backbone subagents (`swe`, `pr-reviewer`) ship globally in `agents/` and are available in every project the moment the plugin is installed — no copy step required. Consultant agents are templates that get copied into `<project>/.claude/agents/` on demand:

| Agent | Where | When available |
|---|---|---|
| `swe.md` | `agents/swe.md` (global) | Always — backbone executor |
| `pr-reviewer.md` | `agents/pr-reviewer.md` (global) | Always — push gate |
| `architect.md`, `cto.md`, `ceo.md`, `pm.md` | `templates/agents/` (copied on demand) | First time you ask for that consultant |

Domain consultants outside this set are drafted on demand via `/tmb:agent-create`. Override any agent by dropping a project-local file — local wins over the global.

---

## Support · Contributing · License

**Like bro?** Star ⭐ or fork the repo — it helps others find TMB.

**Support:** [Sponsor on GitHub](https://github.com/sponsors/trustmybot) keeps it maintained.

**Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) for workflow + tests. Start with [`CLAUDE.md`](CLAUDE.md) (bro persona), [`docs/architecture/RESPONSIBILITIES.md`](docs/architecture/RESPONSIBILITIES.md) (per-agent contract), [`docs/architecture/ERD.md`](docs/architecture/ERD.md) (schema).

```bash
bash tests/run-all.sh
```

**License:** MIT. Fork it, ship it, sell it. Credit nice but not required.
