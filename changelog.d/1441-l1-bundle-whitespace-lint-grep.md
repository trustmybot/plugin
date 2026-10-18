### Fixed
- **The bundle-whitespace L1 lint runs on CI runners without ripgrep** (GH 1441): bundle-whitespace-safety.sh called rg, which GitHub's ubuntu runner lacks, so release-gate failed at the L1-L4 sweep with `rg: command not found`; the lint now uses grep -F -q.
