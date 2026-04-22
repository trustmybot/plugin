---
name: create-hook
description: Create or modify git hooks for deterministic enforcement. Use when the architect identifies a rule that should be enforced by code, not LLM promises. Spawns SWE to implement the hook.
---

# Create Hook

Use this when you identify a rule that needs deterministic enforcement — something an LLM might forget but a shell script never will.

## When to Use

- A rule was violated because an agent forgot it (context window pressure)
- A pattern keeps recurring despite being documented in rules
- The enforcement is binary (pass/fail) and can be checked by code

## Process

1. Write a task file in `docs/trustmybot/tasks/` describing the hook
2. Specify: what to check, what error message to show, where the hook lives
3. Spawn SWE to implement it
4. Hook scripts go in `hooks/` directory (not `.git/hooks/` directly)
5. Installation is via `hooks/install.sh` which symlinks into `.git/hooks/`

## Hook Location

```
hooks/
  pre-commit        # runs before every commit
  install.sh        # symlinks hooks into .git/hooks/
```

## Example Task Spec

```xml
<work>
  Create hooks/pre-commit that checks:
  1. No __pycache__ or .pyc files staged
  2. No .claude/settings.local.json staged
  3. Source files in src/ tests/ config/ must be from worktree branch

  Create hooks/install.sh that:
  1. Symlinks hooks/pre-commit to .git/hooks/pre-commit
  2. Makes it executable
</work>
```
