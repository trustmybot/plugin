# Repo Resolution (path-keyed)

How TMB answers "which repo does this operation belong to" in a single- or multi-repo workspace. Resolution is **path-keyed**: an operation's path identifies its repo against the `repos` table — there is no global default-repo name.

## Context

A workspace can hold more than one inner git repo (siblings or submodules) under one trajectory DB. Each discovered repo gets a `repos` row (written by `/scan`), keyed by `name` with an authoritative `path`. The server and the hooks each have one resolver module that matches a path against those rows; both live under `mcp/trajectory-server/src/` (`utils/repo-paths.ts`, `hooks/lib/repo.ts`).

A name-keyed global default forces one repo to be "the" repo and makes the git guards guess what to enforce on. That breaks the moment a second repo enters the workspace, and it duplicates state the `repos` table already holds path-first.

## Decision

1. **Resolution is path-keyed.** "Which repo does this operation belong to" = match the operation's path — the command's git root for a hook, or the task's repo for a task — against `repos.path`. There is no global default-repo name.

2. **Repos are identified by registration.** A repo participates in TMB resolution iff it has a `repos` row. `/scan` records the row; unregistered sibling trees are invisible to resolution.

3. **git-guard scoping is registration-based.** A git op is enforced iff its git root resolves to a registered `repos` row. When the command's git root is an unregistered sibling tree, the guards do nothing — they never enforce on a tree TMB doesn't manage. For a single-repo user project the sole repo *is* the registered root, so the whole tree is guarded.

4. **Branch policy is per repo.** The PR target, branching model and protected branches on a repo's row are the sole source of truth; there is no global fallback.

5. **Single-repo fallback.** When an operation names no repo and exactly one repo is registered, it resolves to that repo. This keeps single-repo projects (the common case) working without any per-operation repo argument. A git root that matches no row is never resolved this way.

## Consequences

- **Multi-repo workspaces work without ceremony.** Each operation resolves to its own repo by path; sibling repos coexist without one being privileged.
- **Guards never fire on unmanaged trees.** Editing or committing in an unregistered sibling repo is allowed — TMB only enforces on trees it registered.
- **`/scan` is the registration point.** A repo must be scanned to participate; this is the same step that warms the world model, so the two stay aligned.
