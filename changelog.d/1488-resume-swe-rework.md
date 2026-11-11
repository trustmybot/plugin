### Changed
- **bro resumes the swe that wrote the commit for in-scope rework** (GH 1488): when the review findings fit the task's spec and files and its effort is unchanged, bro now reopens the task and sends the findings to that same swe with `SendMessage`, so it keeps the files and diff it already read instead of a fresh swe re-reading them; a raised effort or a lost agent id still gets a fresh swe, and every review attempt still gets a fresh code-reviewer.
Metric: tokens_per_task lower
