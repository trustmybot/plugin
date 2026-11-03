### Changed
- **One prompt-surface check for the command lister** (GH 1861): `cmd-analysis/lister.ts` now imports `isPromptSurfacePath` from `cmd-analysis/surface.ts` instead of keeping its own copy, so the lister and swe-boundary's Edit and Write checks judge prompt surfaces with the same code.
