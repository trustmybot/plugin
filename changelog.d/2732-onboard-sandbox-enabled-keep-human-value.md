### Fixed
- **`/onboard` sandbox removal keeps a `sandbox.enabled` the Human changed** (GH 2732): `removeProjectSandbox` now deletes `sandbox.enabled` only when TMB recorded setting it and it is still `true`, the rule GH 2719 gave `allowLocalBinding` and `enableWeakerNetworkIsolation`. An `enabled` the Human flipped to `false` stays, and the `sandbox` object is kept while it holds it.
