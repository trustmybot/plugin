### Fixed
- **Inline Python or Node programs that start a process get an accurate block message** (GH 1602): a program such as `subprocess.run(['true', str(n)])` whose arguments aren't all literal is now told that its process call can't be checked, and to use literal arguments or run it from the shell, instead of a message about a `$()` command substitution it never wrote.
