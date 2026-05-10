# Project metadata

Deterministic stack detection — the data bro reads instead of re-probing the project on every turn.

> Rationale + design history: ADR `manual/decisions/0002-deterministic-stack-detection.md`. This doc is the **reference for the current shape**: API, schema, lookup tables.

## API

Two MCP tools in `mcp/trajectory-server/src/tools/project-metadata.ts`:

- `project_metadata_detect(agent='bro', repo_path?)` — runs `scripts/detect-stack.sh` (timeout 5s), parses JSON, persists to `plugin_config('_meta_detected_stack', ...)`, returns `{ detected, changed, previous_detected_at }`. `requireRoles: ['bro']` — only bro persists.
- `project_metadata_get(agent='bro'|'swe'|'pr-reviewer'|'consultant')` — reads the cached value or returns `null`. No write side-effects.

Detection is invoked from the `session-start-prescan.sh` hook (warm cache at session start) and from bro's planning chain when the cache is stale or `null`.

## Stored shape

`plugin_config` row at `key = '_meta_detected_stack'`, `value_json` =

```json
{
  "files_present": ["pyproject.toml", "package.json", "tsconfig.json"],
  "languages": ["python", "typescript", "javascript"],
  "package_managers": ["uv", "bun", "npm"],
  "test_runners": ["pytest", "vitest"],
  "linters": ["ruff", "eslint"],
  "git_remotes": [
    {"name": "origin", "provider": "github", "url": "git@github.com:foo/bar.git"}
  ],
  "detector": "file-presence",
  "detected_at": "2026-05-05T12:34:56Z"
}
```

`detector` is one of `enry`, `tokei`, `file-presence` — names which signal generated `languages`. Arrays are deduplicated and sorted.

**Naming contract:** keys prefixed `_meta_` are auto-detected metadata, written by `project_metadata_detect` (NOT by `config_set`). Keys without that prefix (`branching_model`, `pr_target`, `protected_branches`, `remotes`, `issue_sync`) are user-set policy. The `config` table doesn't enforce the prefix — convention only.

## Lookup tables (used by `scripts/detect-stack.sh`)

### File-presence → language

| File | Adds language |
|---|---|
| `pyproject.toml`, `requirements.txt`, `setup.py`, `Pipfile` | `python` |
| `package.json` | `javascript` |
| `tsconfig.json` | `typescript` |
| `Cargo.toml` | `rust` |
| `go.mod` | `go` |
| `Gemfile` | `ruby` |
| `pom.xml`, `build.gradle` | `java` |
| `build.gradle.kts` | `kotlin` |
| `composer.json` | `php` |
| `mix.exs` | `elixir` |

### `command -v` → tooling

| Field | Probed binaries |
|---|---|
| `package_managers` | `uv`, `poetry`, `pip`, `pipx`, `bun`, `pnpm`, `npm`, `yarn`, `cargo`, `go`, `bundler`, `maven`, `gradle`, `composer`, `mix` |
| `test_runners` | `pytest`, `jest`, `vitest`, `mvn`, `gradle`, `rspec` |
| `linters` | `ruff`, `black`, `eslint`, `prettier`, `clippy`, `gofmt`, `rubocop` |

`cargo` and `go` only emit in `package_managers` (test invocations are `cargo test` / `go test`).

### Git remote URL → provider

Re-uses the URL pattern table from `commands/onboard.md` Step 0:

| URL contains | provider |
|---|---|
| `github.com` | `github` |
| `gitlab.com` or `gitlab.<corp>.<tld>` | `gitlab` |
| `bitbucket.org` | `bitbucket` |
| `codeberg.org` | `codeberg` |
| `dev.azure.com` | `azuredev` |
| anything else | `other` |

## Drift handling

`session-start-prescan.sh` calls `project_metadata_detect` at session start. The handler diffs the previous value before persisting; on `changed=true` bro sees a stack delta in the injected `additionalContext`.

`lazy-regen-postcheck.sh` PostToolUse hook on `file_registry_update_summaries` re-detects and emits a `discussion_append(kind='note')` row when the stack changed mid-session (e.g., user installs `uv` and re-runs).

## Out of scope

- Hard dep on `enry`/`tokei` — hybrid only; the script works without them.
- Linguist Ruby gem — too heavy.
- Byte-count language % — only emitted if `enry`/`tokei` provide it; we don't compute it ourselves.
- Cross-repo metadata (multi-root workspaces) — single repo per detect call. Multi-repo workspaces use `tasks.repo` / `tmb_default_repo` for per-task scoping; see Flow 33 in `FLOWS.md`.
