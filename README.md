# TMB Plugin

**Multi-agent engineering workflow for Claude Code. Free forever.**

Stop single-agent chaos. TMB runs your project like a real engineering team:
a Planner who scopes, an Architect who designs, an Executor who builds, and
a Reviewer who catches what you'd miss.

---

## Install

```bash
curl -sSL https://trustmybot.dev/install-plugin | sh
```

Or manually:

```bash
cd your-project/
git clone --depth 1 https://github.com/trustmybot/plugin.git .tmb-plugin
./.tmb-plugin/install.sh
```

Drops `.claude/` and `bro/` template into your project. Commit them or keep them local — your call.

## Usage

Once installed, Claude Code picks up the agents automatically. Workflow:

```bash
# Write what you want in bro/GOALS.md, then:
claude

# Or for simple tasks, skip the workflow:
claude "fix the login bug"
```

The **Architect** reads your goals, discusses with you until aligned, writes a blueprint, then breaks it into task files. The **SWE** implements one task at a time in isolated worktrees. The **PR Reviewer** gates every commit and push.

## What you get

**10 specialized agents in a company structure:**

- **Secretary** — gatekeeper, the ONLY agent you talk to; routes everything
- **CEO** — product vision, priorities, strategic calls
- **CTO** — technical architecture, BLUEPRINT approval
- **PM** — product strategy, user research, viability
- **GTM** — positioning, messaging, launch, conversion
- **Designer** — UX, visual identity, design system
- **Architect** — breaks BLUEPRINTs into task files, validates SWE
- **SWE** — implements one task at a time in isolated worktrees
- **PR Reviewer** — pre-commit and pre-push review gate
- **Prompt Engineer** — rewrites prompts, docs, agent files for clarity

**Workflow contract:** `bro/GOALS.md` → `bro/DISCUSSION.md` → `bro/BLUEPRINT.md` → `bro/tasks/*.xml`

**Task XML format:** structured contracts with `<authorized-by>`, `<scope>`, `<verification>`, `<reviewed-by>`

**Hook enforcement:** SWE can't spawn without a task file; push blocked without review sign-off; source code write-lockout outside worktrees

**Worktree isolation:** SWE agents work on isolated git branches, you merge when ready

## Why multi-agent

Single-agent Claude is fast but sloppy at scale. Role separation forces rigor:
- Architect can't write code (must write a task first)
- SWE can't read strategy docs (must stay in the task)
- PR Reviewer can't be bypassed (hook blocks the push)

Each agent has distinct system prompts, tool scopes, and file access — enforced structurally, not by politeness.

## Upgrade to Enterprise

Need memory, audit trail, cross-provider LLM, hard structural permissions, team dashboard?
→ [TMB Enterprise](https://github.com/trustmybot)

## License

MIT. Fork it, ship it, sell it. We only ask for a link back.
