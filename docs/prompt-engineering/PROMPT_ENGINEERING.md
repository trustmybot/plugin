# Prompt Engineering

The research reference behind TMB's prompt rules. Each rule below names how strong its evidence is and where the evidence comes from. To write or check a prompt, use [`GOLDEN_PROMPTS.md`](GOLDEN_PROMPTS.md), the guide built on these rules.

The rules are ordered by evidence tier, strongest first, so a reader sees which claims rest on controlled studies; the guide orders the same rules the way a prompt is written.

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
2. **Keep the context short.** Accuracy falls as input grows, even when finding the relevant part is easy. Give the model what this task needs and point to the rest (a skill, a file, a retrieval tool). Leave issue numbers, PR links, and change history out of prompt files: they load every turn and belong in commits and issues. When a prompt carries long documents, put them first and the ask last; Anthropic measured up to 30% better answers that way. *T1* [Levy] [NoLiMa] [Du]; *T2* add-on [Anthropic-LongCtx]
3. **Use one consistent structure style, and tag the parts of a mixed prompt.** Small format changes (separators, casing, spacing, headings) swing accuracy, and no format is best for every model, so pick one style per prompt and keep it. For Claude, Anthropic recommends XML tags to separate instructions, context, examples, and inputs, with consistent tag names and nesting; no published study measures that gain on current Claude models. *T1* [Sclar] [Mizrahi] [He]; *T3* tags [Anthropic-Guide]
4. **Skip "think step by step" on reasoning models.** Chain-of-thought prompting helps mostly on math and symbolic tasks (symbolic +14.2, math +12.3, other tasks +0.7 points), and adds little for models that already reason. *T1* [Sprague] [Meincke-CoT]
5. **Use a role for scope and voice, not for accuracy.** Expert personas do not raise accuracy. A role line still tells the agent its job, its team, and how to speak. *T1* [Zheng] [Basil]
6. **Leave out tips, threats, flattery, urgency, and politeness tricks.** None has a reliable effect. *T1* [Meincke-Tips] [Meincke-PSR1]
7. **Validate wording changes with evals.** Wording effects are model-specific, and a change that helps on average can swing single cases either way. Keep a set of representative cases, change one thing at a time, and measure. *T1* [Meincke-Tips] [Mizrahi]
8. **Use examples to teach format, and expect them to be copied.** Examples teach output shape more than content, and the model copies their details. Give 3 to 5 varied examples that match the output you want. Their order changes results. *T2* [Min] [Lu]
9. **State the action you want; keep a prohibition only for a hard limit.** When a positive form exists, use it: "write in prose paragraphs" over "don't use bullet points". Keep a prohibition when it is the clearest statement of a hard limit, and pair it with what to do instead. Avoid naming a word or topic only to forbid it. Enforce a hard limit outside the prompt, in a hook, schema, or gate. The evidence is mixed: an "avoid X" instruction cut mentions of X on GPT-4 but raised them on 7B models [Castricato], and the negation weakness NeQA found shrinks on larger models [NeQA]. No controlled study supports a blanket ban on negative instructions for frontier models. *T2 (mixed)* [Castricato] [NeQA]
10. **State scope and output exactly, and resolve contradictions.** Current models follow instructions literally: they do what the prompt says, not what it implies. Name the output shape (a schema, a section layout, a table). Two rules that conflict, within a prompt, across prompts, or between a prompt and a hook, cost more than on older models. Pick one rule or state the precedence ("X, unless Y, then Z"), and state each rule in one place, since a copied rule drifts into conflict. A prompt that asks for something a hook blocks is a guaranteed stall. *T2* [Anthropic-Guide] [OpenAI-GPT5]
11. **Write tool and skill descriptions as carefully as the prompt body.** The model picks tools and skills from their descriptions. Anthropic's SWE-bench agent work spent more effort on tool descriptions than on the main prompt. Keep each description accurate and current. *T2* [Anthropic-Agents]
12. **Save emphasis for true invariants.** Words like CRITICAL, MUST, and ALL CAPS make current Claude models over-apply a rule. Write rules in a normal tone, and keep ALWAYS or NEVER for the few that hold without exception. *T3* [Anthropic-Guide]
13. **Give the reason behind a non-obvious rule.** A short "because" helps the model apply the rule to cases the text did not foresee. This is untested. *T3* [Anthropic-Guide]
14. **Mark untrusted input as data, and enforce trust outside the prompt.** Put tool output, fetched pages, files, and issue or PR comments inside named tags (`<tool_output>`, `<document>`) and say they are data to read, not instructions to follow. Tags help the model tell the parts apart, but they are not a security boundary: in-band defenses such as delimiters and spotlighting failed over 90% of the time under adaptive attack, while an out-of-band permission check cut attack success from 25.8% to 4.2%. Enforce what an agent may do in hooks and gates. *T3* tags [Anthropic-Guide]; *T2* boundary [Narisetty]

