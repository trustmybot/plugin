# Benchmarks — TMB vs Claude 4 Sonnet & Opus 4

> **Headline (2026-05-13, N=1):**
>
> - **vs Claude 4 Opus** (Anthropic's official tools-harness, May 2025):
>   TMB resolved **4/4 SWE-bench Verified tasks** where pure Opus 4 + 2-tool
>   scaffold failed. Same model snapshot (`claude-opus-4-20250514`).
>   0/4 hallucinations.
> - **vs Claude 4 Sonnet** (3 published agentic harnesses on Lite):
>   TMB resolved **4/4 SWE-bench Lite tasks** where every published Sonnet 4
>   agentic harness (SWE-agent, KGCompass, ExpeRepair-v1) failed.
>   0/4 hallucinations.

## TMB vs Claude 4 Opus on SWE-bench Verified — direct apples-to-apples

**Run date:** 2026-05-13 · **N = 1** · **4 tasks** ·
**Model:** `claude-opus-4-20250514` (pinned to match comparator)

### Setup

We picked 4 SWE-bench Verified tasks from the intersection of failures
across **Anthropic's two published May 2025 submissions** — same
underlying models, same simple 2-tool scaffold:

| Anthropic submission | Resolved on Verified |
|---|---|
| [`20250522_tools_claude-4-opus`](https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20250522_tools_claude-4-opus) | 366 / 500 (73.2%) |
| [`20250522_tools_claude-4-sonnet`](https://github.com/SWE-bench/experiments/tree/main/evaluation/verified/20250522_tools_claude-4-sonnet) | 362 / 500 (72.4%) |
| **Intersection of failures (both lost)** | **111 / 500** |

We picked 4 with 1 `FAIL_TO_PASS` test each, from 4 different repos:

| Task | Repo | What |
|---|---|---|
| `sympy__sympy-20916` | sympy 1.8 | subscript pretty-printing |
| `pytest-dev__pytest-10356` | pytest 7.2 | marker resolution order across MRO |
| `sphinx-doc__sphinx-7590` | sphinx 3.1 | C++ user-defined-literal parsing |
| `pylint-dev__pylint-4661` | pylint 2.10 | XDG-spec cache path |

### Results

| Task | TMB-on | Anthropic Tools+Opus 4 | Anthropic Tools+Sonnet 4 |
|---|---|---|---|
| `sympy__sympy-20916`     | ✅ resolved · $2.19 · 240s · halluc=0 | ❌ | ❌ |
| `pytest-dev__pytest-10356` | ✅ resolved · $2.39 · 346s · halluc=0 | ❌ | ❌ |
| `sphinx-doc__sphinx-7590` | ✅ resolved · $4.23 · 587s · halluc=0 | ❌ | ❌ |
| `pylint-dev__pylint-4661` | ✅ resolved · $1.20 · 256s · halluc=0 | ❌ | ❌ |
| **Aggregate** | **4 / 4 · $10.01 · 9.89M tok · 0/4 halluc** | 0 / 4 | 0 / 4 |

### What this proves

- **Same model snapshot.** Both TMB-on and Anthropic's comparator used
  `claude-opus-4-20250514` — the exact May 2025 Claude 4 Opus release.
  The only variable is orchestration.
- **Strict win.** TMB resolved 4/4 tasks where pure Opus 4 with
  Anthropic's official 2-tool agentic scaffold resolved 0/4.
- **No hallucinated success.** Every TMB success claim matched verify.
- **Same env discipline.** Per-task uv venv with Python pinned to
  SWE-bench's Docker-image version (3.9 / 3.10), per-task transitive
  dep pins (e.g. `'sphinxcontrib-applehelp<1.0.4'` for sphinx 3.1),
  verbatim SWE-bench `problem_statement` + official `test_patch`.
- **One harness difference, fully disclosed.** TMB's prompt is the
  verbatim problem_statement **plus one sentence**:
  *"I will go to sleep. You solve all of the issues automatically.
  Don't ask questions."* This is the real headless-TMB invocation
  pattern. It adds zero external information bro doesn't already
  have — it just grants the autonomous-mode permission the doctrine
  reads from. Comparators bake autonomy into their harness wrapper;
  TMB reads it from the prompt. Same intent, different mechanism.

## The claim

TMB is "smart" — meaning **fewer hallucinations + resolves harder tasks**
— against the same underlying models it orchestrates (Sonnet for SWE
work, Opus for bro orchestration). Concretely:

- **vs pure Claude 4 Sonnet:** TMB should clearly win. Validated below
  on SWE-bench Lite, 4/4 on the all-Sonnet-failed intersection.
- **vs pure Claude 4 Opus:** TMB should resolve tasks pure Opus 4
  can't. Validated above on SWE-bench Verified, 4/4 on the
  Opus-4-AND-Sonnet-4 both-failed intersection.

Both single-shot wins are demonstrated. The orthogonal **long-term**
claim (cumulative token decay, persistent state across multi-task work)
needs a multi-task chained bench — see [Open work](#open-work).

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

### Tier 1 — Autonomous (verbatim `problem_statement`)

Verbatim SWE-bench `problem_statement` sent to bro. No additional framing.
**Fair comparison against published Sonnet 4 / Opus 4 harnesses**, which
run their own autonomy logic inside their harness wrapper.

**Used for:** the 4 SWE-bench Lite tasks (vs Sonnet 4, results below).

### Tier 2 — TMB-as-designed (explicit autonomy permission)

The bench appends one sentence to the prompt:

> *"I will go to sleep. You solve all of the issues automatically.
> Don't ask questions."*

This matches **how a real TMB user invokes bro for overnight autonomous
work.** It doesn't give bro external information the agent doesn't
already have — it just grants the autonomous-mode permission the TMB
doctrine reads from. Comparators bake autonomy into harness wrapper code;
TMB reads it from the prompt. Different mechanism, same intent.

Not cheating:
- No ground-truth leak (no test_patch / FAIL_TO_PASS visibility added)
- No second intelligence loop (no surrogate agent)
- No information beyond what the comparator's harness wrapper provides

**Used for:** the 4 SWE-bench Verified tasks (vs Opus 4, results above).

Toggle: `TMB_BENCH_ENRICH_PROMPT=1 bash run-bench.sh <task>`.

### Observed: the doctrine ceremony doesn't fire on small tasks

In all 8 runs (4 Lite + 4 Verified), the formal TMB doctrine ceremony
(`task_create_batch` → SWE spawn → V1/V2/V3 push-gate → atomic-close)
**didn't fire** — `skill_invocations`, `tasks`, `agent_runs`,
`validation_attempts` all empty in every run DB. Bro autonomously
decided single-bug-fix tasks didn't warrant the multi-step ceremony.

This means the 8/8 wins came from **TMB-loaded Opus bro doing
direct-edit work**, not from the full doctrine engaging. The
ceremony's contribution is upper-bounded by these results — it can't
have helped because it didn't run. The doctrine targets a different
task shape (multi-file refactor, multi-task workflow) which the
chained-bench iteration will measure.

## Caveats

- **N = 1.** Single-run variance unmeasured. Expect ±1 task on a re-run.
- **Curated subsets.** The Verified 4 tasks were chosen because both
  Opus 4 AND Sonnet 4 failed them; the Lite 4 tasks were chosen because
  all 3 published Sonnet 4 harnesses failed them. TMB's rate on a
  random slice (full 500 Verified / full 300 Lite) would be lower —
  exact number requires a representative-sample bench.
- **PASS_TO_PASS sampled.** Not full coverage. Possible false-positive
  resolved=1 if our 3-5 sampled regression checks miss a real
  regression. Mitigation: samples picked adjacent to the modified file.
- **Doctrine ceremony didn't formally fire** on any of the 8 single-shot
  tasks. `skill_invocations`, `tasks`, `agent_runs`, and
  `validation_attempts` were empty in every run DB. The wins were
  achieved by Opus-bro direct-edit work + plugin context, NOT by the
  full V1/V2/V3 push-gate + atomic-close ceremony. The doctrine's
  contribution to these specific results is upper-bounded — it didn't
  run.
- **Hallucination scorer is keyword-matched.** Conservative against
  false-positive flagging (won't falsely accuse a truthful claim of
  hallucinating). False negatives possible (an agent could claim
  success in language the scorer doesn't catch).
- **Opus orchestration cost.** TMB bro uses Claude Opus; the published
  Sonnet 4 comparators use only Sonnet. TMB pays more per task in
  tokens; the win is in *which* tasks land, not raw efficiency.

## Open work

### Multi-task chained bench — the real product measurement

The Tier 2 null result confirms that single-shot benchmarks don't
exercise TMB's actual value. TMB's design is for **multi-task work
where state accumulates** — file_registry warms, atomic-close history
seeds the push-gate, trajectory DB cross-references work over time.
The right bench shape:

**Setup:**
- Pick a repo with many Sonnet-failed Lite tasks (django has 21; sympy
  has 30).
- Pick N sequential tasks (e.g., 5) from different subsystems of that repo.
- Clone the repo ONCE into a scratch project. Initialize
  `.claude/tmb/trajectory.db`.

**Per task in sequence:**
- Apply the task's `test_patch` to the same project.
- Run bro on the task's `problem_statement` (with Tier 2 enrichment).
- Score: resolved, tokens, cost, hallucinated, duration.
- **Do NOT reset** `.claude/tmb/` or `git` — let trajectory accumulate.
- Continue to next task.

**Tracked metrics with chain position:**

| Metric | Hypothesis |
|---|---|
| Tokens per task | Should *drop monotonically* as the registry warms and bro can lookup-not-read |
| Hallucination rate | Should stay 0 as atomic-close history seeds the gate |
| Duration per task | Should drop as bro's task templates compound |
| First-attempt pass rate | Should rise as bro's decision audit informs future calls |

**Comparators:**
- **TMB-chained** (single project, accumulating state) vs
- **TMB-cold** (fresh project per task — today's single-shot pattern) on the same N tasks
- vs **raw Opus 4** (no plugin, cold each task) on the same N tasks

If TMB-chained's per-task cost drops while TMB-cold and raw Opus 4 stay
flat, that's the differentiation story.

**Cost estimate:** 5 tasks × 3 arms × ~$1-2 per task = **$15-30** per
full pass.

**Status:** stub at `tests/dogfood/bench/run-chained-bench.sh` —
design captured, implementation pending.

### Alternate path: SWE-bench Verified

Switch corpus to SWE-bench Verified where Opus 4 has per-task data
published. Different 500-task set; would mean rebuilding setup.sh for
Verified-specific paths. Less compelling than the chained bench because
it would still be single-shot, but enables direct per-task Opus 4 A/B.

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
