# Memory model

This is the key principle of TMB's memory system, for every agent. Any change to what an agent loads, keeps or stores follows it. How many tokens TMB saves depends on how well memory swaps from hot to cold, and loads from cold to hot when needed.

TMB's memory works like a computer's:

| Tier | Computer | TMB | Holds | Cost |
|---|---|---|---|---|
| Cold | Hard disk | Trajectory DB, world model included | Everything permanent: issues, decisions, specs, verdicts, the project map | Paid once per load |
| Hot | RAM | Session context | Only what the current work reads often | Paid on every call while it stays |
| Pinned | Kernel | Persona, tool schemas, skill listing | What every call needs to function | Paid on every call by every agent, never evicted |

**The DB is the only source of truth. Context is a disposable cache of it: everything is written to the DB as it happens, so context is never the only copy. Every agent loads the smallest page it needs, and ends its session at a task boundary.**

One agent session moves memory between the tiers like this:

```mermaid
flowchart TD
    A[Session starts: the pinned tier loads persona, tool schemas and skill listing] --> B[The work needs a fact]
    B --> C[Find it through an index: the world model or ranked search]
    C --> D{Read often in this session?}
    D -- yes --> E[Load the smallest page from the DB into context, hot]
    D -- no --> F[Read it once or in a subagent; only the conclusion enters context]
    E --> G[Work and decide]
    F --> G
    G --> H[Write each decision to the trajectory DB as it is made]
    H --> I{Dispatched work returned and closed or parked?}
    I -- no --> B
    I -- yes --> J[End the session: context is evicted and nothing is lost]
    J -. the next session loads from cold .-> A
```

## Where the analogy breaks

These differences from real hardware are where the design decisions sit.

1. **Hot storage charges rent.** RAM costs nothing to hold, but context is re-read on every call, so an item costs its size times the calls left in the session. An item read once comes back as a conclusion and does not stay.
2. **No single item can be swapped out.** Context is append-only. Only two things remove items from context: ending the session, which loses nothing, and compaction, which loses detail and happens at a time TMB does not choose. A subagent works like a separate process with its own address space: only its return value enters the caller's context. So most savings come from not loading an item and from ending sessions on time.
3. **Write through, never write back.** Context is volatile, so a decision reaches the DB when it is made. Evicting then loses nothing. A decision is anything a later step reads back, such as a status change, a verdict or a spec, and it is written before the work moves on. Telemetry that nothing on the hot path reads back, such as hook calls, run usage and upstream sync, may be queued and written in the background so it never blocks the work; losing a row of it breaks nothing.
4. **Evict at boundaries.** A session ends when its dispatched work has returned and been closed or parked. The one timer that matters is prompt cache expiry: the next call then pays full price for the whole context, so a cold restart is usually cheaper.

Since nothing in hot storage can be evicted, a hook cuts the long output of bro's routine read-only shell commands to its head and tail before it enters context.

## Loading from cold

- **Pages, not the disk.** A read returns the smallest useful unit: a concise brief, a section, a limit and a cursor.
- **An index first.** The world model and ranked search snippets are the page table: they say where to read before anything is read.
- **The DB must be trustworthy.** A stale DB makes agents re-derive state or keep their own copies, which breaks the model. A memory file written to carry state between sessions signals a design flaw to fix.

## Where the trajectory DB lives

Cold storage is one DB per project, and one rule decides which `trajectory.db` the server and every hook open; each implements it once, and a lint fails on a third copy. `<plugin>` is the plugin's name (`tmb` when unset).

1. **`TRAJECTORY_DB_PATH`**, if set. The hooks require the file to exist; the server creates it.
2. **Walk up** from `CLAUDE_PROJECT_DIR`, else the working directory, collecting every ancestor `.claude/<plugin>/trajectory.db`. The walk never enters `$HOME` unless it started there, does not stop at `.git`, and skips a legacy DB that predates the current task schema. A `standalone` file beside a candidate ends the walk and wins; otherwise the **outermost** candidate wins, so a workspace of several repos shares one DB.
3. Otherwise **unresolved**; the server creates a fresh DB at `<CLAUDE_PROJECT_DIR or cwd>/.claude/<plugin>/trajectory.db`.

