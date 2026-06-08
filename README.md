# TMB Plugin

> **Trust me bro, it works.**

**An agentic engineering harness for Claude Code — multi-agent orchestration, a persistent memory system, and guardrails enforced in code, not convention. MIT, free forever.**

TMB turns Claude Code into a production-grade agent harness. Three roles split the work — `bro` plans and gates, `swe` executes in an isolated worktree, and `pr-reviewer` signs off independently — backed by a two-tier memory system that carries state across context resets, with every commit clearing guardrails enforced in code, not by convention.

> **Claude Code today.** TMB ships the Claude Code adapter; Codex / Cursor / OpenCode / Gemini CLI placeholders exist — see [`docs/reference/MULTI_PLATFORM.md`](docs/reference/MULTI_PLATFORM.md).

---

## Who is TMB for?

**Any engineer shipping real production code with Claude Code — solo dev to large org.** Pure Claude Code is a brilliant code generator, but production work needs guarantees it doesn't give you: structural gates against agent drift, state that survives session resets, an auditable record of every decision, and role separation so the agent that writes code never signs off on it. Those matter **more** as the stakes rise, not less.

---

## Install

```bash
/plugin marketplace add trustmybot/marketplace
/plugin install tmb@trustmybot
```

Use `trustmybot/marketplace-rc` + `tmb@trustmybot-rc` for the beta channel (pre-promotion testing — tolerate occasional breakage). Pick one channel per CC install; to switch, `/plugin uninstall tmb` then add the other.

Refresh after upstream changes: `/plugin marketplace update trustmybot`.

---

## How to use

```
@bro write a todo cli
```

Saying `@bro` activates the persona for the rest of the session. First trigger in a project runs ~30s of silent onboarding (one shape question + 0–3 follow-ups). Code-touching asks route through bro → SWE → pr-reviewer at push time. Read-only asks are answered inline. Messages that don't address `@bro` are answered by regular Claude Code.

Walkthroughs: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md).

---

## Benchmarks

TMB resolves **8 / 8** hard SWE-bench tasks that pure Claude Code — and the published agentic harnesses — **fail**, with **zero hallucinated success claims**.

And it runs lean. On the same slate, against a raw Claude Code baseline (no plugin):

| | Raw Claude Code | **TMB** | Δ |
|---|---|---|---|
| Tokens | 15.87M | **6.97M** | **−56%** |
| Cost | $10.31 | **$6.98** | **−32%** |
| Wall-clock | 1890s | **1256s** | **−34%** |
| Hallucinations | 0 | 0 | — |

The world model — reasoning from a compressed repo graph instead of re-reading files — is what makes TMB cheaper than raw, not pricier.

Methodology, the published-comparator results, and per-task data: **[`docs/contributing/BENCHMARK.md`](docs/contributing/BENCHMARK.md)**.

---

## Why TMB

Four structural innovations, each closing a specific single-agent failure mode.

### 1. Agent Harness — planner and executor, kept apart

`bro` plans + gates (full picture, long-term). `swe` executes (single task, isolated worktree). **Bro never writes source; swe never self-approves.** Out-of-role calls are rejected at the wire. No more "the same context that wrote the code marks its own homework."

Details: [`CLAUDE.md`](CLAUDE.md), [`agents/swe.md`](agents/swe.md), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 2. Memory System — persistent state + long-context management

Two complementary memory tiers, both project-local and gitignored:
- **Trajectory store** (`trajectory.db`, SQLite) — *procedural memory*: issues, discussions, ADR decisions, task specs, validation verdicts, append-only audit. Survives context resets and session kills — bro rehydrates and resumes.
- **World model** (`world-model.kuzu`, kuzu graph + RAG) — *semantic memory + long-context management*: the codebase compressed into a navigable directory graph (README-derived summaries, parent/child edges), queried via `world_model_get` / `world_model_search`. The agent reasons from a small, stable map instead of re-ingesting the repo every turn — the context-engineering layer that keeps cold starts cheap and deterministic.

Refreshed by `/scan` + the post-task-close rescan.

Details: [`docs/architecture/ERD.md`](docs/architecture/ERD.md), [`docs/architecture/WORLD_MODEL.md`](docs/architecture/WORLD_MODEL.md).

### 3. Verification & Evaluation — auditable, gated quality control

**Two gates** close around every commit:
- **Bro's task gate** (per task) re-runs the spec's verification after SWE returns.
- **PR-reviewer's push gate** (per push) blocks `git push` until every commit has been signed off.

Verdicts persist in the DB next to the code they judged — six months later "why did we ship this commit?" is still queryable.

Details: [`docs/architecture/FLOWS.md` § Push gate](docs/architecture/FLOWS.md#6-push-gate-pr-review), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

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
