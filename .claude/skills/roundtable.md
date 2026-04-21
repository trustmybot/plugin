---
name: roundtable
description: Run a multi-agent roundtable discussion led by the CEO. Two modes — parallel (agents write independently, CEO synthesizes) or debate (agents respond to each other across rounds, CEO judges). Secretary routes to CEO, CEO runs the show. Output is XML for structured agent communication.
user_invocable: true
---

# Roundtable Discussion

CEO-led multi-agent discussion on a strategic topic. The Secretary routes the
request to the CEO, who owns the entire process.

## Modes

### Parallel (default)

Agents write independently, CEO synthesizes. Fast, cheap (N agent calls +
1 synthesis). Good for routine decisions.

### Debate

Agents respond to each other across multiple rounds. CEO acts as judge.
Richer output, surfaces tensions parallel mode misses. Use for high-stakes
or contentious decisions.

## Workflow

1. **Secretary receives the topic.** Routes to CEO with:
   - The topic and relevant context
   - Which agents to include (default: PM, GTM, Designer; add CTO if technical)
   - Mode preference if specified by Human (default: CEO decides)

2. **CEO frames the question.** Reads `bro/DISCUSSION.md` and any relevant
   files. Decides mode based on stakes and complexity.

3. **CEO runs the roundtable:**

   **Parallel mode:**
   - Spawns agents in parallel, each writes to their own file
   - Agents do NOT read each other's output — independence required
   - CEO reads all outputs, writes synthesis

   **Debate mode:**
   - **Round 1:** Spawns agents in parallel with the topic. Each states
     position + evidence.
   - **Round 2+:** CEO passes each agent the others' positions. Each agent:
     - Restates or updates position
     - Responds to at least one other agent's argument (agree, rebut, refine)
     - Cites evidence for any new claims
   - **Cap:** 3 rounds max (extend only if Human requests)
   - **Judge:** CEO synthesizes after final round — convergence, unresolved
     tensions, recommended decision

4. **CEO writes output.** Writes to `bro/roundtable/YYYY-MM-DD-HHMM-topic.xml`.
   No index file — the directory is self-contained.

5. **Secretary presents to Human.** Concise summary + key decisions needed.

## Output Format (XML)

The Human only reads the `<questions>` section — the rest is for agents.

```xml
<roundtable>
  <meta>
    <topic>The discussion topic</topic>
    <date>YYYY-MM-DD</date>
    <mode>debate|parallel</mode>
    <participants>PM, CTO, Designer</participants>
    <decision_maker>CEO</decision_maker>
  </meta>

  <summary>
    3-5 sentences: what was discussed, what was decided, what needs Human input.
  </summary>

  <rounds>
    <round n="1" label="Opening Positions">
      <agent name="PM" role="Product Strategy">
        <position>Their stance</position>
        <evidence>Supporting reasoning</evidence>
        <response_to agent="">Only in Round 2+</response_to>
      </agent>
    </round>
  </rounds>

  <convergence>
    <point>Where all agents agree — safe to act on</point>
  </convergence>

  <tensions>
    <tension>
      <description>The conflict</description>
      <side_a agent="PM">Their position</side_a>
      <side_b agent="CTO">Their position</side_b>
      <resolution>CEO's call + reasoning</resolution>
    </tension>
  </tensions>

  <recommendation>
    CEO's recommended path forward — specific, actionable, tradeoffs acknowledged.
  </recommendation>

  <questions>
    <question id="1">
      <text>The question for the Human</text>
      <context>Why this needs Human input, what agents said</context>
      <answer></answer>
    </question>
  </questions>
</roundtable>
```

## Debate Rules

- **No groupthink.** If all agents agree too quickly, CEO probes the weakest
  shared assumption.
- **Protect dissent.** A lone dissenter may be right. CEO gives dissenting
  views explicit airtime.
- **Structured responses.** Position, supporting evidence, response to counter.
- **Devil's advocate.** In debate mode, CEO may assign one agent to argue
  the opposing case.
- **No yes-men.** "I agree with PM" without new reasoning is not acceptable.

## Agent Roster

| Agent | Perspective | Parallel Output |
|---|---|---|
| **PM** | Product viability, user pain, market gaps, revenue | `bro/PRODUCT.md` |
| **GTM** | Positioning, messaging, conversion, competitive wedge | `bro/MARKETING.md` |
| **CTO** | Technical feasibility, data model, system cost | verbal to CEO or `bro/BLUEPRINT.md` |
| **Designer** | UI/UX, visual identity, design system, interaction | `bro/DESIGN.md` |

## When to Use Each Mode

| Signal | Mode |
|---|---|
| Routine product direction | Parallel |
| Feature design with tradeoffs | Parallel or Debate |
| Architecture choice with competing approaches | Debate |
| Agents likely to disagree (contentious topic) | Debate |
| Human explicitly asks for debate | Debate |
| Time-sensitive, need fast answer | Parallel |
