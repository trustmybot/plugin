### Fixed
- **A doc that says "README.md" in prose no longer fails the close gate when its folder's README.md is removed** (GH 2928): the stale-doc check now counts a same-folder name like `README.md` only when the doc links it (`[x](README.md)`, `[x]: ./README.md` or `./README.md`); the full repo path still counts anywhere.
