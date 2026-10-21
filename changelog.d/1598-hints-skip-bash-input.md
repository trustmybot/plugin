### Fixed
- **Prompt hints ignore `!` shell turns** (GH 1598): running a command with `!` sent its input and captured output through the prompt-intent hints, so a word like `check` in the output fired the audit hint. The hook now drops the `<bash-input>`, `<bash-stdout>` and `<bash-stderr>` spans before matching and stays silent when nothing you typed remains.
