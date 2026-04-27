---
name: tmb_naming-conventions
description: File and identifier naming patterns.
agent: swe, pr-reviewer
paths: ["src/**", "lib/**", "app/**", "tests/**"]
---

# Naming Conventions

**This file is a template.** Adapt it to your project's language and style guide.
Inconsistent naming triggers code review findings.

## Python

| Thing | Convention | Example |
|---|---|---|
| Files, modules | `snake_case` | `user_service.py` |
| Variables, functions, params | `snake_case` | `drop_existing`, `score_history` |
| Classes | `PascalCase` | `UserService`, `ConnectionPool` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_RETRIES`, `DEFAULT_MODEL` |
| Private | `_leading_underscore` | `_internal_helper()` |
| Dunder | `__name__` | `__init__`, `__repr__` |

## TypeScript / JavaScript

| Thing | Convention | Example |
|---|---|---|
| Files (non-React) | `kebab-case` | `user-service.ts` |
| Files (React component) | `PascalCase` | `UserCard.tsx` |
| Variables, functions | `camelCase` | `dropExisting`, `scoreHistory` |
| Classes, types, interfaces | `PascalCase` | `UserService`, `UserDto` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_RETRIES` |

## SQL / DB

| Thing | Convention | Example |
|---|---|---|
| Tables | `snake_case` (plural) | `users`, `user_roles` |
| Columns | `snake_case` | `created_at`, `user_id` |
| Primary keys | `id` (always) | `id INT PRIMARY KEY` |
| Foreign keys | `<table>_id` (singular) | `user_id REFERENCES users(id)` |
| Indexes | `idx_<table>_<cols>` | `idx_users_email` |
| Junction tables | `<a>_<b>` | `user_roles`, `post_tags` |

## General

- **Boolean variables/columns:** `is_active`, `has_email`, `can_edit` — verb-first.
- **Date/time fields:** `*_at` for timestamps (`created_at`), `*_on` for dates (`born_on`).
- **Arrays/collections:** plural (`users`, `items`), singular for one (`user`, `item`).
- **Avoid abbreviations:** `configuration` > `cfg`, `user` > `usr`. Exceptions: `id`, `url`, `api`, `db`.
- **No Hungarian notation:** `strName`, `arrUsers` — don't.

## Adapting for Your Project

If your codebase uses different conventions (e.g., `lowerCamelCase` for Python
files because of legacy code), **document them in this file** rather than fighting them.
Consistency > correctness.
