### Fixed
- **The router's budget table gives the 3630 s trajectory-server PreToolUse timeout** (GH 2401): `swe-verification-gate`'s router floor was still 1830 s, so the router's own timeout came to 1833 s while hooks.json registers 3630 s and the router-budgets test failed. The floor is now 3627 s, so the budgets and the registration agree on the close gate's suite-slot wait (GH 2297).
