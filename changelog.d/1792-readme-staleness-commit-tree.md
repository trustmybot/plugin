### Fixed
- **The README-staleness nudge no longer flags a README the commit itself edited** (GH 1792): it compared the checkout README's mtime to the commit date, so an edited README could still read as older than the commit. The TypeScript `post-atomic-close-readme` gate counts a README among the commit's own changed paths as fresh.
