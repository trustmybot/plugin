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

Name the capability and call `cheatcode_search` once — it searches, ranks, and records the audit row. Pin `kind` when the shape is obvious; leave it for the schema default when unsure.

Tier+relevance order is an input, not the verdict — you hold the actual requirement and know the codebase, so the pick is yours. Read what each candidate does, commit to the best fit (top two-three only if genuinely close), and lead with the reasoning plus its tier and source URL. Installing is a separate gate.

## Vet before recommending

Once you've landed on a pick, vet it before putting it in front of the Human:

`cheatcode_vet(agent='bro', candidate=<the pick>)`

Pass the candidate straight through — the same `{name, kind, source_url, tier}` shape `cheatcode_search` handed you. One call returns a deterministic `trust_tier` (`trusted`, `caution`, `untrusted`, `unknown`), the `capabilities[]` it ships, and the audit row.

The `trust_tier` is a reproducible read of the signals; the install judgment is still yours. Weigh the tier against what the cheatcode would touch — `capabilities[]` carries the real weight, since a cheatcode shipping hooks, an MCP server, or scripts executes inside your project. If the signals come back thin (`unknown`, no maintainer, offline gather), say so plainly; an unconfirmed reputation is a finding the Human needs.

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

Lead the chat with the rationale — what the cheatcode does, its tier, and the surface it brings — then let the Human call it.

## Decide the consuming agent

`target` is the agent that will USE the cheatcode. For a **skill**, pass `target=<agent>`; a `kind=mcp` server (or pure-server plugin) needs no target — its registration is the attachment, callable by any agent.

If the Human named the agent — "install X for swe", "code-review for pr-reviewer" — use it. Otherwise infer from the cheatcode's domain: coding / test / refactor / debug → `swe`; code-review / quality → `pr-reviewer`; orchestration / routing / planning → `bro`; a consultant's domain → that consultant. Reach for AskUserQuestion only when it's genuinely ambiguous.

## Approve, install, activate

Approval is a hard gate: `cheatcode_approve` records the per-candidate Human approval, and the install PreToolUse gate fails closed without it. Rejected → stop.

Once approved, `cheatcode_install` runs the marketplace/MCP path (no seed/copy), idempotent on (name, source_url), recording the `cheatcodes` row + attachments + audit in one transaction. It materializes the attachment IN THE USER PROJECT (never the plugin repo):

- **skill** (or skill-contributing plugin): `target=bro` adds a reference to `.claude/CLAUDE.md`; any other target copies the global `agents/<target>.md` into `.claude/agents/<target>.md` (if absent) and adds the name to its `skills:` frontmatter. A skill with no resolved target is hard-rejected — no orphan can land.
- **mcp / pure-server plugin**: its registration IS its attachment — no target, no `skills:` entry needed.

Then `cheatcode_activate`: a skill is usable in-session immediately; an MCP/plugin returns `restart_required` and loads on the next cold start.
