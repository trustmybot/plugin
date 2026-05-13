# L7 bench tasks — cherry-picked from public benchmarks

This dir holds the curated agentic-SWE corpus for `run-bench.sh`. Tasks are
**cherry-picked** from public benchmarks (SWE-bench Lite, Aider's bench) so
the harness produces externally credible signal without committing to a full
publication-grade run.

## Selection criteria

A task qualifies when it meets all of:

1. **Public + citable** — from a published benchmark (SWE-bench Lite,
   Aider's polyglot bench, etc.). Skip if proprietary or in-house.
2. **Single-repo Python or TypeScript** — TMB's primary target. Multi-repo
   workspaces add chain-of-trust complexity that's separately tested at L4.
3. **Clear test signal** — task ships with a verifiable pass/fail
   (`pytest -q ...`, `npm test`, etc.). The verify.sh just wraps this.
4. **Bounded scope** — completable in 1–3 SWE turns when bro routes it
   properly; ≤200k tokens for the tmb-on arm. Unbounded tasks (full app
   redesign) are out of scope for the MVP.
5. **Diverse failure modes across the corpus** — a mix of:
   - bug fix (regressions, type errors)
   - small feature (new function, API endpoint)
   - refactor (extract helper, rename + ripple)
   - test backfill
   - architectural change (touches an ADR-required area)

## Task directory shape

```
NN-short-slug/
├── README.md         — task description, source link, verify contract
├── task.json         — { source: "swe-bench-lite", id: "...", version: "..." }
├── prompt.txt        — the user prompt sent to both arms (verbatim)
├── setup.sh          — clones / patches the project into $1 ($PROJECT)
└── verify.sh         — exits 0 on pass; arm's project state in $1
```

## Corpus (TBD)

The MVP will pick **5–7 tasks** balancing the diversity criteria above.
Cherry-pick candidates to evaluate:

| Source | Candidate | Why |
|---|---|---|
| SWE-bench Lite | `django/django-15498` (utility bug) | Real PR-grade bug fix; small diff; clear pytest signal |
| SWE-bench Lite | `sympy/sympy-13647` (math edge case) | Multi-file change; test backfill |
| Aider Python | `wordcount` exercise | Small feature; clear unit-test contract |
| Aider Python | `acronym` exercise | Refactor + edge case; small footprint |
| TMB-curated | `add-cli-entry-point` | Mirrors L5 row 12 (issue-resume); architectural-impact-ish |
| TMB-curated | `schema-column-add` | Touches docs/trustmybot/architecture/ → tests ADR detection |

Each cherry-pick will have a corresponding directory here. Open question
(per #6): which subset best surfaces the **three axes** without over-indexing
on any single doctrine slice.

## What you DON'T find here

- The full SWE-bench Lite (300 tasks). Out of scope until the harness is
  proven against the curated subset.
- LLM-as-judge scorers for the quality axis (issue #29). The mechanical
  scorer (`scorers/quality.sh`) handles the load-bearing checks.
- Multi-language tasks (Rust, Go). Single-language MVP first; expand
  after the harness pattern is validated.
