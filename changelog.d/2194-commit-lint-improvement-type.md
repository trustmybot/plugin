### Fixed
- **`⚡ improvement(scope): ...` commits no longer draw a lint warning** (GH 2194): `commit-msg-lint` left `improvement` out of its allowed types even though the project maps ⚡ to it. It now accepts `improvement`, and an unknown type still warns.
