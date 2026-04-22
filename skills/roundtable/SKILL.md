---
name: roundtable
description: Multi-agent deliberation on a topic. Sequentially spawns 2-4 participants from the workspace's agent roster, collects positions, synthesizes, logs to the trajectory ledger.
allowed-tools: Read, Task, Grep, Glob
---

# Roundtable

Multi-agent deliberation: spawn participants from the workspace roster, collect
independent positions, synthesize convergence and tensions, log to the MCP
ledger.

## When to invoke

Use roundtable for:

- Divergent opinions that need structured airing
- Multi-dimension trade-offs (product vs. technical vs. business)
- Cross-discipline calls where no single agent owns the answer

Do NOT use roundtable for:

- Quick factual questions — answer directly
- Single-discipline decisions — spawn that agent via `Task` directly
- A caller who wants one voice — roundtable is deliberation, not delegation

## Participant selection

1. Glob the workspace's `.claude/agents/` directory to enumerate available agents.
2. Read each agent's frontmatter `description` field.
3. Select 2–4 agents whose descriptions best match the topic.
4. Always exclude SWE — it is an executor, not a deliberator.
5. Prefer user-created domain agents over the core roster for domain-specific
   topics; fall back to the core roster for general topics.
6. If fewer than 2 suitable participants are available, escalate to the caller —
   roundtable requires at least 2 voices.

## Sequential flow

Spawn all selected participants in parallel via multiple `Task` calls issued in
a single message. Each participant receives:

- The topic
- Relevant context (files, prior decisions, constraints)
- An instruction to state a position with supporting reasoning

Collect all responses before proceeding. If a participant refuses or errors,
proceed with the remaining voices and note the abstention in the summary.

## Convergence and synthesis

After all positions are collected, the coordinator (the agent running this
skill) writes a synthesis covering:

- Points of agreement safe to act on
- Unresolved tensions, each with the competing positions named
- A recommended path forward with trade-offs acknowledged
- Questions requiring Human input, if any

Write the synthesis as structured XML output:

```xml
<roundtable>
  <meta>
    <topic>The discussion topic</topic>
    <date>YYYY-MM-DD</date>
    <mode>sequential</mode>
    <participants>agent-a, agent-b, agent-c</participants>
  </meta>

  <positions>
    <position agent="agent-a">
      <stance>Their position</stance>
      <reasoning>Supporting evidence and reasoning</reasoning>
    </position>
  </positions>

  <convergence>
    <point>Where all agents agree — safe to act on</point>
  </convergence>

  <tensions>
    <tension>
      <description>The conflict</description>
      <side_a agent="agent-a">Their position</side_a>
      <side_b agent="agent-b">Their position</side_b>
      <resolution>Coordinator's recommended call with reasoning</resolution>
    </tension>
  </tensions>

  <recommendation>
    Specific, actionable path forward with trade-offs acknowledged.
  </recommendation>

  <questions>
    <question id="1">
      <text>Question for the Human</text>
      <context>Why this needs Human input</context>
      <answer></answer>
    </question>
  </questions>
</roundtable>
```

## MCP ledger logging

After writing the synthesis, log a summary to the trajectory ledger:

```
ledger_log(
  event_type='roundtable_summary',
  topic=<topic>,
  participants=<comma-separated list>,
  recommendation=<one-sentence summary>,
  tensions_count=<integer>
)
```

If `ledger_log` fails, continue — the local XML output is the fallback record.
Log a warning to stderr noting the ledger call failed.

## Cleanup

After logging, invoke the `roundtable-cleanup` rule to archive raw participant
positions and keep the workspace tidy.

## Deliberation rules

- No groupthink: if all participants agree immediately, probe the weakest shared
  assumption before synthesizing.
- Protect dissent: a lone dissenter may be right — give dissenting views
  explicit airtime in the tensions section.
- No yes-agents: "I agree with X" without new reasoning is not an acceptable
  position.

---

**v0.3 note:** Agent-teams mode (parallel team execution via Claude Code's
native teams config) is planned for v0.3 once the user-facing team config
schema stabilizes. The sequential flow above is the production path for v0.2.
