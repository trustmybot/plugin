---
name: typescript-api-dev
description: Bun + Drizzle + TS API guidance.
paths: ["**/*.ts", "**/api/**", "**/*.drizzle.ts"]
agent: swe
---

# TypeScript API Development

## Environment

- Runtime: Bun only. Never Node.js, npm, yarn, pnpm.
- Framework: Hono
- ORM: Drizzle (postgres.js driver)
- Auth: Google SSO via arctic, PG sessions (httpOnly cookies)
- RBAC: user / pro / viewer / admin roles

## Verification (mandatory before COMPLETED)

```bash
cd web/api && bun run lint && bun run build && bun test
```

`bun run build` is MANDATORY. Lint alone misses import errors, type mismatches, and broken module boundaries.

## Naming

- Files: `kebab-case.ts` (`use-jds.ts`, `pipeline.ts`)
- Variables, functions: `camelCase` (`fetchJSON`, `authMiddleware`)
- Types, interfaces: `PascalCase` (`AuthUser`, `HonoVariables`)
- Constants: `UPPER_SNAKE_CASE` or `camelCase`
- Route files: `kebab-case.ts` in `routes/`

## Route Structure

- Each resource: own Hono sub-app in `src/routes/`
- Sub-apps mounted on `/api` in `index.ts`
- Auth routes (`/api/auth/*`): registered BEFORE auth middleware
- All other routes: AFTER `app.use("/api/*", authMiddleware)`

## Auth & RBAC

- Current user: `c.get("user")` returns `AuthUser` (`id`, `email`, `displayName`, `role`)
- Admin-only: `requireRole("admin")` middleware from `middleware/rbac.ts`
- Sessions: httpOnly cookies. Never expose tokens in JSON responses.
- Dev mode: when `GOOGLE_CLIENT_ID` unset, falls back to hardcoded dev user

## Input Validation

- Validate query params and body manually — return 400 with `{ error: "message" }`
- Parse JSON body in try/catch — malformed JSON returns 400
- Validate IDs: `Number.isInteger(id) && id > 0`
- Validate enums: `VALID_STATUSES.includes(status)`

## Database (Drizzle)

- Use Drizzle query builder. Never raw SQL strings.
- Filter by `user.id` for user-scoped data
- Use `.returning()` for mutations needing the updated row
- Check `rows[0] === undefined` (not `!rows[0]`) for empty results
- Schema sync after Python migrations: `bunx drizzle-kit pull`

## Error Responses

All errors return `{ error: string }` with HTTP status:
- 400 invalid input
- 401 unauthenticated
- 403 unauthorized (wrong role)
- 404 not found
- 500 server error

## Pipeline Integration

- Long-running Python ops: `Bun.spawn` + SSE streaming
- Use `spawnPipeline()` and `streamSSE()` from `lib/pipeline.ts`
- Never await pipeline completion synchronously in a request handler

## Prohibited

- `npm`, `yarn`, `pnpm` commands
- Raw SQL strings (use Drizzle query builder)
- Exposing session tokens in JSON
- Synchronous pipeline awaits in handlers
- `dotenv` (Bun loads .env automatically)
- TODO/FIXME/HACK comments in committed code
