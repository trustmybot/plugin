### Changed
- **The code-reviewer prompts describe the concise `task_brief`** (GH 1958): the reviewer now expects the changed dirs' paths without summaries and only the decision and intent rows that matter to its task. It asks for `response_format: 'detailed'` when `response_format_hint` shows something it needs was trimmed, so reviews read less by default without losing access to the rest.
