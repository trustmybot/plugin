### Fixed
- **Markdown purposes skip every HTML comment on a line** (GH 1934): a line that closed one comment and opened another, such as `<!-- a --> <!-- b`, let the text inside the second comment become the file's purpose. Every comment span on a line is now removed and an unclosed one is skipped through its `-->`; text beside a comment, as in `<!-- x --> text`, now counts as the line's text.
