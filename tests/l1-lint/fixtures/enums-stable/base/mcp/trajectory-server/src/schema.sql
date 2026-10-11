CREATE TABLE IF NOT EXISTS milestones (
    id     INTEGER PRIMARY KEY,
    state  TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open'))
);

CREATE TABLE IF NOT EXISTS issues (
    id     INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id     INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','closed'))
);

CREATE TABLE IF NOT EXISTS validation_attempts (
    id      INTEGER PRIMARY KEY,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail'))
);

CREATE TABLE IF NOT EXISTS discussions (
    id   INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('note'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id           INTEGER PRIMARY KEY,
    usage_source TEXT CHECK (usage_source IN ('transcript'))
);
