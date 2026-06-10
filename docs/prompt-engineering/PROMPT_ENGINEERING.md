# Prompt Engineering

How we write prompts for agents in TMB — personas (`CLAUDE.md`, `agents/*.md`), skills, and commands. The techniques are mainstream prompt engineering (clear instructions, few-shot, chain-of-thought, ReAct-style tool loops, grounding) adapted for **agentic, tool-using** models that plan, act, and verify over many turns.

> Rule of thumb: a prompt is a contract, not a wish. State the role, the inputs, the steps, the output, and the boundaries — explicitly.

---

## The core principles

1. **Be explicit and specific.** Ambiguity is the top failure mode. Replace "handle errors well" with "on a failed API call, retry twice then return `{error}`." If you mean a format, show the format.
2. **Open with role + objective.** The first lines should answer "who am I and what am I for?" — e.g. `You are bro … plan, route, gate.` Identity primes everything after it.
3. **Give the *relevant* context, not all context.** Ground the model in what it needs for *this* task. For everything else, tell it *where to look* (retrieval, a skill, a file) instead of inlining it.
4. **Structure the prompt.** Headings, tables, and lists are parsed more reliably than prose walls. Put the most important instructions early; restate a hard constraint near the end if it's critical (primacy + recency).
5. **Show, don't only tell.** One to three representative examples (few-shot) beat paragraphs of description for format and style. Keep examples consistent with the output you actually want.
6. **Specify the output.** Exact shape — a JSON schema, a markdown section layout, a table. For tools, define parameter schemas precisely; the model selects and fills tools from their descriptions.
7. **Let it reason before it answers — when it helps.** Chain-of-thought / a short plan improves multi-step and analytical tasks. Skip it for trivial or latency-sensitive ones. For agents: *plan → act → verify*, don't jump straight to a tool call.
8. **Prefer positive instructions over prohibitions.** Tell the model what *to do*. Negative-only rules ("never mention X") often backfire — naming the thing makes it more likely (pink-elephant). Fix recurring errors *structurally* (a guard, a schema, a hook) or by positive disambiguation, not by piling on "don'ts."
9. **Ground, cite, and allow an "I don't know."** Instruct the model to base claims on evidence, cite sources when it matters, and ask or say "unknown" rather than guess. Give it a retrieval path and an explicit out for uncertainty.
10. **Set scope and escalation.** Define what's in bounds, what to refuse, and *when to ask the human vs act autonomously*. An agent with no stop conditions either stalls or overreaches.
11. **Decompose.** One job per prompt. Break complex work into steps or hand subtasks to specialized prompts/agents. Long monolithic instructions degrade.
12. **Budget the context window.** A system prompt is paid on every turn. Keep it lean; push situational or optional detail into on-demand surfaces (skills, commands, retrieval). Summarize long histories instead of carrying them whole.
13. **Iterate against evals.** Prompting is empirical. Keep a set of representative cases, change one thing at a time, and measure — don't tune by vibes.
14. **Never ship conflicting instructions.** Two rules that contradict each other — within one prompt, across prompts, or between a prompt and a deterministic layer (a hook, schema, or tool) — force the model to guess which one wins, and its guess won't be stable. Resolve the conflict when you write it: pick one rule, or state the precedence explicitly ("X, unless Y → then Z"). The cross-layer case is the worst — a prompt that tells the model to do something a hook will block is a guaranteed stall. The structural defense is one source of truth per rule; duplicated rules drift into conflict over time.

---

## Prompting agents specifically

Agentic prompts add tool use, autonomy, and multi-turn state on top of the basics:

- **Name the loop.** Make the operating cycle explicit — orient → verify context → act → verify result → report. A clear sequence is worth more than a list of capabilities.
- **Tool descriptions are part of the prompt.** The model chooses tools from their descriptions, so keep them accurate, unambiguous, and current. A description that drifts from the implementation silently misroutes the agent.
- **Verify before finalizing.** Tell the agent to check its own work against the spec / success criteria before declaring done — and to surface, not bury, failures.
- **Autonomy boundaries.** Spell out what the agent may do unprompted vs. what needs confirmation (irreversible, outward-facing, or destructive actions). Tell it to surface disagreement and then yield to the human.
- **Don't re-fetch what you're given.** If identity, state, or context arrive via the harness each turn, instruct the agent to use them rather than re-querying.
- **Pointer, not procedure (context budget).** The always-loaded persona carries day-to-day behavior plus *one-line pointers* to occasional capabilities. The procedure for each lives in the skill/command it points to, loaded on demand.

