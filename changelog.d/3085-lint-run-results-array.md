### Fixed
- **The code-reviewer spawn gate finds the close-lint record again on Node's built-in SQLite** (GH 3085): on Node v26, the hooks read a lint run's results as a JSON string instead of an array, so every code-reviewer spawn was denied with `no_lint_record`. The results now stay an array whichever SQLite backend the hooks use.
