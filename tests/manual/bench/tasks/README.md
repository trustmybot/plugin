# L7 bench tasks — public benchmarks only

This dir holds the curated agentic-SWE corpus for `run-bench.sh`. Tasks
are **public** so the harness produces externally-credible signal that
can be cross-referenced against published submissions in
[swe-bench/experiments](https://github.com/SWE-bench/experiments).

**Private (TMB-curated) tasks are not accepted here** — without a
published comparator the result is just "TMB vs itself," which doesn't
prove anything about the doctrine's contribution.

## Selection criteria

A SWE-bench task (Lite or Verified) qualifies when:

1. **In the comparator-failed intersection** — for Lite: every published
   Claude 4 Sonnet agentic harness (SWE-agent, KGCompass, ExpeRepair-v1)
   failed to resolve it. For Verified: both Anthropic May 2025 Opus 4
   submissions failed. Pick from tasks failed by **multiple** harnesses,
   not just one. This is the highest-confidence "TMB win possible" bucket.
2. **Python ≥ 3.7 provisionable via `uv`** — tasks that pin Python 3.6
   (some old django and scikit-learn issues) cannot be built locally; `uv`
   does not support Python 3.6. Verify `python_version` in `task.json`
   before adding.
3. **Bounded test surface** — ≤4 `FAIL_TO_PASS` tests so the agent's
   contract is clear and verification is fast.
4. **Doable in ≤500k tokens** — bug fix or small feature, not full
   redesign.
5. **Diverse failure modes** across the corpus — web framework, docs
   tooling, test framework, linter, ML lib, math lib, …

Aider polyglot exercises are kept as **diagnostic-only** tier — they're
public but their leaderboard reports aggregate-only, so per-task
comparison to Sonnet isn't possible.

## Source tiers

| Source | Per-task Sonnet comparator? | Use |
|---|---|---|
| **SWE-bench Lite** | ✅ published per-task pass/fail in `swe-bench/experiments` | **Headline** — direct TMB-vs-Sonnet on each task ID. |
| **Aider polyglot bench** | ❌ aggregate only | **Diagnostic** — harness sanity check, not directly comparable. |
| **TMB-curated** | ❌ no public results exist | **Not accepted.** Use L5/L6 layers instead. |

## Task directory shape (SWE-bench Lite)

```
NN-swebench-<repo>-<num>/
├── README.md         — optional task description
├── task.json         — repo, base_commit, python_version, env_install_cmd, fail_to_pass, ...
├── prompt.txt        — verbatim SWE-bench problem_statement
├── test_patch.diff   — verbatim SWE-bench test_patch
├── setup.sh          — thin wrapper → swebench-runner.sh setup
└── verify.sh         — thin wrapper → swebench-runner.sh verify
```

The shared `lib/swebench-runner.sh` handles clone + checkout + apply test_patch + uv venv + pip install + pytest. Per-task setup.sh/verify.sh are 1-line wrappers.

## Current corpus

Tasks 01–22. Per-task run data: [RESULTS.md](../RESULTS.md) and
[docs/contributing/BENCHMARK.md](../../../../docs/contributing/BENCHMARK.md).

| # | Task | Source | Comparator result | Failure mode |
|---|---|---|---|---|
| 01 | `01-aider-acronym` | Aider | (n/a — diagnostic) | algorithm exercise |
| 02 | `02-aider-word-count` | Aider | (n/a — diagnostic) | algorithm exercise |
| 03 | `03-swebench-flask-4045` | SWE-bench Lite | All 3 Sonnet failed | web framework: blueprint name validation |
| 04 | `04-swebench-sphinx-7686` | SWE-bench Lite | All 3 Sonnet failed | docs tooling: autosummary imported_members flag |
| 05 | `05-swebench-pytest-8906` | SWE-bench Lite | All 3 Sonnet failed | test framework: module-level skip error message |
| 06 | `06-swebench-pylint-6506` | SWE-bench Lite | All 3 Sonnet failed | linter: unrecognized option clean error |
| 07 | `07-verified-sympy-20916` | SWE-bench Verified | Both Opus submissions failed | symbolic math |
| 08 | `08-verified-pytest-10356` | SWE-bench Verified | Both Opus submissions failed | test framework |
| 09 | `09-verified-sphinx-7590` | SWE-bench Verified | Both Opus submissions failed | docs tooling |
| 10 | `10-verified-pylint-4661` | SWE-bench Verified | Both Opus submissions failed | linter |
| 11 | `11-verified-django-10554` | SWE-bench Verified | EXCLUDED | web framework — pins Python 3.6 |
| 12 | `12-verified-matplotlib-20488` | SWE-bench Verified | Round 2 blind-hard | plotting |
| 13 | `13-verified-astropy-13033` | SWE-bench Verified | Round 2 blind-hard | astronomy lib |
| 14 | `14-verified-xarray-6938` | SWE-bench Verified | Round 2 blind-hard | data arrays |
| 15 | `15-lite-django-11019` | SWE-bench Lite | EXCLUDED | web framework — pins Python 3.6 |
| 16 | `16-lite-sympy-11400` | SWE-bench Lite | Round 2 blind-hard | symbolic math |
| 17 | `17-lite-scikit-learn-10508` | SWE-bench Lite | EXCLUDED | ML library — pins Python 3.6 |
| 18 | `18-lite-matplotlib-18869` | SWE-bench Lite | Round 2 blind-hard | plotting |
| 19 | `19-verified-django-16263` | SWE-bench Verified | Round 2 blind-hard | web framework |
| 20 | `20-verified-astropy-13398` | SWE-bench Verified | Round 2 blind-hard | astronomy lib |
| 21 | `21-verified-sympy-16597` | SWE-bench Verified | Round 2 blind-hard | symbolic math |
| 22 | `22-verified-sphinx-9461` | SWE-bench Verified | Round 2 blind-hard | docs tooling |

Tasks 11, 15, and 17 are **excluded** from the runnable corpus: each pins
Python 3.6 in `task.json`, which `uv` cannot provision, so they fail selection
criterion #2 and cannot be built locally.

## Cherry-pick candidates for future expansion

83 SWE-bench Lite tasks are in the all-Sonnet-failed intersection. By repo:

| Repo | Count | Notes |
|---|---|---|
| sympy | 30 | Math/symbolic — many SAT-like; high difficulty |
| django | 21 | Web framework — varied; manageable |
| matplotlib | 8 | Plotting — UI-heavy; tricky to verify |
| sphinx-doc | 7 | Docs tooling — manageable |
| scikit-learn | 5 | ML — domain-specific |
| astropy | 3 | Astronomy — domain-specific |
| pytest-dev | 2 | Test framework (1 picked) |
| pylint-dev | 2 | Linter (1 picked) |
| pydata | 2 | Domain libs |
| pallets | 2 | Flask + co (1 picked) |
| mwaskom | 1 | seaborn |

`/tmp/all-sonnet-failed.txt` (build artifact) has the full list.

## What you DON'T find here

- Full SWE-bench Lite (300 tasks). Out of scope until the curated subset proves out.
- LLM-as-judge scorers (issue #29).
- Multi-language tasks (Rust, Go).
- Private/TMB-curated tasks.
