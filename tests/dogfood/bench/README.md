# L7 Bench — TMB-augmented Claude vs published claude-sonnet (#6)

Single-arm benchmark. We run **TMB-on** (Opus orchestrator + Sonnet SWE
workers under the plugin) against **public** SWE-bench Lite tasks, then
compare per-task pass/fail + hallucination rate against the **published
claude-sonnet harnesses** in `SWE-bench/experiments`.

## Why no local "raw arm"

Per-task pass/fail for Claude 4 Sonnet across 3 different agentic
harnesses (SWE-agent, KGCompass, ExpeRepair) is already published in
[swe-bench/experiments](https://github.com/SWE-bench/experiments/tree/main/evaluation/lite).
Running a local raw-Sonnet arm just to reproduce numbers Anthropic + the
SWE-bench team already published is a waste of tokens. The comparator we
care about is **the public Sonnet entry**, not "Sonnet we re-ran ourselves."

This also means: **only public benchmarks count.** Private (TMB-curated)
tasks have no published comparator → not externally credible → out of
scope for the headline corpus.

## Win condition: "smart = fewer hallucinations"

TMB's SWE worker is Sonnet — same model the leaderboard comparator uses.
The hypothesis isn't "TMB beats Sonnet on tokens" (it likely won't, since
bro adds an Opus orchestration layer on top). The hypothesis is:

> **TMB-on solves SWE-bench tasks where every published Sonnet 4 harness
> failed**, and/or **hallucinates less** (claims success when verify
> disagrees, much less often).

If TMB resolves task X where all 3 published Sonnet entries didn't, the
plugin's added orchestration + V1/V2/V3 push-gate + atomic-close
ceremony is earning its tokens. A higher token count per resolved task
is fine — the doctrine pays off in *which* tasks land and *whether the
agent's claims match reality*.

## Scored axes (per task)

