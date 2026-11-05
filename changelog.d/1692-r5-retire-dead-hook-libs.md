### Removed
- **Three unused hook shell libs are gone** (GH 1692): `scripts/hooks/lib/resolve-toolchain-path.sh`, `scripts/hooks/lib/resolve-workspace.sh` and `scripts/hooks/lib/verification-runs.sh` had no remaining callers and are deleted; `swe-verification-gate` records its runs through `mcp/trajectory-server/src/hooks/lib/verification-runs.ts`. Behaviour is unchanged.
