### Fixed
- **Parallel closes no longer fail on the audit embed test** (GH 1514): `assertAuditEmbedded` gave the background audit embed a fixed 15 s, which it overran when several swes ran their gates at once. It now waits up to 90 s and still returns as soon as the embed row lands.
