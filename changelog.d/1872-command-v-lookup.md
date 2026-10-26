### Fixed
- **`command -v` is no longer blocked as an unjudged write** (GH 1872): `containment-guard` read `command -v bash` as `bash` reading a program from stdin and denied it. Now `command -v` / `-V` counts as a lookup that runs nothing, though its own redirects are still judged.
