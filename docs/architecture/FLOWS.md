# TMB Workflows

This file is the starting point for every flow: one chart each for its ideal case, a short description, and a link to the detail page that holds every other case, failures included, and how to debug them. A flow whose chart says everything has no detail page. Who owns each quality check, and how a task hands from one owner to the next, is in [TASKS.md](TASKS.md#quality-layers).

It is the ground truth for the workflow: it describes what ships and marks unshipped behaviour as planned, with its GitHub issue. A PR that changes a flow updates its chart here, and its detail page, in the same PR. Neither names a hook, gate, tool or symbol: what enforces a step is the world model's answer, and the logic is the code's.

Flows are grouped by when they run, and numbered within their group.

| Group | # | Flow | Trigger | Agents | State it leaves |
|---|---|---|---|---|---|
| 1. Install | 1.1 | [Install and session start](#11-install-and-session-start) | Plugin install, then every session start | — (the plugin itself) | per-session markers |
| 2. Cold start | 2.1 | [First contact](#21-first-contact) | A project that is not yet onboarded | bro | project shape, repo and remote settings, the onboarded marker |
| 2. Cold start | 2.2 | [Scan and world-model refresh](#22-scan-and-world-model-refresh) | An empty world model, `/scan`, or the trajectory server connecting | bro (or the server, in background) | the world model and the discovered-capability registry |
| 2. Cold start | 2.3 | [Environment profile](#23-environment-profile) | bro needs a repo's install, test and lint commands | bro | a per-machine cache of resolved commands |
| 3. Agent task handling | 3.1 | [Code task](#31-code-task) | An ask that changes code, architectural changes included | bro → swe; code-reviewer per task; bro closes after its pass | issue, decision, task, run, verification and review records; a reviewed, pushed branch and its PR |
| 3. Agent task handling | 3.2 | [Non-code task](#32-non-code-task) | An ask that changes only docs or prompts | bro writes it; code-reviewer grades it with the doc-review checklist | as 3.1, the task marked docs or prompts |
| 3. Agent task handling | 3.3 | [Push gate](#33-push-gate) | Each completed task bro hands to review; any push | bro → code-reviewer (one per task, parallel) | a verdict per reviewed commit, with its findings |
| 3. Agent task handling | 3.4 | [Retry and escalation](#34-retry-and-escalation) | A design misfit, a review fail, or an integrate conflict | bro ↔ the author (↔ code-reviewer per task) | further attempts and their findings, or a fresh task |
| 3. Agent task handling | 3.5 | [PR comment triage](#35-pr-comment-triage) | Review comments reach a PR bro owns | bro → swe, or bro itself, per task-worthy comment group | stored comments, reopened or new tasks on the PR's issue, a fetch cursor |
| 3. Agent task handling | 3.6 | [Multi-repo workspaces](#36-multi-repo-workspaces) | Inner repos registered; bro indexes them | bro | repo-relative world-model paths, scoped per repo |
| 3. Agent task handling | 3.7 | [Bulk cleanup](#37-bulk-cleanup) | Human pre-authorizes a bulk delete | bro (direct, no swe) | — |
| 4. Extending the team | 4.1 | [Cheatcode lifecycle](#41-cheatcode-lifecycle) | A capability wall, the Human says "cheatcode", or a reuse check before building | bro (Human approves install) | the capability registry and its attachments |
| 4. Extending the team | 4.2 | [Agent creation](#42-agent-creation) | Routing hits a role the project has no agent for | bro | a project agent file |
| 4. Extending the team | 4.3 | [Skill creation](#43-skill-creation) | Recurring pattern needs encoding | bro | a registered skill |
| 4. Extending the team | 4.4 | [Consultant invocation](#44-consultant-invocation) | Human asks for a second opinion | bro → consultant | the consultant's analysis |
| 4. Extending the team | 4.5 | [Roundtable](#45-roundtable) | The Human types `/roundtable <topic>` | bro orchestrates 2–5 consultants | the table, its votes and the ratified decision |
| 5. Reporting TMB bugs | 5.1 | [Bug report](#51-bug-report) | bro hits a real TMB bug and the Human opted in | bro (Human approves each report) | a record of each filed report |

## 1. Install

### 1.1 Install and session start

The Human installs TMB at project or local scope and restarts; from then on, every session start marks the session and runs advisory checks that never block it. [INSTALL.md](INSTALL.md) covers each case, including a broken install, and how to debug it.

```mermaid
flowchart LR
    A[Human installs at project or local scope] --> B[Full restart]
    B --> C[Plugin loads: agents, server, hooks]
    C --> D[Session start: advisory checks pass]
    D --> E[First prompt: 2.1 First contact]
```

## 2. Cold start

On a new project these flows run once, in this order; later sessions skip what is already done.

### 2.1 First contact

The first bro turn on a project that isn't onboarded runs `/onboard` before any reply. bro asks in rounds, and the answers land in one transaction with the onboarded marker. [ONBOARD.md](ONBOARD.md) covers each round and when it runs.

```mermaid
flowchart LR
    A[Project not onboarded] --> B[bro re-probes the project]
    B --> C[Rounds: shape, branching, sync, sandbox, bug reports]
    C --> D[Answers and onboarded marker land together]
```

### 2.2 Scan and world-model refresh

A scan builds the project map bro reasons from and reconciles the capabilities already on disk. [WORLD_MODEL.md](WORLD_MODEL.md) covers what the map holds and how it stays current.

```mermaid
flowchart LR
    A[Empty world model, /scan, or server connects] --> B[Index each repo at its target commit]
    B --> C[Directory summaries, file purposes, symbol edges]
    C --> D[Reconcile on-disk skills, plugins, MCP servers]
```

### 2.3 Environment profile

When bro needs a repo's install, test and lint commands, it works them out from the repo's own evidence; no toolset is hardcoded. [ENVIRONMENT.md](ENVIRONMENT.md) covers what it reads and what survives a re-record.

```mermaid
flowchart LR
    A[bro needs a repo's commands] --> B[Detect from CI, manifests, config]
    B --> C[Record resolved commands per category]
    C --> D[Per-machine cache]
```

## 3. Agent task handling

[TASKS.md](TASKS.md) holds every case of flows 3.1 to 3.5: what each step guarantees, the failure paths and how to debug a stuck task.

### 3.1 Code task

The canonical chain: bro plans and gates, swe implements, code-reviewer reviews, and the Human merges. An architectural change also records a decision naming its blast radius at provision, and bro weighs the change against it at close.

```mermaid
flowchart LR
    A[Human asks] --> B[bro grounds and records intent]
    B --> C[bro provisions task, branch, worktree]
    C -. architectural .-> C1[Decision and blast radius recorded]
    C1 -.-> D
    C --> D[swe implements and closes]
    D --> E[3.3 Push gate: pass]
    E --> F[bro closes task, pushes, opens PR]
    F --> G[Human merges]
```

### 3.2 Non-code task

A docs or prompts change bro writes itself, in a task worktree marked with that kind; code-reviewer grades it with the doc-review skill, and bro's self-check with that skill before review is planned (GH 3073).

```mermaid
flowchart LR
    A[Human asks] --> B[bro grounds and records intent]
    B --> C[bro provisions a docs or prompts task]
    C --> D[bro edits and closes]
    D --> E[3.3 Push gate: pass]
    E --> F[bro closes task, pushes, opens PR]
    F --> G[Human merges]
```

### 3.3 Push gate

Each completed task of either kind gets its own code-reviewer, in parallel, and no task commit is pushed without a passing verdict for that commit.

```mermaid
flowchart LR
    A[Task handed to review] --> B[code-reviewer probes the diff's dependents, or grades docs and prompts with the doc-review checklist]
    B --> C[Recorded verdict: pass]
    C --> D[bro closes, pushes, opens PR]
```

### 3.4 Retry and escalation

A review fail, a design misfit or an integrate conflict sends the task back to its owner without waiting on the Human.

```mermaid
flowchart LR
    A[Fail, misfit or conflict] --> B[bro reopens or retries the task]
    B --> C[The author reworks: swe, or bro on a non-code task]
    C --> D[3.3 Push gate]
```

### 3.5 PR comment triage

Review comments on a PR bro owns become tasks through 3.1 or 3.2, on the PR's own issue.

```mermaid
flowchart LR
    A[Comments reach a PR bro owns] --> B[Fetch and store each once]
    B --> C[Group the task-worthy ones]
    C --> D[3.1 or 3.2 per group, on the PR's issue]
```

### 3.6 Multi-repo workspaces

A workspace's inner repos are identified by registration, which scopes both the world model's repo-relative paths and source protection. [GIT.md](GIT.md#multi-repo-workspaces) covers how each operation resolves to its repo.

```mermaid
flowchart LR
    A[Inner repos registered] --> B[World-model paths stored per repo]
    A --> C[bro may not edit registered repos from the main checkout]
```

### 3.7 Bulk cleanup

When the Human's prompt names what to delete, bro does it in one step with no re-confirmation: defensive checks belong before the Human authorizes, and re-asking treats a standing directive as a question.

```mermaid
flowchart LR
    A[Human names what to delete] --> B[bro deletes in one step]
```

## 4. Extending the team

### 4.1 Cheatcode lifecycle

bro acquires a published skill, MCP toolkit or plugin instead of building a capability by hand, and the Human approves each install. [CHEATCODES.md](CHEATCODES.md) covers every stage, the trust design and teardown.

```mermaid
flowchart LR
    A[Capability gap] --> B[Search registries]
    B --> C[Vet the pick]
    C --> D[Human approves]
    D --> E[Install and attach to its agent]
    E --> F[Activate]
```

### 4.2 Agent creation

When routing hits a role the project has no agent for, bro drafts one and the Human approves it before the project agent file is written. [EXTENDING.md](EXTENDING.md) covers 4.2 to 4.5, including what each refuses.

```mermaid
flowchart LR
    A[Role with no agent] --> B[Up to three questions]
    B --> C[Tailored draft]
    C --> D[Human approves]
    D --> E[Agent file written and registered]
```

### 4.3 Skill creation

A recurring pattern becomes a project skill the same way: bro drafts, the Human approves.

```mermaid
flowchart LR
    A[Recurring pattern] --> B[bro drafts the skill]
    B --> C[Human approves]
    C --> D[Skill lands in the project]
```

### 4.4 Consultant invocation

A consultant answers a second-opinion question; bro reports its analysis, and the Human decides.

```mermaid
flowchart LR
    A[Human asks for a second opinion] --> B[Consultant spawned on the question]
    B --> C[Analysis recorded on the issue]
    C --> D[bro reports, Human decides]
```

### 4.5 Roundtable

The Human opens a table on a topic, 2–5 consultants each take a position, and the Human ratifies the outcome.

```mermaid
flowchart LR
    A[Human types /roundtable] --> B[Consultants take positions]
    B --> C[Each stance recorded as a vote]
    C --> D[Human ratifies]
    D --> E[Table closes atomically]
```

## 5. Reporting TMB bugs

### 5.1 Bug report

Off by default; the Human opts in during first contact. bro drafts a redacted report, flagging an earlier one with the same signature, and files nothing until the Human has read the full draft and said yes.

```mermaid
flowchart LR
    A[bro hits a real TMB bug] --> B[Redacted draft with a signature]
    B --> C[Human reads the full draft]
    C --> D[Human says yes]
    D --> E[Filed to the plugin's repo and audited]
```
