### Fixed
- **The dashboard no longer shows internal error details in failed responses** (GH 1953): when a request hit an unexpected error, the server sent the raw error message back to the browser. It now answers with a fixed `internal_error` message and writes the full error to the terminal running the dashboard, so the details stay in that terminal.