---

## Popular advice without support

- **Expert personas raise accuracy.** Controlled studies find no gain [Zheng] [Basil].
- **Tips, threats, flattery, and politeness improve answers.** No reliable effect [Meincke-Tips] [Meincke-PSR1].
- **ALL CAPS or CRITICAL makes a rule stick.** No published data; current Claude over-applies emphasized rules [Anthropic-Guide].
- **"Think step by step" helps reasoning models.** Gains are small outside math and symbolic tasks [Sprague] [Meincke-CoT].
- **More examples are always better.** Examples mostly teach format, gains level off after a few, and their order changes results [Min] [Lu].
- **Delimiters keep injected instructions out.** They fail under adaptive attack; only out-of-band checks held [Narisetty].
- **The "26 principles".** The study reports no significance tests [Bsharat].

---

## Deeper doctrine

**[`ENFORCEMENT.md`](ENFORCEMENT.md)** applies these rules to TMB and is required reading before you write load-bearing prompt logic. It carries the six enforcement layers (MCP server → hooks → frontmatter → schema → skill paths → **prompts**), the rule that *a step the LLM can forget, misorder, or misunderstand does not belong in a prompt*, the boundary test with its compound-failure math, the coverage matrix, the grading rubric, why core prompts stay minimal, why each prompt owns one job, and the prompt cache zones. Its "Positive prompts as the floor" section applies the negation rule (rule 9) to the prompt layer.

---

## References

Each entry ends with the date its link and claim were last checked. Re-check an entry when a new model generation ships.

- **[IFScale]** Jaroslawicz et al., 2025. Preprint. arXiv 2507.11538. 20 models, including Claude Opus 4. Verified 2026-11-12.
- **[ManyIFEval]** Harada et al., 2025. EMNLP 2025. arXiv 2509.21051. Verified 2026-11-12.
- **[Levy]** Levy, Jacoby, and Goldberg, 2024. ACL 2024. arXiv 2402.14848. Verified 2026-11-12.
- **[NoLiMa]** Modarressi et al., 2025. ICML 2025. arXiv 2502.05167. Verified 2026-11-12.
- **[Du]** Du et al., 2025. Findings of EMNLP 2025. arXiv 2510.05381. Verified 2026-11-12.
- **[Sclar]** Sclar et al., 2024. ICLR 2024. arXiv 2310.11324. Verified 2026-11-12.
- **[Mizrahi]** Mizrahi et al., 2024. TACL. arXiv 2401.00595. Verified 2026-11-12.
- **[He]** He et al., 2024. Preprint. arXiv 2411.10541. Verified 2026-11-12.
- **[Sprague]** Sprague et al., 2025. ICLR 2025. arXiv 2409.12183. Verified 2026-11-12.
- **[Meincke-CoT]** Meincke et al., 2025. Preprint. arXiv 2506.07142. Verified 2026-11-12.
- **[Zheng]** Zheng et al., 2024. Findings of EMNLP 2024. arXiv 2311.10054. Verified 2026-11-12.
- **[Basil]** Basil et al., 2025. Preprint. arXiv 2512.05858. Verified 2026-11-12.
- **[Meincke-Tips]** Meincke et al., 2025. Preprint. arXiv 2508.00614. Verified 2026-11-12.
- **[Meincke-PSR1]** Meincke et al., 2025. Preprint. arXiv 2503.04818. Verified 2026-11-12.
- **[Min]** Min et al., 2022. EMNLP 2022. arXiv 2202.12837. Verified 2026-11-12.
- **[Lu]** Lu et al., 2022. ACL 2022. arXiv 2104.08786. Verified 2026-11-12.
- **[Castricato]** Castricato et al., 2024. Preprint. arXiv 2402.07896. Verified 2026-11-12.
- **[NeQA]** Zhang et al., 2023. Findings of ACL 2023. arXiv 2305.17311. Verified 2026-11-12.
- **[Narisetty]** Narisetty, 2026. Preprint. arXiv 2606.26479. Adaptive attacks on in-band and out-of-band prompt-injection defenses, on AgentDojo. Verified 2026-11-12.
- **[Bsharat]** Bsharat et al., 2023. Preprint. arXiv 2312.16171. Verified 2026-11-12.
- **[Anthropic-Guide]** Anthropic, Prompting best practices (current Claude models, Claude 5 included). https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices Verified 2026-11-12.
- **[Anthropic-LongCtx]** Anthropic, long context prompting tips. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips Verified 2026-11-12.
- **[Anthropic-Agents]** Anthropic, Building effective agents (appendix on prompt-engineering tools, from the SWE-bench agent work). https://www.anthropic.com/engineering/building-effective-agents Verified 2026-11-12.
- **[OpenAI-GPT5]** OpenAI, GPT-5 prompting guide. https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide Verified 2026-11-12.
