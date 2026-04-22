---
name: phase-1-branch-id-git-convention
branch_id: feat/phase-1-branch-id-git-convention
status: pending
authorized_by: architect
depends_on: []
estimated_minutes: 60
---

# Goal

Adopt git-convention strings (`feat/user-login`, `fix/auth-crash`,
`refactor/extract-helper`, etc.) as the canonical form for `branch_id` in the
SQLite `tasks` table. Add format validation in the MCP server so any future
caller is forced into the convention. Update test fixtures and tool docstrings
to reflect the new shape.

The column is already `TEXT` and accepts any string today, so this is a
**semantic** change, not a schema migration. There is no production data to
migrate (Phase 0 already locked hard-break).

# Context

Per `docs/v0.3-blueprint.md` change #F, gatekeeper auto-proposes
git-convention branch names from intent and uses them as `branch_id`. The
intent: `branch_id` IS the working git branch name for that task's worktree.
This unifies the workflow with git's own naming and removes the need for a
separate `1.2.3` numeric task index.

Today's free-form behavior risks SWEs and other agents inserting
`task-001`, `T1`, `step-3`, etc. in parallel — defeating the point. We add
runtime validation to lock the format.

Allowed format (regex, anchored): `^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)/[a-z0-9][a-z0-9-]{0,62}$`

Notes on the regex:
- Type prefix: the standard Conventional Commits set, plus `refactor` (very common in this codebase).
- Slash separator (single).
- Slug: lowercase, digits, hyphens; must start with alnum; max 63 chars (git refspec limit safety).
- No nested slashes — a single-level namespace keeps `task_first_actionable`'s `ORDER BY branch_id ASC` predictable. (See architect note below.)

**Architect note on ordering:** `task_first_actionable` orders by
`branch_id ASC` to pick the next task. With git-convention names, lex order
groups by type prefix (chore < ci < docs < feat < ...). This is acceptable for
Phase 1 — humans queue tasks in the order they want them executed and the
existing index `idx_tasks_issue_branch` (UNIQUE on `issue_id, branch_id`)
prevents duplicates. Phase 2/3 may revisit if explicit ordering becomes a
need. Document this implicit lex-order behavior in the tool description.

# Files to change

`/Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server/src/tools/tasks.ts`:
1. At top of file (or in a small helper), add:
   ```ts
   const BRANCH_ID_RE = /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$/;
   function validateBranchId(branchId: string): void {
     if (!BRANCH_ID_RE.test(branchId)) {
       throw new Error(
         `Invalid branch_id "${branchId}". Must match git-convention format: <type>/<slug> ` +
         `where <type> is one of feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert ` +
         `and <slug> is lowercase alnum + hyphens (max 63 chars). Examples: feat/user-login, fix/auth-crash.`
       );
     }
   }
   ```
2. Inside `task_create_batch` handler (around the existing `if (!t.branch_id)` check at line 139), call `validateBranchId(t.branch_id)` immediately after the existence check. Also validate `t.parent_branch_id` if present (with the same regex; it can be null).
3. Update the `task_create_batch` tool description (line 52) to read approximately:
   "Insert multiple tasks for an issue in a single transaction. branch_id MUST be a git-convention name (feat/foo, fix/bar, refactor/baz, etc.); it doubles as the working git branch."
4. Update the `task_first_actionable` tool description (line 110) to clarify the lex-ordering behavior given git-convention names: "Returns the lex-lowest pending/failed task (groups by type prefix: chore<ci<docs<feat<...)."

`/Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server/src/test/tasks.test.ts`:
- Update any existing test fixtures that use legacy branch_id values like `"1.1"`, `"task-001"`, or `"T1"` to use git-convention names like `"feat/login"`, `"fix/crash"`.
- Add at least one new test case covering each of:
  - Accept: `feat/user-login` → success.
  - Accept: `refactor/extract-helper` → success.
  - Reject: `Foo/Bar` → throws containing "Invalid branch_id".
  - Reject: `feat/UPPERCASE` → throws.
  - Reject: `feat/-leading-hyphen` → throws.
  - Reject: empty string → throws (existing missing-arg behavior is fine; verify error message).
  - Reject: `feat/double//slash` → throws.
  - Reject (parent_branch_id): `feat/foo` task with parent `bad value` → throws.
- Run the test suite. All tests must pass.

`/Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server/src/test/migration.test.ts`,
`ledger.test.ts`, `issues.test.ts`, `remaining_tools.test.ts`:
- Grep for legacy branch_id literals in these files; update to git-convention strings so the suite still passes after validation lands.

`/Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server/src/types.ts`:
- If `TaskInput` or `Task` has a comment near `branch_id`, update the comment to mention the git-convention format. No type change required (still `string`).

`/Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server/README.md`:
- If it documents `branch_id`, update with the format convention and one example. If no mention, add a one-paragraph "branch_id format" subsection.

**No SQL migration is needed.** The column type is unchanged. Schema version
in `plugin_meta` does not need bumping for a runtime-validation-only change
(Phase 0 already set version 3 and Phase 1 is non-schema). If SWE thinks a
bump is warranted, escalate to architect rather than deciding unilaterally.

# Success criteria

- `BRANCH_ID_RE` is exported or used in the MCP server tasks tool with the exact regex above.
- `task_create_batch` rejects any branch_id that does not match the regex, with a clear error message that includes the offending string and shows valid examples.
- `parent_branch_id`, when supplied, gets the same validation (and is allowed to be null/undefined to skip).
- All existing tests pass after fixture updates.
- New test cases (positive + negative listed above) all pass.
- Tool descriptions in the MCP definitions reflect the format expectation.
- No edits to `src/schema.sql` (this is not a schema change).
- The MCP server builds cleanly (`bun run build` or whatever the project's build command is — check `package.json`).

# Out of scope

- Schema migration script — none needed.
- Changing the gatekeeper agent prompt to actually propose branch IDs from
  intent. That is part of `phase-1-gatekeeper-branch-id-proposal`, which
  depends on this task.
- Wiring the worktree creation hook to use branch_id as the actual git branch
  name — that's Phase 2 (where the SWE spawn flow gets reshaped around
  markdown specs).
- Reformatting existing task XML files in this repo — Phase 1 keeps any
  legacy task XML untouched (there are none today; the repo's `bro/tasks/`
  is a future location, currently empty).

# Verification

```bash
cd /Users/Zax/Git/GitHub/TMB/plugin/mcp/trajectory-server
# Build (use whatever the project uses; check package.json scripts)
bun install && bun run build
# Tests
bun test
# Spot-check the regex
node -e '
const re = /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$/;
const cases = [
  ["feat/user-login", true],
  ["fix/auth-crash", true],
  ["refactor/extract-helper", true],
  ["docs/readme", true],
  ["Foo/Bar", false],
  ["feat/UPPER", false],
  ["feat/-bad", false],
  ["feat//double", false],
  ["feat/", false],
  ["random-string", false],
];
let bad = 0;
for (const [s, expect] of cases) {
  const got = re.test(s);
  if (got !== expect) { console.error("MISMATCH", s, "got", got, "expected", expect); bad++; }
}
process.exit(bad);
'
```

Build and tests must pass; the regex spot-check must exit 0.
