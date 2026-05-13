# L7 Bench — TMB-augmented Claude vs raw Claude (#6)

Quantitative comparison of two arms on the same set of agentic-SWE tasks:

- **Arm A (tmb-on):** `claude -p --plugin-dir <plugin>` — bro persona, MCP-backed trajectory, file_registry, atomic-close, hooks, skills, the works.
- **Arm B (raw):** `claude -p` with no plugin loaded — vanilla Claude on the same prompt.

Both arms see the **same task prompt** + the **same project state**. The only variable is whether the TMB plugin is loaded. Three orthogonal axes get scored:

| Axis | What it measures | Scorer |
|---|---|---|
| **Problem solving** | Did the agent solve the task correctly? | Per-task `verify.sh` (test suite, lint, build — depending on task) returns 0 on pass |
| **Token saving** | Total tokens consumed end-to-end | `SUM(tokens_total)` from `agent_runs` (bro + SWE rows on arm A; the single session on arm B) + parser fallback on raw transcript |
| **Long-term engineering quality** | Does the work pay dividends for future sessions? | Composite: lint pass + Conventional Commits message + `file_registry` summaries fresh + ADR present for arch-impact + first-attempt `validation_attempts.verdict='pass'` |

## Why this exists

The hypothesis: TMB doctrine (persistent trajectory DB, atomic-close discipline, scoped skills, push-gate review) lets Claude do **the same job with fewer tokens AND leaves the project in a more maintainable state** than the same Claude with no plugin. The L5/L6 layers prove individual bro behaviors fire; this layer measures the integrated outcome.

Goal of issue #6: provide a publishable per-axis delta — e.g. "TMB-on solves 8/10 tasks at 60k tokens median, leaves 9/10 in fresh-summary state; raw solves 6/10 at 95k tokens median, leaves 0/10 with any summary state."

## Layout

```
tests/dogfood/bench/
├── README.md                  — this file
├── run-bench.sh               — main runner: tasks × {tmb-on, raw}
├── tasks/                     — curated benchmark tasks
│   ├── README.md              — task corpus doc + cherry-pick rationale
│   ├── <NN-name>/
│   │   ├── task.json          — { source, prompt, verify_cmd, repo_setup }
│   │   ├── prompt.txt         — the user prompt sent to both arms
│   │   ├── setup.sh           — clone/checkout the task's repo state
│   │   └── verify.sh          — pass/fail signal (test suite, lint, etc.)
│   └── ...
├── scorers/
│   ├── problem-solving.sh     — wraps task's verify.sh
│   ├── token-saving.sh        — pulls totals from agent_runs + transcript
│   └── quality.sh             — lint + commit-msg + summaries + ADR check
└── lib/
    └── bench-helpers.sh       — shared utilities
```

## Task corpus (#6 — phase 2)

Cherry-picked from public benchmarks (SWE-bench Lite + Aider's bench) — public + credible
but small enough to run in one sitting. Selection criteria documented in
`tasks/README.md`. **Curated subset, not a wholesale benchmark run** —
we surface representative outcomes without committing to the publication-grade
investment until the harness is proven.

## Running

```bash
# Single task, both arms, N=1
bash tests/dogfood/bench/run-bench.sh 01-django-utils-bug

# All tasks, N=1 per arm (~$5–20 for the MVP corpus)
bash tests/dogfood/bench/run-bench.sh --all

# Custom N (per-arm repeat for variance smoothing)
N=3 bash tests/dogfood/bench/run-bench.sh --all
```

Results land under `~/.claude/tmb/bench-runs/<run-id>/`:

```
<run-id>/
├── summary.md                 — table: task × arm × {solved, tokens, quality}
├── _results.jsonl             — raw per-(task, arm, run) records
└── <task>/<arm>/run-NN/
    ├── prompt.txt
    ├── transcript.jsonl       — claude stream-json output
    ├── trajectory.db          — post-state DB (arm A only — arm B has none)
    ├── tokens.json            — per-run token total
    ├── verify.log             — verify.sh output
    └── scores.json            — { problem_solving, token_saving, quality }
```

## Cost ceiling

Each run-bench invocation against the MVP corpus (10 tasks × 2 arms × N=1) is
~20 `claude -p` calls. At ~10k tokens average per call that's ~200k tokens or
**~$5–20 per full pass**. Treat as opt-in — never CI-required.

## Out of scope for the MVP

- Statistical significance (N≥3 + variance bars) — defer until the
  3-axis scorer is validated on N=1.
- Full SWE-bench Lite (300 tasks) — defer until the curated subset
  pattern proves out.
- LLM-as-judge scoring for the quality axis (issue #29) — defer; the
  mechanical scorer covers the load-bearing checks for now.