---

## TMB conventions

How the above lands in this repo:

- **Personas hold 100% day-to-day behavior + pointers; procedures live in skills/commands.** `CLAUDE.md` says *what bro does every turn* and names `/onboard`, `/roundtable`, `/tmb:agent-create`, `tmb_planning` — it doesn't inline their ceremonies.
- **Order a persona like an onboarding doc.** Identity → team → verify context → route → the work flow → voice. A cold-start agent reads it in the sequence it acts.
- **No citation noise in prompt files.** Issue numbers, PR URLs, "caught in X" — these load every turn and earn nothing. Citations belong in commits, MRs, and issues.
- **Self-documenting and trimmed.** Tables for decision-routing; no duplication across sections; cut filler. If two sections say the same thing, merge them.
- **Fix model misbehavior structurally.** A hook, a `requireRoles` gate, or a schema beats a new "never do X" sentence.

---

## Anti-patterns

- Wall-of-text system prompts, or the same instruction repeated in three sections.
- Vague directives — "be smart," "use good judgment" — with no criteria.
- Negative-only rules / pink-elephant phrasing.
- Stuffing the always-loaded prompt with situational or optional content.
- Tool or section descriptions that contradict the code they describe.
- Examples that don't match the requested output format.

---

## Pre-ship checklist

- [ ] Role and objective clear in the first lines.
- [ ] Instructions specific, and phrased positively.
- [ ] Structured (sections / tables); the most important rule appears early.
- [ ] Examples for any non-obvious format or style.
- [ ] Output shape specified.
- [ ] A grounding path and an explicit uncertainty/ask route.
- [ ] Scope and escalation boundaries stated.
- [ ] Lean — optional detail pushed to a skill/command, not inlined.
- [ ] No duplication, no stale references, no citation noise.
- [ ] Tested against representative cases.

---

## Deeper doctrine

Two architecture docs formalize the principles above for TMB — required reading before you write load-bearing prompt logic:

- **[`DETERMINISM.md`](DETERMINISM.md)** — the determinism-vs-judgment layering rule: *if a step can fail because the LLM forgot, misordered, or misunderstood it, it doesn't belong in a prompt.* Carries the compound-failure math (a 5-step procedure ≈ 77% adherence at 95%/step) and a boundary test for deciding what stays in prose vs. migrates to a deterministic mechanism. This is the rigorous form of principles 11–12 (decompose, budget the window).
- **[`ENFORCEMENT.md`](ENFORCEMENT.md)** — the six enforcement layers (MCP server → hooks → frontmatter → schema → skill paths → **prompts**) and the coverage matrix. Prompts are the *softest* layer; anything load-bearing should sit higher. Its "positive prompts as the floor" section is the pink-elephant rationale behind principle 8.

Together they explain *why* we keep personas lean and fix recurring failures structurally rather than with more prose.

## Cache zones

CC's prompt cache anchors from the start of the assembled prompt and breaks at the first byte-difference. TMB structures its context surface into three zones to maximise stable-prefix length:

| Zone | Content | Stability |
|------|---------|-----------|
| **A — stable identity** | Plugin persona (`CLAUDE.md`), MCP tool descriptions — fixed across all sessions and users | Stable |
| **B — semi-stable bodies** | Skill bodies, rule files — change only on plugin upgrades | Semi-stable |
| **C — volatile hook tails** | Hook-injected context (counts, banners, branch, last commits) — changes every session or turn | Volatile |

**Contract for hook authors:** every hook that injects `additionalContext` must put stable descriptive text first and volatile fields (counts, timestamps, paths, branch names) at the tail of its own output. A hook that opens with a volatile line busts the cache for everything below it in the assembled prompt.

Examples of volatile fields that belong at the tail:
- Current branch name, commit count, dirty-path count
- Open issue count, pending task count
- Last-N commit messages
- DB path, plugin source path
- Any timestamp or PID

This rule is encoded in `.claude/rules/hooks.md` and enforced by the L3 ordering tests.
