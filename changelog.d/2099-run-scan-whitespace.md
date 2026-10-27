### Fixed
- **The full test suite passes the bundle whitespace lint again** (GH 2099): `mcp/trajectory-server/dist/run-scan.js`, a generated bundle since GH 1850, had no `-whitespace` entry in `.gitattributes`, so `bundle-whitespace-safety.sh` failed and every full suite on dev was red. It now opts out of git whitespace diagnostics like the other three bundles.
