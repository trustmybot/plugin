### Fixed
- **`/dashboard` starts inside the Bash sandbox** (GH 2717): `/onboard`'s sandbox step now sets `sandbox.network.allowLocalBinding: true`, so `/dashboard` can listen on loopback and starts inside the sandbox instead of outside it.
