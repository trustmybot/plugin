### Fixed
- **L5 row 07-post-close-cleanup accepts Bash cat as the file read** (GH 1436): the row required the Read tool, but bro reads src/cli.py with Bash cat and summarizes it correctly, so the required-tools scorer failed deterministically; tools-required.json now uses an any_of entry so Read or Bash satisfies the file-read expectation.
