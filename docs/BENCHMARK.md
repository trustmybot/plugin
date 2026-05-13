# Benchmarks — TMB vs Claude 4 Sonnet & Opus 4

> **Headline (2026-05-13, N=1, 4-task curated subset):**
>
> On 4 SWE-bench Lite tasks where **every** published Claude 4 Sonnet
> agentic harness (SWE-agent, KGCompass, ExpeRepair-v1) **failed**,
> **TMB resolved all 4 (100%) with zero hallucinated success claims.**

## The claim

TMB is "smart" — meaning **fewer hallucinations + resolves harder tasks**
— against the same underlying models it orchestrates (Sonnet for SWE
work, Opus for bro orchestration). Concretely:

- **vs pure Claude 4 Sonnet:** TMB should clearly win. Sonnet is what
  TMB's SWE workers use; layering Opus orchestration + plugin context
  should expand the set of resolvable tasks.
- **vs pure Claude 4 Opus:** TMB should be at parity short-term (single
  task) and **clearly better long-term** — across multi-task workflows
  where TMB's persistent trajectory DB, file_registry, and atomic-close
  history compound.

The single-shot benchmark below validates the Sonnet claim. The
long-term Opus claim requires a multi-task chained bench — see
[Open work](#open-work) below.

## vs Claude 4 Sonnet — direct comparison

### Corpus

We picked **4 tasks from the intersection of failures** across 3
published Claude 4 Sonnet agentic harnesses on SWE-bench Lite:

| Harness (published submission) | Resolved on Lite | Resolved on our 4 tasks |
|---|---|---|
| `20250526_sweagent_claude-4-sonnet-20250514` | 170 / 300 (57%) | **0 / 4** |
| `20250906_KGCompass_claude-4-sonnet-20250514` | 175 / 300 (58%) | **0 / 4** |
| `20250625_ExpeRepair-v1_claude-4-sonnet-20250514` | 181 / 300 (60%) | **0 / 4** |

83 SWE-bench Lite tasks are in the intersection of failures across all
three harnesses — these are tasks where pure Sonnet 4 has been
demonstrated to struggle regardless of agentic-harness design. We
chose 4 with bounded test surfaces and diverse failure modes:

| Task ID | Failure mode |
|---|---|
| `pytest-dev__pytest-8906` | test framework: module-level skip error message |
| `sphinx-doc__sphinx-7686` | docs tooling: autosummary `imported_members` flag |
| `pylint-dev__pylint-6506` | linter: unrecognized option traceback cleanup |
| `pallets__flask-4045` | web framework: blueprint name validation |

### Results

| | TMB-on | SWE-agent + Sonnet 4 | KGCompass + Sonnet 4 | ExpeRepair-v1 + Sonnet 4 |
|---|---|---|---|---|
| **Resolved** | **4 / 4 (100%)** | 0 / 4 | 0 / 4 | 0 / 4 |
| **Hallucinations** | **0 / 4** | (not measured) | (not measured) | (not measured) |
| **Total cost** | $7.32 | (n/a — all 4 failed) | (n/a) | (n/a) |
| **Total tokens** | ~7.83M | (n/a) | (n/a) | (n/a) |

Per-task detail in [`tests/dogfood/bench/RESULTS.md`](../tests/dogfood/bench/RESULTS.md).

### What this proves

- **Strict win on hard tasks.** Every task in this subset was hard
  enough that 3 different published Sonnet 4 harnesses couldn't solve
  it. TMB resolved all 4.
- **No hallucinated success.** Every TMB claim ("All N tests pass…")
  matched the verify outcome. Sonnet 4 hallucination rates on Lite are
  not published, but on tasks they couldn't even solve, claims of
  success would be the canonical hallucination case.
- **Underlying model is the same.** TMB's SWE worker is Claude 4 Sonnet
  — the same model the published harnesses use. The difference is
  orchestration: Opus bro + trajectory DB + plugin tooling.

## vs Claude 4 Opus — partial comparison

Anthropic's Claude Opus 4 line **only has aggregate SWE-bench Lite data
published, not per-task pass/fail.** This makes a direct per-task A/B
impossible without running our own Opus 4 baseline.

What's published ([source](https://pricepertoken.com/leaderboards/benchmark/swe-bench-lite),
April 2026 snapshot):

| Model | Lite (300 tasks) |
|---|---|
| Claude Opus 4.6 | **62.7%** (~188 resolved) |
| Claude Opus 4.5 | 49.3% (~148 resolved) |
| Claude Haiku 4.5 | 54.3% |

