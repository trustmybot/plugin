# Environment profile

Every case of flow 2.3 in [FLOWS.md](FLOWS.md): how bro learns a repo's install, test and lint commands without a hardcoded toolset.

```mermaid
flowchart TD
    A[bro needs a repo's commands] --> B{Profile recorded?}
    B -- yes --> C{Its evidence changed?}
    C -- no --> U[Use the cached commands]
    C -- yes --> D
    B -- no --> D[Detect: read CI steps, task runners, manifests, config, lockfiles]
    D --> E[bro resolves the commands per category]
    E --> F[Record; overrides, waivers and declines survive]
    F --> U
```

- **Detect runs nothing.** It reads the repo's evidence and flags a recorded profile whose evidence changed.
- **Record keeps bro's call.** The resolved commands are stored per category, per machine; its overrides, waivers and declines survive a re-record.
- **The repo is the source of truth.** Teammates, CI and editors enforce the same rules without TMB, so the profile is only a cache, and first contact offers its commands as the repo's committed defaults.
