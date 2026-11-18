### Removed
- **no-source-edit-from-main judges only Edit and Write** (GH 3364, GH 2098): the gate no longer runs the Bash write-path analyzer to deny a command writing a prompt-surface file from the main checkout. The router never sent it Bash calls, so no decision changes; its Edit/Write rule stays as it was.
