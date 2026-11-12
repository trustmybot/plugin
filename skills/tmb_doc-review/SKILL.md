---
name: tmb_doc-review
description: The one prompt-quality checklist for a change to prompt or docs files — load the project's rubric at the base ref, grade each rubric id the change touches, fact-check every claim about the code with a probe, and scan the other prompt files for contradictions. bro runs it on its specs and its own no-code changes, swe before closing a prompt-bearing task, code-reviewer when grading one.
allowed-tools: Read, Grep, Glob, Bash
---

# Prompt-change checklist

This is the one checklist for writing or judging a change to a prompt or docs file. bro runs it on a spec and on its own no-code changes, swe runs it before closing, and code-reviewer grades with it. Author and reviewer load the same rubric from the same ref, so a change that passes the author's check passes review for the same reasons.

## When it applies

Run it when either holds:

- The task is prompt-bearing: `task_get` returns `prompt_bearing: 1`. A task whose `files[]` reach agent, skill, command or template prompt files is prompt-bearing.
- A path the change touches matches a `prompts.paths` or `docs.paths` glob in the path-classes file that step 1 reads.

Otherwise the change is code, and the code review alone applies.

## The checklist

`<repo_path>` is the repository, `<commit>` the commit under review (the author's own commit when self-checking), and `<base>` the branch the change merges into.

1. **Load the rubric at the base ref.** Read `git -C <repo_path> show origin/<base>:.config/tmb/path-classes.json`; when its `prompts.rubric` lists files, read each with `git -C <repo_path> show origin/<base>:<path>` and grade against the criterion ids those files define. When the file is missing, has no `prompts.rubric` key or lists none, use `RUBRIC.md` beside this skill (`${CLAUDE_PLUGIN_ROOT}/skills/tmb_doc-review/RUBRIC.md`) and its `R<n>` ids. The base ref is the reason: a change that edits the rubric or the path-classes file is still judged by the copy it started from. When a listed rubric file is absent at the base, grade with the rest, fall back to `RUBRIC.md` only when none is left, and say which file was missing.
2. **Grade every rubric id the change touches.** For each criterion whose subject the changed lines carry (a rule, a prohibition, an output shape, a tool description), record `<id>: pass | fail | n/a` with the `file:line` it rests on. Grade the changed lines and the rules they change; a failure only in untouched lines is `pre_existing`.
3. **Fact-check every claim about the code.** Each changed line that states a fact about the code — a tool name or parameter, a CLI subcommand or the values it accepts, what a hook or gate enforces, a file path, a config key, a returned field — is checked against the source at `<commit>` (`git -C <repo_path> grep -n '<name>' <commit> -- <dir>`, `git -C <repo_path> show <commit>:<file>`), or, for a tool or CLI the repository does not hold, against its published schema or `--help`. Another doc saying the same thing is not evidence, because docs drift together. Record one probe per claim: `{target, probe_cmd, observed}`. A claim the source contradicts is false; a claim with no source you can read is unverifiable.
4. **Scan for contradictions.** For each rule the change adds, changes or removes, grep for other statements of it, by its key terms and the tool, flag or path it names, in two places: the files the changed prompt references (skills it loads, files and tools it names) and the other prompt-class files at `<commit>` (`git -C <repo_path> grep -n -e '<term>' <commit> -- <globs>`, with the `prompts.paths` globs from step 1, or the repository's agent, skill, command and `CLAUDE.md` files when there is no config). Two statements that cannot both hold contradict, unless one of them states which wins. Record one probe per rule scanned, `{target, probe_cmd, observed}`, whether or not it found a contradiction.
5. **Write the verdict.** Apply the fail bar below to the results of steps 2–4.

bro runs steps 1–4 on its own no-code change before it asks for review, and swe runs them before it closes; each fixes every blocking result first. code-reviewer runs all five.

## The fail bar

A finding is `blocking` only when one of these holds:

- A rubric id fails on the changed lines (step 2).
- A claim about the code is false or unverifiable (step 3).
- Two files contradict (step 4).

Anything else — a better wording, a shorter form, a structure you would prefer — is a `nit`, which rides on a pass.

## Recording findings

Each finding carries:

| Field | Content |
|---|---|
| `class` | The rubric id that failed (`R5`, or the project rubric's own id), `fact` for a false or unverifiable claim, or `consistency` for a contradiction |
| `severity` | `blocking` by the fail bar, else `nit` or `pre_existing` |
| `criterion_id` | The spec `SC<n>` id the changed line serves; omit it when none |
| `probe_cmd` | A self-contained command run from the worktree root that exits 0 once the defect is fixed and non-zero while it stands: the grep that finds the source agreeing with the corrected claim, or `! grep -n '<offending text>' <file>` for wording that has to go |
| `expected` | What the line should say, citing the rubric id, the source `file:line` or the other file's line |
| `observed` | The changed line, with its `file:line` |

code-reviewer records these findings in the same `validation_record` verdict as the rest of its review, and on a pass records each step 3 and step 4 probe in `probes[]`.
