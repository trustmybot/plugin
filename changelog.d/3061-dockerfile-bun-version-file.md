### Fixed
- **Release install smoke tests use the project's bun version** (GH 3061): the Linux install-smoke and release-canary images installed bun 1.3.4 while every workflow used the 1.4.4 in `.bun-version`. Both images now read `.bun-version`, and a test fails if either one hardcodes a bun version again.
