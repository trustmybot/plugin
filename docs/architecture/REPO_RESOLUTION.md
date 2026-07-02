# Repo Resolution (path-keyed)

How TMB answers "which repo does this operation belong to" in a single- or multi-repo workspace. Resolution is **path-keyed**: an operation's path identifies its repo against the `repos` table — there is no global default-repo name.

## Context

A workspace can hold more than one inner git repo (siblings or submodules) under one trajectory DB. Each discovered repo gets a `repos` row (written by `/scan`), keyed by `name` with an authoritative `path`. The canonical resolvers — `mcp/utils/repo-paths.ts` and `scripts/hooks/lib/resolve-repo.sh` — both resolve by `repos.path` / cwd git-root.

A name-keyed global default forced one repo to be "the" repo and made the git guards string-join `<workspace>/<name>` to decide what to enforce on. That breaks the moment a second repo enters the workspace, and it duplicates state the `repos` table already holds path-first.

## Decision

1. **Resolution is path-keyed.** "Which repo does this operation belong to" = match the operation's path — the cwd git-root for a hook, or `tasks.repo` for a task — against `repos.path`. There is no global default-repo name.

2. **Repos are identified by registration.** A repo participates in TMB resolution iff it has a `repos` row (matched by path). `/scan` records the row; unregistered sibling trees are invisible to resolution.

3. **git-guard scoping is registration-based.** A git op is enforced iff its git-root resolves to a registered `repos` row. When the command's git-root is an unregistered sibling tree, the guards no-op — they never enforce on a tree TMB doesn't manage. For a single-repo user project the sole repo *is* the registered root, so the whole tree is guarded as before.

4. **`protected_branches` is per-repo authoritative.** `repos.protected_branches` (resolved path-keyed) is the sole source of truth; there is no global `plugin_config` fallback.

5. **Single-repo fallback.** When exactly one repo is registered, resolution defaults to it. This keeps single-repo projects (the common case) working without any per-operation repo argument.

6. **Read-tolerant migration.** No data migration is needed. Existing projects keep working: a single registered repo resolves via the single-repo fallback, and a multi-repo workspace resolves each operation by its path.

## The resolution contract

Implementers (MCP source and hooks) agree on one shape:

- **Canonical resolver** — `resolveSoleRepoPath(db)` returns the path of the sole registered repo (single-repo fallback), else `null`. A caller that needs a *specific* repo passes `tasks.repo` or the cwd git-root and resolves it against `repos.path`.
- **Hooks** resolve the acting repo from the command's git-root → `repos` row. Absent a matching row, they apply the single-repo fallback; if that doesn't resolve either, they no-op rather than enforce on an unregistered tree.
- **`scripts/hooks/lib/resolve-repo.sh`** is the shell side of this contract: `tmb_repo_git_root` (cwd → main worktree root), `tmb_repo_is_registered`, `tmb_repo_resolve` (per-repo `target_branch|branching_model|protected_branches`), `tmb_repo_single_path` (single-repo fallback), and `tmb_repo_resolve_path` (by name, falling back to single-repo).

## Consequences

- **Multi-repo workspaces work without ceremony.** Each operation resolves to its own repo by path; sibling repos coexist without one being privileged.
- **Guards never fire on unmanaged trees.** Editing or committing in an unregistered sibling repo is allowed — TMB only enforces on trees it registered.
- **Per-repo branch policy.** Each repo carries its own `target_branch`, `branching_model`, and `protected_branches` on its `repos` row — the sole source of truth, with no global fallback.
- **`/scan` is the registration point.** A repo must be scanned to participate; this is the same step that warms the world model, so the two stay aligned.
