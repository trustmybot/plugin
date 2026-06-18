---
name: tmb_cheatcode
description: When bro hits a wall — a task leans on a capability the project plainly lacks — and an existing published skill, MCP toolkit, or plugin would close the gap better than hand-rolled code. Bro names the gap, calls cheatcode_search for ranked candidates, judges which best fits this task and codebase, and recommends it for the Human to approve. Loaded when grabbing an external cheatcode beats grinding the capability out from scratch.
allowed-tools: mcp__plugin_tmb_trajectory-server__cheatcode_search, mcp__plugin_tmb_trajectory-server__cheatcode_vet, mcp__plugin_tmb_trajectory-server__cheatcode_list, AskUserQuestion
---

# cheatcode

## Already installed?

When the Human refers to "cheatcode(s)" directly — "do the cheatcodes work", "which cheatcodes are installed", "is X already a cheatcode" — inspect the installed registry first with `cheatcode_list(agent='bro')` (the `cheatcodes` table). That's the read surface for what's on hand; it's distinct from the discovery pipeline below (search → vet → install), which is for closing a gap that nothing installed covers.

## Is the gap real?

Check the request against the project's surface — world model, installed skills/MCP, CLAUDE.md. It's a cheatcode play when:

- The task needs a well-trodden domain with mature tooling (PDF extraction, OCR, a cloud SDK, a protocol client) and the project has nothing for it.
- Building it in-repo would duplicate something the ecosystem already maintains.
- The Human asked "is there a tool/skill for X."

If code you'd write anyway covers it, or a capability already on hand does, it's normal planning — route it that way.

## Find and recommend

Name the capability and call once:

`cheatcode_search(agent='bro', capability_query='<capability>', kind='skill'|'mcp'|'plugin'|'any')`

One call searches, ranks, and records the audit row. Pin `kind` when the shape is obvious; leave `any` when unsure.

Tier+relevance order is an input, not the verdict — you hold the actual requirement and know the codebase, so the pick is yours. Read what each candidate does, commit to the best fit (top two-three only if genuinely close), and lead with the reasoning plus its tier and source URL. Installing is a separate gate.

## Vet before recommending

A search rank says "this fits the task." It says nothing about whether the thing is safe to pull into the project. So once you've landed on a pick, vet it before you put it in front of the Human:

`cheatcode_vet(agent='bro', candidate=<the pick>)`

Pass the candidate straight through — the same `{name, kind, source_url, tier}` shape `cheatcode_search` handed you. One call gathers reputation and security-surface signals, classifies a deterministic `trust_tier` (`trusted`, `caution`, `untrusted`, `unknown`), names the `capabilities[]` it ships, and records the audit row.

Read the result the way the tool means it: the `trust_tier` is a reproducible read of the signals, not a clearance. You still own "trustworthy enough to install?" — weigh the tier alongside what the cheatcode actually does and what it would touch in this project. A `trusted` tier on a tiny utility is an easy yes; the same tier on something that runs code in your tree still deserves a second look. The `capabilities[]` list is where the real weight lives: a cheatcode that ships hooks, an MCP server, or scripts executes inside your project, so treat code-execution, network, and filesystem-write surface as the thing the Human is really approving.

When the signals come back thin — `unknown` tier, no maintainer, an offline gather — say that plainly. "I couldn't establish reputation for this one" is a finding the Human needs, not a blank to paper over. Vetting earns trust by being honest about what it couldn't confirm.

A `trusted`, low-surface pick you can simply recommend, with the tier and rationale in your reasoning. Anything in `caution`, anything carrying a real capability surface, or any tier you'd hesitate to vouch for — bring it to the Human as a decision rather than a recommendation:

```
AskUserQuestion(
  question: "<candidate> vetted <trust_tier> — it ships <capabilities>. Install it?",
  options: [
    { label: "Install", description: "Proceed to the install gate with this pick." },
    { label: "Skip",    description: "Drop it; I'll hand-roll or look again." },
  ],
)
```

Lead the chat with the rationale — what the cheatcode does, the tier and why, and the surface it would bring into the project — then let the Human make the call. The install itself is still a separate gate.