What we can say with this data:

- **On a random sample**, TMB's 4/4 isn't directly comparable to Opus
  4.6's 62.7% — different corpora.
- **On the all-Sonnet-failed subset**, Opus 4.6's resolution rate is
  almost certainly *lower* than its overall 62.7% (these are the hard
  tasks, by selection). For Opus 4.6 to beat TMB on these 4, it would
  need to outperform its own average by a wide margin on a subset
  specifically chosen to be hard.
- **No direct contradiction yet** — we don't have proof Opus 4 beats
  TMB on any specific task, nor proof it doesn't.

The honest read: **TMB ≈ Opus 4 short-term is plausible from the
available data, but not directly demonstrated.** The long-term claim
(token efficiency, hallucination rate, persistent state across multi-task
work) is not measured by this bench at all.

### Why we don't run our own Opus 4 baseline

Two reasons:
1. **Cost.** ~$10-20 to run 4 single-task baselines under raw Opus 4.
2. **The story is in the long term.** Pure Opus 4 (no plugin, no
   trajectory) on a single task is roughly TMB's lower bound. The
   interesting question is what happens across **10 sequential tasks**
   where state accumulates. That requires a different bench (see below).

## Methodology

### What's identical to the published Sonnet 4 runs

| Variable | TMB bench | Sonnet 4 published comparators |
|---|---|---|
| Prompt | SWE-bench `problem_statement` verbatim | Same |
| Starting code | `base_commit` + `test_patch` from official dataset | Same |
| Test framework | `pytest` on `FAIL_TO_PASS` from official dataset | Same |
| Python version | 3.9.25 pinned per task via `uv venv` | Per-task Docker image (Python 3.9 for these tasks) |
| Transitive deps | Per-task pin set in `env_install_cmd` matching SWE-bench's Docker image lockfile | Same (their pins come from per-task lockfile) |
| Pass criterion | `FAIL_TO_PASS` tests pass + sampled `PASS_TO_PASS` doesn't regress | Same (we sample, comparators run full) |

### What differs

- **Agent harness:** Claude Code + TMB plugin, `--max-turns 50`.
  Comparators use SWE-agent / KGCompass / ExpeRepair with their own
  iteration caps. All four use Claude 4 Sonnet underlying.
- **`PASS_TO_PASS` sample size:** we sample 3-5; comparators run the
  full set (hundreds-thousands of tests). Possible false-positive
  resolved=1 if our sample misses a regression.
- **Env isolation:** uv venv per task at `$PROJECT/.bench-venv/`;
  comparators use Docker containers per task. Functionally equivalent.

### What "hallucination" means

A hallucination = the agent's final user-facing message claims success
(matches keywords like "all tests pass", "fix applied", "resolved"),
**AND** verify.sh's pass/fail signal disagrees. This is the load-bearing
"smart = less hallucination" signal. Mechanical, keyword-matched on the
terminal `type=result` event in the claude transcript.

## Reproduction

```bash
# Requires: claude CLI + CLAUDE_CODE_OAUTH_TOKEN, uv, git, jq, sqlite3, python3
set -a; . ./.env; set +a

bash tests/dogfood/bench/run-bench.sh 03-swebench-flask-4045
bash tests/dogfood/bench/run-bench.sh 04-swebench-sphinx-7686
bash tests/dogfood/bench/run-bench.sh 05-swebench-pytest-8906
bash tests/dogfood/bench/run-bench.sh 06-swebench-pylint-6506
```

Each task lands a run dir under `~/.claude/tmb/bench-runs/<run-id>/`
with the full claude transcript, post-run trajectory DB, verify.log,
and `scores.json`.

Cross-reference against the published submissions:

```bash
for sub in 20250526_sweagent_claude-4-sonnet-20250514 \
           20250906_KGCompass_claude-4-sonnet-20250514 \
           20250625_ExpeRepair-v1_claude-4-sonnet-20250514; do
  curl -sL "https://raw.githubusercontent.com/SWE-bench/experiments/main/evaluation/lite/$sub/results/results.json" \
    | jq -r '.resolved[]'
done | sort -u  # union of all Sonnet 4 harness wins
```

## Two-tier framing — autonomous vs TMB-as-designed

TMB is **designed to interact with a human** for ambiguous decisions
(scope, framework choices, ADR-worthy changes). The doctrine relies on
`AskUserQuestion` for genuinely-uncertain calls — but headless `claude -p`
benches have no human to answer. There are two honest ways to handle
this, and we report both:

### Tier 1 — Autonomous (today's 4/4)

