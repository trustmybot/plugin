# commands

The plugin's slash commands — the Human-triggered entry points into TMB's workflow. Each file is a Claude Code command: YAML frontmatter (`description`, `argument-hint`, optional `allowed-tools`) followed by the body bro runs when the command fires. Most commands are thin orchestration layers — the deterministic logic lives in the `onboard_*`, `scan_run`, `agent_*`, and `roundtable_*` MCP tools, so each body mostly passes data between AskUserQuestion and the server.

## Commands

| Command | Purpose | Argument |
|---|---|---|
| `onboard.md` | Configure or change identity, branching model, PR target, remotes, and issue-sync via a short AskUserQuestion ceremony. Auto-fires on bro's first turn when the project is not yet onboarded. | (none) |
| `scan.md` | Refresh the world model — walk the session dir for git repos and pull each directory's `README.md` into a summary node in the kuzu graph. Idempotent and summary-preserving. | (none) |
| `agent-create.md` | Create or copy an agent into the project's `.claude/agents/` directory and optionally spawn it on a consultant question. User-created agents default to `kind='consultant'`. | `<kebab-case name>` plus optional question |
| `roundtable.md` | Run a structured multi-agent deliberation: collect parallel positions, synthesize agreements and disagreements, ratify with the Human via AUQ, then close with decisions. | `<topic>` |
| `monitor.md` | Pull review comments from a GitHub PR or GitLab MR and plan/dispatch SWE work to address them, via the `tmb_comment-triage` skill. | `<PR or MR number>` |

## How it fits

Commands are how a Human steers the workflow that bro otherwise drives autonomously. Policy changes (`/onboard`), world-model refreshes (`/scan`), specialist creation (`/tmb:agent-create`), group decisions (`/roundtable`), and review triage (`/monitor`) each have a dedicated entry point so the same ceremony runs the same way every time.
