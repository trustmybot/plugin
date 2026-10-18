### Fixed
- **The L1–L4 sweep is green again on the live-DB shim layout test** (GH 1415): the test used grep -q in a pipeline under pipefail, which the sweep's own lint rejects; it now pipes into grep … >/dev/null.
