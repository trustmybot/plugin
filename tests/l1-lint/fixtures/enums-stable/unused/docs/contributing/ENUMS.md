# Fixture ENUMS.md for enums-stable.sh's self-test

### `issues.status` — issue lifecycle

| Value | Meaning |
|---|---|
| `open` | open |
| `closed` | closed |

### `tasks.status` — task lifecycle

| Value | Meaning |
|---|---|
| `pending` | not started |
| `closed` | done |

### `validation_attempts.verdict` — verdict

| Value | Meaning |
|---|---|
| `pass` | ok |
| `fail` | not ok |

### `discussions.kind` — kind

| Value | Meaning |
|---|---|
| `note` | narrative |

### `milestones.state` — state

| Value | Meaning |
|---|---|
| `open` | open |

### `audit.from_node` — writer

| Value | Notes |
|---|---|
| `bro` | persona |
| `system` | runtime |
| `hook:<name>` | a hook |

### `audit.event_type` — events

| Value | Trigger |
|---|---|
| `demo_event` | written by the fixture tool |
| `hook_event` | written by the fixture hook |
| `agent_event` | reserved — written by an agent via audit_append |
| `phantom_event` | documented but never written |

### `agent_runs.usage_source` — usage

| Value | Meaning |
|---|---|
| `transcript` | measured |
