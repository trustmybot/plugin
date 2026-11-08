### Fixed
- **`swe-edit-lint` globs match dot paths** (GH 2570): `**/*` in `.config/tmb/edit-lint.json` now matches `.github/x.yml` and other dot paths, so the plugin's edit-lint.json needs one glob instead of three.
