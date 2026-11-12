# Golden Prompts

The guide for writing and checking a TMB prompt (`CLAUDE.md`, `agents/*.md`, skills, commands): a checklist of yes/no criteria with real examples. The evidence behind each criterion lives in [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md), the research reference; each criterion names its rule there and carries that rule's evidence tier.

---

## Definition

A prompt is golden when it passes every criterion below, grades A on the rubric in [`ENFORCEMENT.md`](ENFORCEMENT.md) ("Grading a prompt surface"), and has a representative eval set showing no regression after its last wording change.

Golden is earned, not a style. The eval set is required because rule 7 is the only T1-backed way to call one wording better than another; the other criteria only make a prompt a strong candidate.

---

## Criteria

The criteria follow the order in which you write or read a prompt, one category at a time:

| Category | Asks |
|---|---|
| Identity | Who is the agent, and what one job does it own? |
| Content | What belongs in the prompt, and how is it laid out? |
| Wording | How is each rule phrased? |
| Output | What does the agent produce, and what shows the shape? |
| Consistency | Does the whole file agree with itself, other prompts, hooks and code? |
| Validation | Did an eval show no regression? |

`Rule` is the rule number in [`PROMPT_ENGINEERING.md`](PROMPT_ENGINEERING.md#core-rules), or the section of [`ENFORCEMENT.md`](ENFORCEMENT.md) that holds the TMB-specific rule. `Tier` copies that rule's tier. `How checked` is `deterministic` when a grep, lint or script could check it, `judgment` when a reader has to.

| Category | ID | Check | Rule | Tier | How checked |
|---|---|---|---|---|---|
| Identity | G1 | The role and objective are in the first lines. | 5 | T1 | judgment |
| Identity | G2 | The prompt does only its agent's job: it names what it receives, hands its output over in the shape the next agent expects, and redoes no check another agent owns. | ENFORCEMENT.md, Each prompt owns one job | none (convention) | judgment |
| Content | G3 | Situational or optional detail lives in a skill or command, not the always-loaded prompt. | 2 | T1 | judgment |
| Content | G4 | The rules are few and concrete, and the most important come first; "use good judgment" with no criteria is not a rule. | 1, 10 | T1 | judgment |
| Content | G5 | The prompt uses one structure style throughout, and a prompt that mixes instructions, context, examples, and inputs tags each part. | 3 | T1; T3 for tags | judgment |
| Content | G6 | Tool output, fetched pages, files, and comments sit in named tags marked as data, and what the agent may do with them is enforced in a hook or gate. | 14 | T2 boundary; T3 tags | judgment |
| Wording | G7 | Each prohibition names what to do instead, and none names a word only to forbid it. | 9 | T2 (mixed) | judgment |
| Wording | G8 | Each non-obvious rule gives its reason. | 13 | T3 | judgment |
| Wording | G9 | No emphasis words (CRITICAL, MUST, ALL CAPS, ALWAYS, NEVER) appear outside true invariants. | 12 | T3 | deterministic |
| Wording | G10 | There is no expert persona, "think step by step", tip, threat, flattery, or urgency boilerplate. | 4, 5, 6 | T1 | deterministic |
| Output | G11 | Examples match the wanted output format, and there are 3 to 5 varied ones where a format needs them. | 8 | T2 | judgment |
| Output | G12 | The output shape is stated (a schema, a section layout, a table). | 10 | T2 | judgment |
| Consistency | G13 | No rule contradicts another rule, another prompt, or a hook; where two can collide, the precedence is stated. | 10 | T2 | judgment |
| Consistency | G14 | No rule is duplicated across sections. | 10 | T2 | judgment |
| Consistency | G15 | Tool and skill descriptions match the code they describe. | 11 | T2 | judgment |
| Validation | G16 | An eval set of representative cases exists and was re-run after the last wording change. | 7 | T1 | deterministic |

---

## Agent prompts

A prompt is a contract, not a wish: it states the role, the inputs, the steps, the output, and the boundaries. An agent's prompt adds tool use, autonomy, and multi-turn state, so it also covers these. They are vendor practice with no tier of their own.

- **Name the loop.** Make the cycle explicit: orient, verify context, act, verify the result, report.
- **Verify before finalizing.** Tell the agent to check its work against the spec or success criteria before it declares done, and to surface failures.
- **Ground claims and allow "unknown".** Give the agent a retrieval path and an explicit route to ask or say "unknown" instead of guessing.
- **Set autonomy boundaries.** Say what the agent may do unprompted and what needs confirmation (irreversible, outward-facing, or destructive actions). Tell it to surface disagreement, then yield to the human.
- **Use what the harness gives.** When identity, state, or context arrive each turn, tell the agent to use them instead of fetching them again.

---

## Golden excerpts

Copied verbatim from current prompt files.

**`CLAUDE.md`, "You are bro"** (G1, G7)

```text
You plan the work, route it, and gate it at every step. You don't write production code yourself: that goes to **swe**, and **code-reviewer** judges whether the diff breaks other behaviour before anything is pushed.
```

The role and job come first, and the one prohibition names who does the work instead.

**`CLAUDE.md`, "Skills"** (G3, G8)

```text
Load the skill when its trigger fires — it carries the procedure so this file stays short.
```

Procedure lives in a skill, and the line says why.

**`CLAUDE.md`, "Voice"** (G7)

```text
Relaxed and natural, but precise. Short and action-first — trim filler, but don't clip so hard you drop context a reader needs.
```

The prohibition is paired with the wanted action and the limit on it.

**`skills/tmb_planning/SKILL.md`, "5. Spawn SWE" > "Spawning SWE"** (G8, G9)

```text
- The spawn prompt MUST contain the literal `task_id=<N>` from the `task_provision` response — a bare `task_id 5` without `=` fails the gate.
```

`MUST` guards a true invariant, and the line states the reason: anything else fails the gate.

**`agents/swe.md`, "How you write code"** (G7, G8)

```text
- **Solve the general case.** Never special-case a test's inputs, hard-code its expected output, or edit a test so it passes; read paths, limits and IDs from config or data. When a test or the spec looks wrong, leave it unchanged and close `failed`, naming it and why.
```

Each prohibition comes with what to do instead, including the case where the rule seems wrong.

---

## Vendor exemplars

- [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts): how a production prompt orders identity, behavior, and formatting, and how it changes between model versions.
- [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): keeping the always-loaded context small and loading the rest just in time (G3, G4).
- [Anthropic, Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): writing tool descriptions and outputs the model can act on, and testing them with evals (G15, G16).

---

## Negative examples

The repo's current prompts are near-clean, so each pair below is `constructed`.

**1. Emphasis on an ordinary rule** — `constructed`, fails G9

- Before: `CRITICAL: You MUST ALWAYS run the linter before committing!!!`
- After: `Run the linter before you commit.`

**2. Bare prohibition** — `constructed`, fails G7

- Before: `Don't write long reports.`
- After: `Keep the report to the return line and at most 4 short lines; put detail in the completion report.`

**3. Persona and tip boilerplate** — `constructed`, fails G10

- Before: `You are a world-class 10x engineer. Take a deep breath. I'll tip $200 for a perfect answer.`
- After: `You are swe. You execute one task spec from bro in an isolated git worktree.`

**4. Duplicated, contradicting rule** — `constructed`, fails G13 and G14

- Before: `Boundaries`: "Commit only when the spec is done." `Workflow`: "Commit after every file you change."
- After: one rule in `Workflow`: "Commit once the spec is done; when you hand back early, commit the work in progress first."

**5. Situational detail in the always-loaded prompt** — `constructed`, fails G3

- Before: a persona that inlines the twelve steps of the release procedure.
- After: `When the Human asks for a release, load the release skill.`

**6. Rule with no reason** — `constructed`, fails G8

- Before: `Read only the line range the brief gives.`
- After: `Read the line range the brief gives, and the whole file only when no range covers what you need, so the context stays short.`

---

## How to use

- **Author:** self-score a prompt change against the Criteria table in the PR description, one line per G-id (pass, fail, or not applicable), and name the eval set and its result for G16.
- **Reviewer:** trust the `deterministic` rows to lints and scripts and spot-check the `judgment` rows against the diff.
