# TMB Plugin

> **Trust me bro, it works.**

**Multi-agent engineering workflow for Claude Code. MIT, free forever.**

TMB turns Claude Code from a clever code-generator into a disciplined engineering workflow: one Human entry point (`bro`), a separate executor (`swe`), state that survives session kills, and structural gates that close around every commit.

> **Claude Code today.** v0.6.0 ships the Claude Code adapter only. Codex / Cursor / OpenCode / Gemini CLI placeholders exist — see [`docs/MULTI_PLATFORM.md`](docs/MULTI_PLATFORM.md).

---

## Who is TMB for?

**Solo devs and small teams running Claude Code on real production code.** If you want structural gates against agent drift, state that persists across sessions, and a doctrine for multi-agent deliberation — you're the target. TMB stays dormant until you address `@bro`; every other workflow keeps working.

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

TMB resolved **8 of 8** SWE-bench tasks (4 Verified + 4 Lite) where pure Claude 4 Opus and pure Claude 4 Sonnet — using their official Anthropic-published agentic harnesses — **failed**. Same model snapshots, different orchestration. **Zero hallucinated success claims.**

| Corpus | TMB-on | Comparator | Comparator score on these tasks |
|---|---|---|---|
| **SWE-bench Verified** (4 tasks, same `claude-opus-4-20250514`) | **4 / 4** ✅ | Anthropic [`tools_claude-4-opus`](https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20250522_tools_claude-4-opus) | 0 / 4 |
| **SWE-bench Lite** (4 tasks) | **4 / 4** ✅ | 3 published Sonnet 4 harnesses (SWE-agent, KGCompass, ExpeRepair-v1) | 0 / 4 each |
| **Hallucinations** | **0 / 8** | (not measured) | — |
| **Total spend** | $17.33, ~17.7M tokens | — | — |

Curated-hard subsets from the all-comparators-failed intersection. Methodology, fairness, per-task data: **[`docs/BENCHMARK.md`](docs/BENCHMARK.md)**.

> **The shape of the tradeoff.** Token + time data isn't published per-task by the public comparators, so we measured it locally with a same-model raw baseline (Claude Code, no plugin). On tasks where both can resolve: TMB pays **~+60% cost / ~+70% time per task**. On tasks where the published comparator failed (these 8), TMB's premium IS the value — it's not a tax for the same outcome, it's the difference between landing and not. Hallucination rates were 0/8 for both on this single-shot corpus; the "TMB hallucinates less" claim needs longer/messier tasks to differentiate (chained-bench iteration). Full measurement detail: [`docs/BENCHMARK.md`](docs/BENCHMARK.md) and [`tests/manual/bench/RESULTS.md`](tests/manual/bench/RESULTS.md).

---

## Why TMB

Four structural innovations, each closing a specific single-agent failure mode.

### 1. Agent Harness — split planning from execution

`bro` plans + gates (full picture, long-term). `swe` executes (single task, isolated worktree). **Bro never writes source; swe never self-approves.** Out-of-role calls are rejected at the wire. No more "the same context that wrote the code marks its own homework."

Details: [`CLAUDE.md`](CLAUDE.md), [`agents/swe.md`](agents/swe.md), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 2. Trajectory Memory — state survives session kills

Every transition lands in `<project>/.claude/tmb/trajectory.db` (SQLite). Issues, discussions, ADR decisions, task specs, validation verdicts, append-only audit. Kill Claude mid-task, come back tomorrow — bro reads the trajectory and resumes.

Big token dividend: no codebase-rediscovery tax. Pre-computed architecture snapshots (codebase tree, module graph, schema map) refresh lazily; local SQLite = no API round-trips on resume.

Details: [`docs/architecture/ERD.md`](docs/architecture/ERD.md), [`docs/architecture/FILES.md`](docs/architecture/FILES.md).

### 3. Evaluation System — verification you can audit later

**Two gates** close around every commit:
- **Bro's task gate** (per task) re-runs the spec's verification after SWE returns.
- **PR-reviewer's push gate** (per push) blocks `git push` until every commit has been signed off.

Verdicts persist in the DB next to the code they judged — six months later "why did we ship this commit?" is still queryable.

Details: [`docs/architecture/FLOWS.md` § Push gate](docs/architecture/FLOWS.md#6-push-gate--pr-review), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 4. Agentic Workflow — composable, not monolithic

Workflow shape scales by ask: simple task picks defaults inline; difficult task asks scope questions + captures ADR decisions; multi-task batch amortizes planning + fires the push gate once. Doctrine is wire-enforced, not aspirational.

Details: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md).

---

## Roster on disk

The plugin ships **zero subagents**. Bro is a CLAUDE.md persona; every other agent is a **template** copied into `<project>/.claude/agents/` on demand:

| Template | When bro copies it |
|---|---|
| `swe.md` | First-run onboarding |
| `pr-reviewer.md` | First time the push gate fires |
| `architect.md`, `cto.md`, `ceo.md`, `pm.md` | First time you ask for that consultant |

Domain consultants outside this set are drafted on demand via `tmb_agent-creator`. Override any agent by editing the project-local file — local wins.

---

## Support · Contributing · License

**Support:** [Sponsor on GitHub](https://github.com/sponsors/trustmybot) keeps it maintained.

**Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) for workflow + tests. Start with [`CLAUDE.md`](CLAUDE.md) (bro persona), [`docs/architecture/RESPONSIBILITIES.md`](docs/architecture/RESPONSIBILITIES.md) (per-agent contract), [`docs/architecture/ERD.md`](docs/architecture/ERD.md) (schema).

```bash
bash tests/run-all.sh
```

**License:** MIT. Fork it, ship it, sell it. Credit nice but not required.
