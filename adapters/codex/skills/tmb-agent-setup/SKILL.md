---
name: tmb-agent-setup
description: Inspect, install, or remove TrustMyBot's two fixed project-level Codex Agents. Use only when the user explicitly invokes $tmb-agent-setup and confirms the exact project-local file changes.
---

# TMB Agent Setup

## Fixed targets

- `.codex/agents/tmb_swe.toml`
- `.codex/agents/tmb_pr_reviewer.toml`

Each generated Agent carries a disabled same-name `trajectory-server` entry in
its own `mcp_servers` table. The entry has an inert `node --version` transport
only because Codex requires a complete transport shape even when the server is
disabled. The Agent also stops before repository access if a TMB tool is still
visible at runtime.

## Workflow

1. Resolve the absolute Git top-level selected by the user. Pass that exact path
   as `project_root` on every TMB call.
2. Determine whether the user wants to inspect the files or make them present
   or absent. Ask when the desired action is not explicit.
3. Call `runtime_initialize`. Stop on any error. Do not edit `.gitignore`, choose
   another worktree, or weaken the project checks.
4. Call `agent_materialization_get` and report the overall state plus both Agent
   states.
5. If the requested state is already satisfied, finish without calling the
   setter and without asking for a no-op confirmation.
6. If either Agent is `conflict`, stop and explain that the user must resolve
   the file manually. Setter, force, overwrite, adopt, automatic backup, and
   automatic repair are unavailable in this state.
7. Show the two fixed paths and explain whether each one will be created or
   removed. State that the files may appear in `git status`; TMB will not stage,
   commit, or ignore them.
8. Ask for explicit confirmation. Do not treat the original Skill invocation as
   confirmation of the file mutation.
9. Only after confirmation, call `agent_materialization_set` once with
   `desired_state` set to `present` or `absent`.
10. Call `agent_materialization_get` again. Report success only when both Agents
    match the requested final state.
11. When files changed, tell the user to start a new Codex task or CLI session.
    Do not say the current task has hot-loaded the Agent files.

## Confirmation text

For installation in a Chinese conversation, use:

> 将在当前 Git 项目中创建以下文件：
>
> `.codex/agents/tmb_swe.toml`
>
> `.codex/agents/tmb_pr_reviewer.toml`
>
> 不会修改 `.claude`、Git 索引、远程仓库或 TMB 规划数据。文件可能出现在 `git status`，是否纳入版本控制由你决定。确认安装吗？

For removal in a Chinese conversation, use:

> 将只删除与当前 TMB 模板逐字节一致的两个 Agent 文件。其他 `.codex/agents` 文件和目录会保留。确认移除吗？

Translate these facts faithfully when the conversation uses another language.

## Error handling

- For `agent_materialization_conflict`, explain that a same-name file does not
  match the current TMB template. No Agent file was changed before this error.
- For `unsafe_codex_agents_path`, explain that a symlink, unexpected file type,
  or unverifiable path stopped the operation before a safe write.
- For `agent_materialization_io_failed`, ask the user to check permissions and
  disk state, then run this Skill again to inspect the project.
- For `agent_materialization_partial`, state that at least one managed target
  changed. Report `cause_code`, `changed`, and both final Agent states from the
  error details. Ask the user to run this Skill again. A safe `mixed` state can
  be reconciled by repeating the same desired state after another confirmation.
- Treat every MCP `isError` result as a stop signal. Never continue with direct
  filesystem commands as a substitute for the setter.

## Boundaries

This Skill does not spawn either Agent, create TMB tasks or validation records,
write planning discussions, edit `.claude`, install global Agents, run Git write
operations, change remotes, or manage any file outside the two fixed targets.
