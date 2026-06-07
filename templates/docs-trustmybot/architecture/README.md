# Architecture Documentation

This directory contains architecture reference material for your project, split
into two subdirectories with different lifecycles.

## `auto/` — Generated files

Files in `auto/` are auto-rendered placeholders. The renderer code lives in
`mcp/trajectory-server/src/renderers/` but the scan-side renderer pass is
currently inert (see #2881 follow-up). Do not edit them directly.

> **Note:** codebase-tree and module-graph queries are now answered live from
> the kuzu world model via `world_model_get` / `world_model_search` — the
> static rendered files here are supplementary snapshots only.

The intended outputs:

| File | Contents |
|---|---|
| `codebase-tree.md` | Directory tree with file summaries (static snapshot; live queries via kuzu) |
| `erd.md` | Entity-relationship diagram inferred from schema files |
| `module-graph.md` | Dependency graph between modules (static snapshot; live queries via kuzu) |
| `changelog.md` | Curated change log derived from git history |

## `manual/` — Human-maintained files

Files in `manual/` are written and owned by your team. The TMB plugin reads
them for context but never overwrites them.

| File | Contents |
|---|---|
| `data-flow.md` | Narrative request/response paths |
| `infrastructure.md` | Hosting, services, deployment topology |
| `security-model.md` | Auth, trust boundaries, secrets management |
| `decisions/` | Architecture Decision Records (ADRs) |

## Workflow

1. Write new ADRs in `manual/decisions/` using the `0001-example.md` template
   whenever a change crosses TMB's architectural threshold (see the
   `adr-required-hint.sh` advisory).
2. Update the three manual narrative files when an architectural change lands.
