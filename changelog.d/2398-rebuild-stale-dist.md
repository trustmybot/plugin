### Fixed
- **Tracked build output is current again** (GH 2398): `mcp/trajectory-server/dist/` and `dashboard/dist/` are rebuilt from source after the `platform.ts` doc-comment edit, so `regen-generated.ts --check` and `dist-fresh.sh` pass on dev.
