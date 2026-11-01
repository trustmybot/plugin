# Memory model

This is the key principle of TMB's memory system, for every agent. Any change to what an agent loads, keeps or stores follows it. How many tokens TMB saves depends on how well memory swaps from hot to cold, and loads from cold to hot when needed.

TMB's memory works like a computer's:

| Tier | Computer | TMB | Holds | Cost |
|---|---|---|---|---|
| Cold | Hard disk | Trajectory DB, world model included | Everything permanent: issues, decisions, specs, verdicts, the project map | Paid once per load |
| Hot | RAM | Session context | Only what the current work reads often | Paid on every call while it stays |
| Pinned | Kernel | Persona, tool schemas, skill listing | What every call needs to function | Paid on every call by every agent, never evicted |

**The DB is the only source of truth. Context is a disposable cache of it, written through and never the only copy. Every agent loads the smallest page it needs, and ends at a task boundary.**

## Where the analogy breaks

These differences from real hardware are where the design decisions sit.

1. **Hot storage charges rent.** RAM costs nothing to hold, but context is re-read on every call, so an item costs its size times the calls left in the session. An item read once comes back as a conclusion and does not stay.
2. **No single item can be swapped out.** Context is append-only. The evictions that exist are ending the session, which is clean, and compaction, which is lossy and not ours to time. A subagent works like a separate process with its own address space: only its return value enters the caller's context. So most savings come from not loading an item and from ending sessions on time.
3. **Write through, never write back.** Context is volatile, so a decision reaches the DB when it is made. Evicting then loses nothing.
4. **Evict at boundaries.** A session ends when its dispatched work has returned and been closed or parked. The one timer that matters is prompt cache expiry: the next call then pays full price for the whole context, so a cold restart is usually cheaper.

## Loading from cold

- **Pages, not the disk.** A read returns the smallest useful unit: a concise brief, a section, a limit and a cursor.
- **An index first.** The world model and ranked search snippets are the page table: they say where to read before anything is read.
- **The DB must be trustworthy.** A stale DB makes agents re-derive state or keep their own copies, which breaks the model. A memory file written to carry state between sessions signals a design flaw to fix.

## Every agent

| Agent | Keeps hot | Loads from cold when needed |
|---|---|---|
| bro | The Human's current ask and the work in flight | Issues, decisions, the project map; investigation goes to a subagent |
| swe | One task's spec and the files it edits | `task_brief`, the world model |
| code-reviewer | One task's diff and its findings | `task_brief`, validation history |
| consultant | One question | Discussions, the audit log, the world model |

## Design test

Ask these of any change that adds context, a tool result, a prompt line or a store:

1. Which tier does it live in, and is that the cheapest tier that works?
2. If it is hot or pinned, how many calls pay for it, and is it read often enough to earn that?
3. If it is hot, what evicts it, and is it already in the DB by then?
4. If it is loaded from cold, is that the smallest page, and can it be found through an index?

## Status

| Work | Status |
|---|---|
| Usage warning on long bro sessions (GH 2193) | Shipped |
| Concise `task_brief` by section (GH 1958) | Shipped |
| bro's short-session prompt | **In flight (GH 2193)** |
| Limits and cursors on the other read tools | **In flight (GH 1958)** |
| Tool description budget for the pinned tier | **Planned (GH 2134)** |
| `issue_update_description` mirrors to the remote | **Planned (GH 2067)** |
