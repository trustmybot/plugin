### Fixed
- **`/dashboard` starts inside the Bash sandbox** (GH 2601): the server now starts sandboxed. Only on `listen EPERM` does it re-run once outside the sandbox and point you at `/onboard` to keep the next start inside.
