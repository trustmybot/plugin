### Fixed
- **Audit and perf prompt hints use one word-boundary rule in every locale** (GH 2104): a keyword such as `check` or `audit` now counts only when no letter from any script sits directly next to it, so `checkż` or `þcheck` no longer behave differently depending on your locale, while `café check` still gets the hint.
