### Fixed
- **The world-model scope test passes again** (GH 2642): it now expects the `caller:chargeCard` entry that an exported alias such as `export const charger = chargeCard;` adds to `scope_suggest` ranking since that alias became a call edge.
