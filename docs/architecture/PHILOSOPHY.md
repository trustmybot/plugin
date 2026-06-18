# Design philosophy

The principles behind how the TMB plugin is shaped — why the prompts are short, how the two review gates differ, and where the line sits between TMB's own development process and the runtime that ships to a user's project.

## 1. Minimal prompts, cheatcode add-ons

Every shipped prompt — `CLAUDE.md`, each file under `agents/`, each skill — is deliberately short. The rule is one idea per surface: an agent or skill carries exactly the one thing that makes the core TMB system work, and nothing more.

Fancy depth is not baked into a core prompt. Review rubrics, multi-phase checklists, persona and style guidance, domain heuristics — all of these are add-ons. They arrive through a cheatcode: a skill, MCP toolkit, or plugin installed on demand via the discover → vet → install → hot-load pipeline (see [`CHEATCODES.md`](./CHEATCODES.md)). The core stays lean so it loads fast and reads clearly every turn; the depth attaches when a task actually calls for it.

A practical test: if a paragraph in a core prompt teaches a specialized technique rather than wiring a role into the system, it belongs in a cheatcode, not the prompt.

## 2. Two review perspectives

The workflow has two review gates, and they look at different things.

- **bro reviews at the SYSTEM level.** The question bro answers is "does this change fit the whole system?" — does it belong in this milestone, does it respect the role boundaries, does it ripple into surfaces the spec didn't name, is it the right shape of work at all.
- **pr-reviewer reviews at the DIFF level.** The question pr-reviewer answers is "is this diff correct against its spec?" — does every named file and success criterion have a concrete change, does the verification pass, is anything out of scope.

The two perspectives are complementary by design. bro can approve the intent of a change it would never read line by line; pr-reviewer can verify a diff is faithful without re-litigating whether the work should have been done. Neither gate substitutes for the other.

## 3. Dev-vs-user-runtime boundary

ONLY `docs/` is TMB-internal. It documents how *this project* is built and operated: the L0–L6 test harness, the `trustmybot/plugin` repository itself, GitHub milestones and labels, the rc and release-gate flow, the contributing guide, and the benchmark campaign. None of `docs/` ships to a user's project.

Everything else is the shipped runtime, and it must be about THE USER'S project and fully self-contained:

- `CLAUDE.md`, `agents/`, `skills/`, `commands/`, `hooks/`, `templates/`
- the user-facing MCP server code

These surfaces must never reference TMB's own development process — no harness paths, no `L1`/`L5/L6` levels, no `tests/` directories, no internal milestone or release machinery. A user installing the plugin has none of that, so a prompt or hook that cites it leaks meaningless internal context and erodes trust. When a shipped surface needs to state a rule that TMB's docs also describe, it states the rule directly rather than pointing at a `docs/` file the user does not have.

The #135 and #140 cleanups enforce this boundary, sweeping dev-meta leaks out of the shipped runtime and keeping the internal references where they belong, in `docs/`.