| Axis | What it measures | Aligns with | Scorer |
|---|---|---|---|
| **Resolved** | Did the agent solve the task? (FAIL_TO_PASS pass + PASS_TO_PASS sample doesn't regress) | SWE-bench %Resolved (primary leaderboard metric) | per-task `verify.sh` exits 0 |
| **Apply** | Did the agent leave the project with file changes? | SWE-bench %Apply | `scorers/apply.sh` |
| **Tokens** | Total tokens consumed (input + cache_creation + cache_read + output) | SWE-bench Avg tokens | transcript `usage` block |
| **Cost** | $ spent end-to-end | SWE-bench Cost | transcript `total_cost_usd` |
| **Duration** | Wall-clock seconds | SWE-bench Time | runner `$(date +%s)` |
| **Quality** | Composite engineering-quality score (lint + commit-msg + summaries fresh + ADR + first-attempt validation pass) | **TMB-specific** | `scorers/quality.sh` |
| **Hallucinated** | Agent claimed success ∧ verify.sh failed. Load-bearing TMB-vs-raw signal — the doctrine's push-gate exists to catch this class. | **TMB-specific** | `scorers/hallucination.sh` |

## Task corpus

Cherry-picked from public benchmarks only:

| # | Task | Source | Tier | Sonnet 4 result (3 harnesses) |
|---|---|---|---|---|
| 01 | `01-aider-acronym` | Aider polyglot | Diagnostic | (no per-task data) |
| 02 | `02-aider-word-count` | Aider polyglot | Diagnostic | (no per-task data) |
| 03 | `03-swebench-flask-4045` | SWE-bench Lite | **Headline** | **All 3 failed** |
| 04 | `04-swebench-sphinx-7686` | SWE-bench Lite | **Headline** | **All 3 failed** |
| 05 | `05-swebench-pytest-8906` | SWE-bench Lite | **Headline** | **All 3 failed** |
| 06 | `06-swebench-pylint-6506` | SWE-bench Lite | **Headline** | **All 3 failed** |

The 4 SWE-bench Lite tasks are in the **intersection of failures** across
all three published Sonnet 4 agentic harnesses (SWE-agent + KGCompass +
ExpeRepair). 83 tasks total are in that intersection; we picked 4 with
bounded test surfaces (≤2 FAIL_TO_PASS each) and diverse failure modes
(web framework / docs tooling / test framework / linter).

## Fairness controls

| Variable | Our setup | Leaderboard comparator |
|---|---|---|
| Prompt | SWE-bench `problem_statement` verbatim | Same |
| Starting code | `base_commit` + `test_patch` applied | Same |
| Test framework | `pytest` on `FAIL_TO_PASS` from official dataset | Same |
| Pass criterion | All `FAIL_TO_PASS` pass + sampled `PASS_TO_PASS` doesn't regress | Same (we sample, leaderboard runs full) |
| Python version | **Pinned per task via uv (Python 3.9 for current corpus)** | Per-task Docker image (Python 3.9 for these tasks) |
| Transitive deps | **Per-task pin set in `env_install_cmd` matching SWE-bench's image** | Same (their pins come from per-task lockfile) |
| Agent harness | Claude Code + TMB plugin, `--max-turns 50` | SWE-agent / KGCompass / ExpeRepair, varying iteration caps |
| Env isolation | `uv venv` per task at `$PROJECT/.bench-venv/`, prepended to PATH for agent and verify | Docker container per task |

The remaining fairness gap is **PASS_TO_PASS sampling** — leaderboard
runs the full PASS_TO_PASS (hundreds-thousands of tests), we sample 3-5.
If our sample misses a regression the full would catch, we'd score
`resolved=1` where leaderboard scores 0. Mitigation: pick `PASS_TO_PASS`
samples adjacent to the modified file in each task.json.

## Layout

```
tests/dogfood/bench/
├── README.md                       — this file
├── run-bench.sh                    — runner: tasks × {tmb-on} × N
├── tasks/                          — public benchmark tasks only
│   ├── README.md                   — task corpus doc
│   ├── 03-swebench-flask-4045/     — SWE-bench Lite (param via swebench-runner.sh)
│   │   ├── task.json               — repo, base_commit, fail_to_pass, env pins, ...
│   │   ├── prompt.txt              — verbatim SWE-bench problem_statement
│   │   ├── test_patch.diff         — verbatim SWE-bench test_patch
│   │   ├── setup.sh                — thin wrapper → swebench-runner.sh setup
│   │   └── verify.sh               — thin wrapper → swebench-runner.sh verify
│   └── ...
├── scorers/
│   ├── problem-solving.sh          — wraps task's verify.sh
│   ├── apply.sh                    — diff-applies check
│   ├── token-saving.sh             — pulls totals from transcript
│   ├── quality.sh                  — lint + commit-msg + summaries + ADR
│   └── hallucination.sh            — claim/verify mismatch detector
└── lib/
    ├── bench-helpers.sh            — shared utilities (claude invocation, etc.)
    └── swebench-runner.sh          — parameterized setup + verify for all
                                       SWE-bench Lite tasks
```

## Running

```bash
# Single task, N=1
bash tests/dogfood/bench/run-bench.sh 03-swebench-flask-4045

# All tasks, N=1 (~$3–8)
bash tests/dogfood/bench/run-bench.sh --all

# Custom N (per-task repeat for variance smoothing)
N=3 bash tests/dogfood/bench/run-bench.sh --all
```

Requires:
- `claude` (with `CLAUDE_CODE_OAUTH_TOKEN` set)
- `uv` (per-task Python pinning) — `brew install uv` or `pip install uv`
- `git`, `jq`, `sqlite3`
- Internet (clones from github.com anonymously, no auth needed)

Results land under `~/.claude/tmb/bench-runs/<run-id>/`:

```
<run-id>/
├── summary.md                 — table + leaderboard pointer + hallucination rate
├── _results.jsonl             — raw per-(task, run) records
└── <task>/tmb-on/run-NN/
    ├── prompt.txt
    ├── transcript.jsonl       — claude stream-json output
    ├── trajectory.db          — post-state trajectory DB
    ├── verify.log             — verify.sh output
    └── scores.json            — { resolved, applied, tokens, cost, duration, quality, hallucinated, ... }
```

## Comparison protocol

For each SWE-bench Lite task in the run:

1. Look up the task ID in
   [`SWE-bench/experiments/evaluation/lite/<submission>/results/results.json`](https://github.com/SWE-bench/experiments/tree/main/evaluation/lite).
2. For each of the 3 published Sonnet 4 harnesses
   (`20250526_sweagent_claude-4-sonnet-20250514`,
   `20250625_ExpeRepair-v1_claude-4-sonnet-20250514`,
   `20250906_KGCompass_claude-4-sonnet-20250514`), check if the task ID
   is in `.resolved`.
3. Cross-reference with our `summary.md`:
   - **TMB resolves where all 3 Sonnet 4 harnesses failed → headline win**
   - **TMB hallucinates 0% while Sonnet's harnesses hallucinated → orthogonal win** on the "smart = less hallucination" axis (their hallucination rate isn't published; this is our internal claim)
   - **TMB doesn't resolve where Sonnet didn't either → break-even** (the doctrine couldn't crack a known-hard task; fair)
   - **TMB doesn't resolve where Sonnet did → regression**, investigate

## Cost ceiling

Single-arm against the MVP corpus (~6 tasks × N=1) is ~6 `claude -p`
calls. At ~150-300k tokens average per call (SWE-bench tasks need real
exploration) that's ~1-2M tokens or **~$3–8 per full pass**. Opt-in —
never CI-required.

## Out of scope for the MVP

- Statistical significance (N≥3 + variance bars) — defer until the
  per-task signal is validated on N=1.
- Full SWE-bench Lite (300 tasks) — defer until the curated subset
  pattern proves out.
- LLM-as-judge scoring for the quality axis (issue #29) — defer; the
  mechanical scorer covers the load-bearing checks for now.
- Private (TMB-curated) tasks — no public comparator → not credible
  for headline numbers.
- Full PASS_TO_PASS regression coverage — leaderboard runs the entire
  PASS_TO_PASS, we sample 3-5. May produce false-positive resolved=1
  vs leaderboard.
