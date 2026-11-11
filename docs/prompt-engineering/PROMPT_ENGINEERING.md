# Prompt Engineering

How we write prompts for agents in TMB: personas (`CLAUDE.md`, `agents/*.md`), skills, and commands. Each rule below names how strong its evidence is and where the evidence comes from.

> Rule of thumb: a prompt is a contract, not a wish. State the role, the inputs, the steps, the output, and the boundaries.

---

## Evidence tiers

| Tier | Meaning |
|------|---------|
| **T1** | A controlled study with statistics on frontier or near-frontier models. |
| **T2** | Vendor guidance backed by a reported measurement, or controlled studies only on older or smaller models, or mixed results. |
| **T3** | A vendor heuristic with no published data. |

Almost no study tests multi-turn, tool-using coding agents. Treat T1 rules as strong priors, not guarantees.

Source keys in square brackets point to [References](#references).

---

## Core rules

1. **Keep instructions few, and put the most important first.** Models follow fewer instructions better, and follow early instructions more reliably than late ones. Cut a rule before you add one. *T1* [IFScale] [ManyIFEval]
2. **Keep the context short.** Accuracy falls as input grows, even when finding the relevant part is easy. Give the model what this task needs and point to the rest (a skill, a file, a retrieval tool). When a prompt carries long documents, put them first and the ask last; Anthropic measured up to 30% better answers that way. *T1* [Levy] [NoLiMa] [Du]; *T2* add-on [Anthropic-LongCtx]
3. **Use one consistent structure style.** Small format changes (separators, casing, spacing, headings) swing accuracy, and no format is best for every model. Pick one style per prompt and keep it. No controlled study compares XML with Markdown. *T1* [Sclar] [Mizrahi] [He]
4. **Skip "think step by step" on reasoning models.** Chain-of-thought prompting helps mostly on math and symbolic tasks (symbolic +14.2, math +12.3, other tasks +0.7 points), and adds little for models that already reason. *T1* [Sprague] [Meincke-CoT]
5. **Use a role for scope and voice, not for accuracy.** Expert personas do not raise accuracy. A role line still tells the agent its job, its team, and how to speak. *T1* [Zheng] [Basil]
6. **Leave out tips, threats, flattery, urgency, and politeness tricks.** None has a reliable effect. *T1* [Meincke-Tips] [Meincke-PSR1]
7. **Validate wording changes with evals.** Wording effects are model-specific, and a change that helps on average can swing single cases either way. Keep a set of representative cases, change one thing at a time, and measure. *T1* [Meincke-Tips] [Mizrahi]
8. **Use examples to teach format, and expect them to be copied.** Examples teach output shape more than content, and the model copies their details. Give 3 to 5 varied examples that match the output you want. Their order changes results. *T2* [Min] [Lu]
9. **State the action you want; keep a prohibition only for a hard limit.** When a positive form exists, use it: "write in prose paragraphs" over "don't use bullet points". Keep a prohibition when it is the clearest statement of a hard limit, and pair it with what to do instead. Avoid naming a word or topic only to forbid it. Enforce a hard limit outside the prompt, in a hook, schema, or gate. The evidence is mixed: an "avoid X" instruction cut mentions of X on GPT-4 but raised them on 7B models [Castricato], and the negation weakness NeQA found shrinks on larger models [NeQA]. No controlled study supports a blanket ban on negative instructions for frontier models. *T2 (mixed)* [Castricato] [NeQA]
10. **State scope and output exactly, and resolve contradictions.** Current models follow instructions literally: they do what the prompt says, not what it implies. Name the output shape (a schema, a section layout, a table). Two rules that conflict, within a prompt, across prompts, or between a prompt and a hook, cost more than on older models. Pick one rule or state the precedence ("X, unless Y, then Z"). A prompt that asks for something a hook blocks is a guaranteed stall. *T2* [Anthropic-Claude4] [OpenAI-GPT5]
11. **Write tool and skill descriptions as carefully as the prompt body.** The model picks tools and skills from their descriptions. Anthropic's SWE-bench agent work spent more effort on tool descriptions than on the main prompt. Keep each description accurate and current. *T2* [Anthropic-Agents]
12. **Save emphasis for true invariants.** Words like CRITICAL, MUST, and ALL CAPS make current Claude models over-apply a rule. Write rules in a normal tone, and keep ALWAYS or NEVER for the few that hold without exception. *T3* [Anthropic-Claude4]
13. **Give the reason behind a non-obvious rule.** A short "because" helps the model apply the rule to cases the text did not foresee. This is untested. *T3* [Anthropic-Claude4]

---

## Popular advice without support

- **Expert personas raise accuracy.** Controlled studies find no gain [Zheng] [Basil].
- **Tips, threats, flattery, and politeness improve answers.** No reliable effect [Meincke-Tips] [Meincke-PSR1].
- **ALL CAPS or CRITICAL makes a rule stick.** No published data; current Claude over-applies emphasized rules [Anthropic-Claude4].
- **XML is always the best structure.** No controlled XML-versus-Markdown study exists, and format effects differ by model [Sclar] [He].
- **"Think step by step" helps reasoning models.** Gains are small outside math and symbolic tasks [Sprague] [Meincke-CoT].
- **More examples are always better.** Examples mostly teach format, gains level off after a few, and their order changes results [Min] [Lu].
- **The "26 principles".** The study reports no significance tests [Bsharat].

---

## Prompting agents specifically

Agentic prompts add tool use, autonomy, and multi-turn state:

- **Name the loop.** Make the cycle explicit: orient, verify context, act, verify the result, report.
- **Verify before finalizing.** Tell the agent to check its work against the spec or success criteria before it declares done, and to surface failures.
- **Ground claims and allow "unknown".** Give the agent a retrieval path and an explicit route to ask or say "unknown" instead of guessing.
- **Set autonomy boundaries.** Say what the agent may do unprompted and what needs confirmation (irreversible, outward-facing, or destructive actions). Tell it to surface disagreement, then yield to the human.
- **Use what the harness gives.** When identity, state, or context arrive each turn, tell the agent to use them instead of fetching them again.

---

## TMB conventions

- **Personas hold day-to-day behavior plus pointers; procedures live in skills and commands.** `CLAUDE.md` says what bro does every turn and names `/onboard`, `/tmb:agent-create`, and `tmb_planning` without inlining their steps.
- **Order a persona like an onboarding doc.** Identity, team, verify context, route, the work flow, voice. A cold-start agent reads it in the order it acts.
- **No citation noise in prompt files.** Issue numbers, PR URLs, and "caught in X" load every turn and earn nothing. Citations belong in commits, PRs, and issues.
- **One place per rule.** Tables for routing; merge sections that say the same thing. Duplicated rules drift into conflict.
- **Fix model misbehavior structurally.** A hook, a `requireRoles` gate, or a schema beats another sentence in the prompt.
- **Core prompts stay minimal; depth is a cheatcode.** Each shipped prompt (`CLAUDE.md`, an agent, a skill) carries one idea: the wiring that makes TMB work. Rubrics, checklists, persona and style guidance, and domain heuristics arrive as cheatcodes ([`CHEATCODES.md`](../architecture/CHEATCODES.md)); a paragraph that teaches a technique instead of wiring a role belongs in one.

---

## Anti-patterns

- The same instruction repeated in several sections.
- Vague directives ("be smart", "use good judgment") with no criteria.
- A prohibition with no "do this instead", or one that names a word only to forbid it.
- Emphasis words on ordinary rules; persona, tip, or threat boilerplate.
- Situational or optional content in the always-loaded prompt.
- Tool or section descriptions that contradict the code they describe.
- Examples that do not match the requested output format.

---

## Pre-ship checklist

- [ ] Role and objective clear in the first lines.
- [ ] Instructions specific; a positive form wherever one exists, and each prohibition paired with what to do instead.
- [ ] Few rules, the most important first, one structure style.
- [ ] Examples for any non-obvious format, matching the wanted output.
- [ ] Output shape specified.
- [ ] A grounding path and an explicit route to ask or say "unknown".
- [ ] Scope and escalation boundaries stated, with no conflicting rules.
- [ ] Lean: optional detail pushed to a skill or command.
- [ ] No duplication, no stale references, no citation noise.
- [ ] Tested against representative cases.

[`GOLDEN_PROMPTS.md`](GOLDEN_PROMPTS.md) turns this checklist into scored criteria with examples.

---

## Deeper doctrine

**[`ENFORCEMENT.md`](ENFORCEMENT.md)** applies these rules to TMB and is required reading before you write load-bearing prompt logic. It carries the six enforcement layers (MCP server → hooks → frontmatter → schema → skill paths → **prompts**), the rule that *a step the LLM can forget, misorder, or misunderstand does not belong in a prompt*, the boundary test with its compound-failure math, the coverage matrix, and the grading rubric. Its "Positive prompts as the floor" section applies the negation rule (rule 9) to the prompt layer.

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

This rule is enforced by the L3 ordering tests.

---

## References

- **[IFScale]** Jaroslawicz et al., 2025. Preprint. arXiv 2507.11538. 20 models, including Claude Opus 4.
- **[ManyIFEval]** Harada et al., 2025. EMNLP 2025. arXiv 2509.21051.
- **[Levy]** Levy, Jacoby, and Goldberg, 2024. ACL 2024. arXiv 2402.14848.
- **[NoLiMa]** Modarressi et al., 2025. ICML 2025. arXiv 2502.05167.
- **[Du]** Du et al., 2025. Findings of EMNLP 2025. arXiv 2510.05381.
- **[Sclar]** Sclar et al., 2024. ICLR 2024. arXiv 2310.11324.
- **[Mizrahi]** Mizrahi et al., 2024. TACL. arXiv 2401.00595.
- **[He]** He et al., 2024. Preprint. arXiv 2411.10541.
- **[Sprague]** Sprague et al., 2025. ICLR 2025. arXiv 2409.12183.
- **[Meincke-CoT]** Meincke et al., 2025. Preprint. arXiv 2506.07142.
- **[Zheng]** Zheng et al., 2024. Findings of EMNLP 2024. arXiv 2311.10054.
- **[Basil]** Basil et al., 2025. Preprint. arXiv 2512.05858.
- **[Meincke-Tips]** Meincke et al., 2025. Preprint. arXiv 2508.00614.
- **[Meincke-PSR1]** Meincke et al., 2025. Preprint. arXiv 2503.04818.
- **[Min]** Min et al., 2022. EMNLP 2022. arXiv 2202.12837.
- **[Lu]** Lu et al., 2022. ACL 2022. arXiv 2104.08786.
- **[Castricato]** Castricato et al., 2024. Preprint. arXiv 2402.07896.
- **[NeQA]** Zhang et al., 2023. Findings of ACL 2023. arXiv 2305.17311.
- **[Bsharat]** Bsharat et al., 2023. Preprint. arXiv 2312.16171.
- **[Anthropic-Claude4]** Anthropic, Claude prompting best practices (Claude 4 models). https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- **[Anthropic-LongCtx]** Anthropic, long context prompting tips. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips
- **[Anthropic-Agents]** Anthropic, Building effective agents (appendix on prompt-engineering tools, from the SWE-bench agent work). https://www.anthropic.com/engineering/building-effective-agents
- **[OpenAI-GPT5]** OpenAI, GPT-5 prompting guide. https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
