### Fixed
- **A `<!--` inside an inline code span no longer hides a markdown file's purpose** (GH 1938): a line such as ``Use `<!--` to start a comment.`` opened an HTML comment and skipped every line up to the next `-->`. Inline code spans on a line are now read before comments, as CommonMark does, so whichever starts first wins and the code span's text stays in the purpose.
