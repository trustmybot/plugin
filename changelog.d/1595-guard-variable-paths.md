### Fixed
- **The git guards follow a directory set by a variable earlier in the same command** (GH 1595): `R=<path>; git -C $R status` now runs where the variable points instead of being blocked as naming no directory. When a `git -C` or `cd` directory truly can't be resolved (an unset variable, `cd -`, `popd`), the block says so and asks for the literal path.
