### Fixed
- **TypeScript hooks print JSON objects with their keys in input order** (GH 1692): a JS object moved integer-like keys such as `"2"` to the front in ascending order, so a gate that re-serialized a payload object could print it in a different order from the `.sh`. Those gates now print jq's order, and no gate's allow or deny outcome changes.
