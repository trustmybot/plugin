### Fixed
- **`node -e` one-liners that call `Buffer.byteLength` are no longer denied as unproven** (GH 2669): a read-only program such as `node -e 'console.log(Buffer.byteLength("ab"))'` was blocked by the containment guard because the inline-program proof had no entry for `Buffer.byteLength`. The proof now admits exactly that call; every other `Buffer` member stays unproven and fails closed.
