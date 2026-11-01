### Fixed
- **TypeScript hooks print JSON objects with their keys in input order** (GH 1692): a JS object moved integer-like keys such as `"2"` to the front in ascending order, so a gate that re-serialized a payload object could print it in a different order from the `.sh`. Those gates now print jq's order, and no gate's allow or deny outcome changes.

### Changed
- **On non-JSON stdin the TypeScript gates stay silent** (GH 1692): the `.sh` leaves jq's parse errors on stderr, and the TypeScript gate prints nothing. This is an accepted difference under decision 703, because that text is jq's internals and not part of a gate's contract. It has a `corpus_divergent` payload and a unit test.
- **A new test fails on a banned field on a deny-capable hook registration** (GH 1692): `src/test/hook-registration-fields.test.ts` rejects an `mcp_tool`, `prompt` or `agent` hook and any `if` in `hooks/hooks.json`, unless every gate of that registration is proven advisory in the registry. An unknown gate or an unparseable command counts as deny-capable.
