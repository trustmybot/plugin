### Security
- **Fetched text can no longer forge an untrusted-content frame** (GH 1356): `frameUntrusted` now neutralises case and whitespace variants of the closing marker and any embedded opening tag, so remote issue bodies, PR comments and README text cannot end the frame early or open a fake nested one.
