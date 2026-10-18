### Fixed
- **L5 row 08-push-gate seeds a verification command that passes the grep -q lint** (GH 1442): the seeded `python3 todo.py | grep -qx todo` tripped the no-grep-q-in-pipelines L1 lint and is unsafe under pipefail; the command is now `python3 todo.py | grep -x todo >/dev/null`, so release-gate lint passes and the verification gate behaves identically.
