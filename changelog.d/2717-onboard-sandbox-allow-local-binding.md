### Fixed
- **`/onboard`'s sandbox step allows loopback binding** (GH 2717): it now sets `sandbox.network.allowLocalBinding: true`, kept as you set it if already there, and removed on **No** only when TMB added it.