Under a test flag (`TMB_FORBID_LIVE_SYNC=1` or `TMB_TEST_RUN_ID`) the hooks never walk: they open only `TRAJECTORY_DB_PATH` or the DB under `CLAUDE_PROJECT_DIR`. Scripts never run the rule; they take an explicit `TRAJECTORY_DB_PATH`. The project root is the directory holding the resolved DB. Only the server migrates the DB; every other opener refuses an older schema. The doctor's `no_other_trajectory_dbs` warning lists other live DBs on the walk or up to four levels below the root, and `/onboard` offers to pick the workspace, make the session directory standalone, or remove empty strays.

| DB state | Meaning | Gates that can deny | Advisory hooks |
|---|---|---|---|
| unresolved | No DB anywhere. Today a missing SQLite backend also counts as unresolved; planned (GH 3260): when a DB file exists and SQLite is missing, gates deny | Allow | Silent no-op |
| needs migration | The only DB found predates the current task schema and has not been migrated yet | Deny, naming the migration that has not run (planned, GH 3260; today this counts as unresolved and allows) | Allow, print one stderr line |
| newer than the plugin | The DB was migrated by a newer plugin than the one running: a downgrade, or two channels in one project | Planned (GH 3260): deny at session start and name the plugin version to upgrade to; nothing downgrades a DB. A session already open when another session migrates keeps running until its restart. Today the tools vanish and the gates decide against a schema they do not know | Allow, print one stderr line |
| ok | The DB answers a read | Decide normally | Run normally |
| error | The DB resolved but the read failed: busy, corrupt, or unreadable | Deny with `BLOCKED: trajectory DB unavailable — <hook> could not read <path> …` | Allow, print one stderr line |

A gate denies when the DB is unreadable, so it never lets through what it cannot check. A gate allows when there is no DB, so TMB stays out of projects it never touched. A project that has a DB is TMB's, so TMB works there only when its health check is green: a DB that still needs its migration denies like an unreadable one. A DB the server created for a project that has not finished first contact is `ok`: gates decide normally, and bro's first turn runs first contact.

### When the health check is not green

Planned (GH 3260); the Human decided these on 2026-11-18. Today a DB that cannot be read denies every Bash call and every file write, so the agent cannot run the health check or read a log.

- **What not green means.** The trajectory DB or the world model is unreadable, needs its migration or is newer than the plugin, or the trajectory server is not running. A warning of the health check never makes it not green.
- **What is denied.** Writes and workflow actions: file writes, commits and pushes, task and issue changes, agent spawns. Read-only commands and the health check stay allowed, so the agent can see what is wrong and tell the Human.
- **A migration in progress is waited for.** At the start of an upgraded session the server may still be migrating. A gate that finds the DB mid-migration waits a short time and reads again before it denies.
- **The way out is in the message.** Each deny names the state and the step that clears it: restart for a migration that has not run, the version to install for a newer DB, the backup to restore for a migration that failed.

## Every agent

| Agent | Keeps hot | Loads from cold when needed |
|---|---|---|
| bro | The Human's current ask and the work in flight | Issues, decisions, the project map; investigation goes to a subagent |
| swe | One task's spec and the files it edits | Its task brief, the world model |
| code-reviewer | One task's diff and its findings | Its task brief, validation history |
| consultant | One question | Discussions, the audit log, the world model |

## Design test

Ask these of any change that adds context, a tool result, a prompt line or a store:

1. Which tier does it live in, and is that the cheapest tier that works?
2. If it is hot or pinned, how many calls pay for it, and is it read often enough to earn that?
3. If it is hot, what evicts it, and is it already in the DB by then?
4. If it is loaded from cold, is that the smallest page, and can it be found through an index?
