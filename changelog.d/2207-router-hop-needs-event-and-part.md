### Fixed
- An install hands a hook call to another install only when that install's router table has the call's event and part, for an unparseable payload too (GH 2207). With an older target, Stop now logs and exits 0, SubagentStop still blocks, and no `unknown gate` appears.
