# docs/reference/

Operational lookups bro and contributors hit occasionally — kept here so they don't bloat `CLAUDE.md`. Where state lives, what platforms are supported, and what to expect on upgrade.

| File | Purpose |
|---|---|
| [`REFERENCE.md`](./REFERENCE.md) | Where workflow state lives — trajectory DB, world model, and CC config paths |
| [`CONFIG_KEYS.md`](./CONFIG_KEYS.md) | Every `plugin_config` key — type, default, who sets it, effect (generated) — and the repo-scoped policy on `repos` |
| [`TRAJECTORY_DB_LOCATION.md`](./TRAJECTORY_DB_LOCATION.md) | The one rule the server and hooks use to find the trajectory DB, and how gates treat an unresolved vs unreadable DB |
| [`INSTALL.md`](./INSTALL.md) | Supported operating systems, recommended install scope and exactly what `/onboard` writes where (all inside the project) |
| [`UPGRADE.md`](./UPGRADE.md) | Plugin + trajectory-DB version migration — what to expect, recover, and roll back |
