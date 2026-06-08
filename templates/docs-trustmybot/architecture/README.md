# Architecture Documentation

This directory contains human-maintained architecture reference material for your project.

## `manual/` — Human-maintained files

Files in `manual/` are written and owned by your team. The TMB plugin reads
them for context but never overwrites them.

| File | Contents |
|---|---|
| `data-flow.md` | Narrative request/response paths |
| `infrastructure.md` | Hosting, services, deployment topology |
| `security-model.md` | Auth, trust boundaries, secrets management |
| `decisions/` | Architecture Decision Records (ADRs) |

Codebase-tree and module-graph queries are answered live from the kuzu world model via `world_model_get` / `world_model_search`.

## Workflow

1. Write new ADRs in `manual/decisions/` using the `0001-example.md` template
   whenever a change crosses TMB's architectural threshold (see the
   `adr-required-hint.sh` advisory).
2. Update the manual narrative files when an architectural change lands.