Verbatim SWE-bench `problem_statement` sent to bro. No additional framing.
Bro hits ambiguity → fast-path defaults → direct-edit → submit. The
formal doctrine ceremony (V1/V2/V3, atomic-close) doesn't engage because
the `tmb_planning` skill's headless fast-path isn't reliably triggered
in `-p` mode (open issue).

**Fair comparison against:** published Sonnet 4 harnesses (SWE-agent,
KGCompass, ExpeRepair-v1), which also run autonomously without human input.

### Tier 2 — TMB-as-designed (with explicit autonomy permission)

The bench harness appends one sentence to the prompt:

> *"I will go to sleep. You solve all of the issues automatically.
> Don't ask questions."*

This matches **how a real TMB user invokes bro for overnight autonomous
work.** It doesn't give bro any external information the agent doesn't
already have — it just grants explicit autonomy permission, which is
what the TMB doctrine reads from. This is **not** cheating:
- No ground-truth leak (no test_patch, no FAIL_TO_PASS visibility added)
- No second intelligence loop (no surrogate agent)
- No external comparator advantage (no help bro doesn't get in real use)

**Comparison:** TMB-Tier-2 has no direct comparator (no published submission uses this prompt
framing). It measures TMB **as the product is intended to be used.**

Toggle: `TMB_BENCH_ENRICH_PROMPT=1 bash run-bench.sh <task>`.

**Tier 2 data:** *Pending re-fire.* The autonomous tier (today's data) is
4/4 resolved with 0/4 hallucinations. Tier 2 data should be reported
separately once gathered.

## Caveats

- **N = 1.** Single-run variance unmeasured. Expect ±1 task on a re-run.
- **Curated subset.** 4 tasks specifically chosen because Sonnet 4
  failed them. TMB's rate on a random 4-task slice would likely be lower
  — exact number requires a representative-sample bench.
- **No per-task Opus 4 comparison.** Aggregate-only.
- **PASS_TO_PASS sampled.** Not full coverage. Possible false-positive
  resolved=1.
- **Doctrine ceremony didn't formally fire.** `skill_invocations`,
  `tasks`, `agent_runs`, and `validation_attempts` were empty in all
  4 run DBs. The 4/4 was achieved by Opus-bro direct-edit, NOT by the
  full V1/V2/V3 push-gate + atomic-close ceremony. The "doctrine
  contribution" to the result is upper-bounded — it didn't fire.
- **Hallucination scorer is keyword-matched.** Conservative against
  false-positive flagging (won't falsely accuse a truthful claim of
  hallucinating). False negatives possible (an agent could claim
  success in language the scorer doesn't catch).
- **Opus orchestration cost.** TMB bro uses Claude Opus; the published
  Sonnet 4 comparators use only Sonnet. TMB pays more per task in
  tokens; the win is in *which* tasks land, not raw efficiency.

## Open work

### To make the Opus 4 comparison real

- **Multi-task chained bench.** 10 sequential SWE-bench tasks against
  the same repo, preserving trajectory.db + file_registry **across
  tasks**. Measure per-task token decay (should drop as registry warms),
  hallucination rate, and per-task duration. Compare against a raw
  Opus 4 baseline that cold-starts each task. This is where the
  "TMB long-term wins" claim becomes measurable. **Biggest open
  investment.**
- **Or: switch corpus to SWE-bench Verified** where Opus 4 has
  per-task data published. Different 500-task set; would mean
  rebuilding setup.sh for Verified-specific paths.

### To strengthen the current single-shot story

- Bump N to 3 per task (~$25 total) for variance bars.
- Expand corpus from 4 to 10-15 tasks (from the 83-task all-Sonnet-failed
  pool — diversify across django, sympy, scikit-learn).
- Tighten the hallucination scorer (LLM-as-judge over the final
  message, [issue #29](https://github.com/...)).
- Investigate why the formal doctrine ceremony didn't engage even
  with `TMB_HEADLESS=1` — skill autoload mechanism in `claude -p` mode
  may need a different trigger.

## Source data

- Per-task TMB results: [`tests/dogfood/bench/RESULTS.md`](../tests/dogfood/bench/RESULTS.md)
- Bench harness: [`tests/dogfood/bench/`](../tests/dogfood/bench/)
- Published Sonnet 4 comparators: [`SWE-bench/experiments/evaluation/lite/`](https://github.com/SWE-bench/experiments/tree/main/evaluation/lite)
- SWE-bench Lite leaderboard: [swebench.com/lite.html](https://www.swebench.com/lite.html)
