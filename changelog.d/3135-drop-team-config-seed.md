### Removed
- **The unread team-config seed template is gone** (GH 3135): the plugin no longer ships `templates/project-seed/.claude/tmb/config.example.json`, whose comment promised that onboarding pre-selects options from a committed `.claude/tmb/config.json`. Onboarding reads no committed config file, so the template and its promise are both removed.
