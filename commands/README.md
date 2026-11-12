# commands

The plugin's slash commands — the Human-triggered entry points into TMB's workflow. Each file is a Claude Code command: YAML frontmatter (`description`, `argument-hint`, optional `allowed-tools`) followed by the body bro runs when the command fires. Most commands are thin orchestration layers — the deterministic logic lives in the `onboard_*`, `scan_run`, `agent_*`, and `roundtable_*` MCP tools, so each body mostly passes data between AskUserQuestion and the server.

## Commands

| Command | Purpose | Argument |
|---|---|---|
| `onboard.md` | Configure or change identity, branching model, PR target, remotes, and issue-sync via a short AskUserQuestion ceremony. Auto-fires on bro's first turn when the project is not yet onboarded. | (none) |
| `scan.md` | Refresh the world model — walk the session dir for git repos and write each project's directories, files and symbols to the world-model tables of the trajectory DB, with each directory's summary from its `README.md` or, without one, from its file names. | (none) |
| `agent-create.md` | Create an agent in `<project>/.claude/agents/` and optionally spawn it on a consultant question. User-created agents default to `kind='consultant'`. | `<kebab-case name>` plus optional question |
| `roundtable.md` | Run a structured multi-agent deliberation: collect parallel positions, synthesize agreements and disagreements, ratify with the Human via AUQ, then close with decisions. | `<topic>` |
| `dashboard.md` | Start the local dashboard (`dashboard/dist/server.mjs`: issues, tasks, agent runs, gates, audit, project map) in the background and report its URL. It can also edit and close issues, add comments and change config. | (none) |

## How it fits

Commands are how a Human steers the workflow that bro otherwise drives autonomously. Policy changes (`/onboard`), world-model refreshes (`/scan`), specialist creation (`/tmb:agent-create`), and group decisions (`/roundtable`) each have a dedicated entry point so the same ceremony runs the same way every time.
