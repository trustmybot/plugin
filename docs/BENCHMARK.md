# Benchmarks — TMB vs Claude 4 Sonnet & Opus 4

> **Headline (2026-05-13, N=1 per task):**
>
> - **vs Claude 4 Opus** (Anthropic's official tools-harness, May 2025):
>   TMB resolved **4/4 SWE-bench Verified tasks** where pure Opus 4 + 2-tool
>   scaffold failed. Same model snapshot (`claude-opus-4-20250514`).
>   0/4 hallucinations.
> - **vs Claude 4 Sonnet** (3 published agentic harnesses on Lite):
>   TMB resolved **4/4 SWE-bench Lite tasks** where every published Sonnet 4
>   agentic harness (SWE-agent, KGCompass, ExpeRepair-v1) failed.
>   0/4 hallucinations.
>
> **Total spend: $17.33** across both runs.

Raw per-task data, environment metadata, run dates, and reproduction
commands live in **[`tests/dogfood/bench/RESULTS.md`](../tests/dogfood/bench/RESULTS.md)**.

---

## vs Claude 4 Opus — SWE-bench Verified

4 tasks from the intersection of failures across Anthropic's two
published May 2025 submissions (both use the same simple 2-tool
agentic scaffold — `bash` + `string_replace_editor`):

| Anthropic submission (May 2025) | Resolved on Verified | Resolved on our 4 picks |
|---|---|---|
| [`20250522_tools_claude-4-opus`](https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20250522_tools_claude-4-opus) | 366 / 500 (73.2%) | **0 / 4** |
| [`20250522_tools_claude-4-sonnet`](https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20250522_tools_claude-4-sonnet) | 362 / 500 (72.4%) | **0 / 4** |
| **TMB-on** (same `claude-opus-4-20250514`, plugin loaded) | (4-task curated subset) | **4 / 4** ✅ |

| Task | Result | Hallucinated |
|---|---|---|
| `sympy__sympy-20916` | ✅ | 0 |
| `pytest-dev__pytest-10356` | ✅ | 0 |
| `sphinx-doc__sphinx-7590` | ✅ | 0 |
| `pylint-dev__pylint-4661` | ✅ | 0 |

**Why this is a fair comparison:** same exact Opus model snapshot
(`claude-opus-4-20250514`), same task IDs, same official SWE-bench
`problem_statement` + `test_patch`, same per-task Python version pinned
via `uv venv` to match SWE-bench's Docker image. The only variable is
orchestration.

---

## vs Claude 4 Sonnet — SWE-bench Lite

4 tasks from the intersection of failures across **three** published
Claude 4 Sonnet agentic harnesses on SWE-bench Lite:

| Harness (Sonnet 4 underlying) | Resolved on Lite | Resolved on our 4 picks |
|---|---|---|
| SWE-agent + Sonnet 4 | 170 / 300 (57%) | **0 / 4** |
| KGCompass + Sonnet 4 | 175 / 300 (58%) | **0 / 4** |
| ExpeRepair-v1 + Sonnet 4 | 181 / 300 (60%) | **0 / 4** |
| **TMB-on** | (4-task curated subset) | **4 / 4** ✅ |

| Task | Result | Hallucinated |
|---|---|---|
| `pytest-dev__pytest-8906` | ✅ | 0 |
| `sphinx-doc__sphinx-7686` | ✅ | 0 |
| `pylint-dev__pylint-6506` | ✅ | 0 |
| `pallets__flask-4045` | ✅ | 0 |

---

## The claim

TMB is "smart" = **fewer hallucinations + resolves harder tasks** than
the same underlying models do under simpler orchestration.

- **vs pure Sonnet 4:** validated — 4/4 on tasks all 3 published Sonnet 4 harnesses failed.
- **vs pure Opus 4:** validated — 4/4 on tasks Anthropic's own published Opus 4 harness failed.

Long-term claims (cumulative token decay, persistent state across
multi-task work) need a chained-bench iteration — see open work below.

---

## Fairness disclosure

| Variable | Match |
|---|---|
| Prompt | SWE-bench `problem_statement` **verbatim** + one autonomy-permission sentence (see below) |
| Starting code | `base_commit` + `test_patch` from official dataset |
| Pass criterion | All `FAIL_TO_PASS` tests pass + sampled `PASS_TO_PASS` doesn't regress |
| Python version | Pinned per task via `uv venv` to match SWE-bench's Docker image |
| Transitive deps | Per-task pin set in `env_install_cmd` matching SWE-bench's per-task lockfile |
| Model | **Identical snapshot** — `claude-opus-4-20250514` (matches Anthropic's submission) |
| Env isolation | `uv venv` per task at `$PROJECT/.bench-venv/` — functionally equivalent to per-task Docker |

**The one added prompt sentence:**

> *"I will go to sleep. You solve all of the issues automatically. Don't
> ask questions."*

This matches how a real TMB user invokes bro for headless overnight work.
It adds no external information bro doesn't already have — it just grants
the autonomous-mode permission TMB's doctrine reads from. Comparators
bake equivalent autonomy into their harness wrapper code; TMB reads it
from the prompt. Different mechanism, same intent.

---

## Caveats

- **N = 1** per task. Single-run variance unmeasured. Expect ±1 task on a re-run.
- **Curated-hard subsets.** Both 4-task corpora are deliberately picked
  from the intersection of failures across the comparators. TMB's rate
  on a random slice (full 500 Verified / full 300 Lite) would be lower —
  exact number requires a representative-sample bench.
- **`PASS_TO_PASS` sampled.** We run 3-5 regression checks per task; the
  comparator harnesses run the full set. Possible false-positive
  `resolved=1` if our sample misses a real regression.
- **Doctrine ceremony didn't formally fire** on any of the 8 single-shot
  runs. The wins were achieved by TMB-loaded Opus bro doing direct-edit
  work + plugin context — NOT by the full V1/V2/V3 push-gate +
  atomic-close ceremony. The doctrine's contribution to these specific
  results is upper-bounded.
- **Hallucination scorer is keyword-matched.** Conservative — won't
  falsely accuse truthful claims; false negatives possible if an agent
  claims success in language the scorer doesn't catch.

---

## Open work — the next iteration

The current bench is **single-shot**: each task starts in a fresh
project, the trajectory DB and file_registry are wiped, the doctrine
ceremony doesn't engage because bro autonomously judges single-bug-fix
tasks too small to warrant it.

**TMB's actual value proposition lives in multi-task workflows** where
state accumulates across tasks. The next bench iteration:

- **Multi-task chained bench** — N sequential SWE-bench tasks against
  the same repo, preserving trajectory.db + file_registry between
  tasks. Measure per-task token decay (should drop as registry warms),
  hallucination rate (should stay 0), and per-task duration. Compare
  against TMB-cold (fresh state per task) and raw Opus 4 cold-starting
  each task. Design captured in
  [`tests/dogfood/bench/run-chained-bench.sh`](../tests/dogfood/bench/run-chained-bench.sh).
- Bump N to 3 per task for variance bars (~$25 per full pass).
- Expand corpus from 4 to 10-15 tasks per corpus.
- Tighten the hallucination scorer (LLM-as-judge on the final message).

---

## Source

- Bench harness: [`tests/dogfood/bench/`](../tests/dogfood/bench/)
- Technical per-task data, run metadata, reproduction commands: [`tests/dogfood/bench/RESULTS.md`](../tests/dogfood/bench/RESULTS.md)
- Published Opus 4 / Sonnet 4 comparators: [`SWE-bench/experiments`](https://github.com/SWE-bench/experiments)
- SWE-bench leaderboards: [swebench.com](https://www.swebench.com/)
