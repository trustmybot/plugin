---
name: frontend-dev
description: React frontend development rules for SWE agents working in web/app/.
---

# Frontend Development

## Environment

- Runtime: Bun only. Never npm, yarn, pnpm.
- Framework: React 19, Vite + SWC
- Routing: React Router v7
- Data: TanStack Query (React Query)
- UI: shadcn/ui + Tailwind CSS 4
- Icons: lucide-react only
- Charts: Recharts
- Markdown: react-markdown + remark-gfm

## Verification (mandatory before COMPLETED)

```bash
cd web/app && bun run lint && bun run build
```

`bun run build` runs `tsc -b` + Vite bundling. MANDATORY. Lint alone misses import errors, type mismatches, and broken module boundaries.

## Naming

- Files: `kebab-case.tsx` / `kebab-case.ts`
- Variables, functions: `camelCase`
- React components: `PascalCase` (`DashboardPage`, `ScoreHistory`)
- Hooks: `use<Name>` (`useAuth`, `useJDs`)
- Types, interfaces: `PascalCase`
- Path alias: `@/` = `src/`

## Component Tier Model

### Tier 1 — CLI-Managed (`components/ui/`)
- NEVER edit files in `components/ui/` directly
- Update only via `bunx shadcn@latest add <name> --overwrite`
- Need different behavior? Create a Tier 2 wrapper.

### Tier 2 — Composed Wrappers (`components/composed/`)
- Naming: `gan-<name>.tsx` exporting `Gan<Name>`
- Current wrappers: GanCard, GanTabs
- Import rule: for wrapped components, ALWAYS import from `composed/`, NEVER from `ui/`
- The wrapper is the ONLY file that imports the corresponding Tier 1 component

### Tier 3 — Fully Owned
- `components/layout/`, `pages/`, feature components
- No restrictions. Our code.

Components WITHOUT a Tier 2 wrapper (button, badge, dialog, select, input, etc.) are imported directly from `@/components/ui/` as normal.

## Data Fetching

- All API calls through `lib/api.ts` (`fetchJSON`, `patchJSON`, `postJSON`)
- Use TanStack Query hooks for server state. Never `useEffect` + `fetch`.
- Query keys: `[resource, ...params]` (e.g., `["jobs", role]`)
- Mutations: `useMutation` with `onSuccess` to invalidate related queries
- Hooks in `hooks/` — one file per API resource

## Auth

- `useAuth()` hook returns current user or triggers login redirect
- Unauthenticated: shows `<LoginPage />`
- Auth state: TanStack Query calling `/api/auth/me`

## Conventions

- Named exports for pages (`export function JDsPage()`)
- Default export for `App.tsx` only
- No `useEffect` for data fetching
- No prop drilling — use hooks for shared state
- Tailwind CSS 4: `@import "tailwindcss"` not `@tailwind` directives
- Dark mode: `document.documentElement.classList.toggle("dark")`

## Design Reference

Visual design target: **Linear** (linear.app). Layout, spacing, typography, interaction patterns.

## Prohibited

- `npm`, `yarn`, `pnpm` commands
- Direct edits to `components/ui/*.tsx`
- `useEffect` + `fetch` for data loading
- Importing wrapped Tier 2 components from `ui/` instead of `composed/`
- Icons from anything other than lucide-react
- TODO/FIXME/HACK comments in committed code
