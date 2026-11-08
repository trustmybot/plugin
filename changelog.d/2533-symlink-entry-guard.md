### Fixed
- **payload-parity and run-docker run through a symlinked path** (GH 2533): `scripts/maintenance/payload-parity.ts` and `tests/l0-install/run-docker.ts` compared the unresolved `argv[1]` with the realpath of the module, so through a symlinked directory they did nothing and exited 0. Both now compare realpaths and run as invoked.
