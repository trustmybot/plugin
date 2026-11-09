### Changed
- **code-reviewer's task brief is leaner by default** (GH 2663): a concise `task_brief` call from code-reviewer now leaves out `locations` and `concepts` and skips the symbol-index lookup behind them, flagging the trim with `response_format_hint`. `response_format: 'detailed'` still returns both; swe, bro and consultant briefs are unchanged.
Metric: tokens_per_task lower
