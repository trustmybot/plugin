### Fixed
- **The sandbox-network probe's `.env` reader matches shell sourcing for `A=#x` and CRLF files** (GH 1692): `parseDotEnv` in `tests/l5-l6/probes/sandbox-network-probe.ts` keeps `A=#x` as `#x` (a `#` starts a comment only after whitespace, so `A= #x` stays empty and `F=a#b` stays `a#b`), and reads every key of a CRLF file instead of dropping each line.
