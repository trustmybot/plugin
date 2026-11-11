### Added
- **bro reports times in your local time zone** (GH 2338): the persona hook now adds a `User time zone: <zone> (UTC±HH:MM)` line after the project root line on SessionStart and UserPromptSubmit, and bro gives times to you in that zone with its abbreviation (such as 21:34 PST). Timestamps written to GitHub, commits and the trajectory DB stay in UTC.
