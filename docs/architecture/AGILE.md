# Agile review mode

Every case of flow 3.9 in [FLOWS.md](FLOWS.md): how agile work builds up on a long-lived feature branch, how its tasks close without a per-task review, how the branch is reviewed once before it merges, and how the review mode is set and changed.

The review mode decides who reviews a task and when. It is separate from the merge policy, which decides who merges.

Planned (GH 2225) unless marked shipped. Today each task already records the project's review mode when it closes, TMB's health check reports agile tasks left unreviewed, and bro can list the unreviewed tasks in groups, but no gate reads the review mode yet. Every project still runs the truest flow of 3.1.

## Why a feature branch

- **Truest**, the default, reviews every task before its push, and each task becomes its own PR into the working branch, such as dev. Nothing reaches the working branch unreviewed.
- **Agile** is for building a feature in many small tasks and judging it as a whole: an MVP the Human wants to try once it works end to end, or an idea that may be dropped. Merging ten tasks into dev one by one, each with its own review and CI run, delays that test and spends ten CI runs on work no one can judge yet.

So agile work builds up on one long-lived feature branch. Each task closes without a code-reviewer pass and merges into the feature branch locally, with no PR and no CI run of its own. The Human can try the feature branch at any time. Once the feature is ready, code-reviewer reviews the whole branch, and only then does it go to the working branch as one PR with one CI run.

Agile is opt-in, and only the Human turns it on.

## Where the review mode is set

```mermaid
flowchart TD
    A[Task closes] --> B{Its lane has its own review mode?}
    B -- yes --> L[Use the lane's review mode]
    B -- no, or no lane --> P[Use the project's review mode]
    L --> R[The task records that mode, fixed from now on]
    P --> R
```

- **Project.** /onboard sets the project-wide review mode. Truest is the default.
- **Lane.** Each lane of a parallel run takes its own review mode when it starts, recorded on the lane's record, and it overrides the project's ([LANES.md](LANES.md)). bro recommends a mode per lane and the Human approves the set. Planned: GH 3025 records it on the lane; GH 2225 adds the lane lookup to the close.
- **TMB keeps it.** The review mode lives in TMB's own records, never in GitHub labels, which a user without triage access cannot apply.

## The feature branch

```mermaid
flowchart TD
    A[Agile work starts: a lane, or an issue or epic the Human names] --> B[bro proposes the feature branch and its scope; Human approves]
    B --> C[bro cuts the feature branch from the working branch]
    C --> D[Each task branch is cut from the feature branch]
    D --> E[Task closes without review and merges into the feature branch locally]
    E --> F[bro pushes the feature branch, with no PR]
    F --> D
    G[Working branch moves] --> H[bro brings it into the feature branch]
    H -- conflict --> I[A fix task resolves it on the feature branch]
    H -- clean --> D
    F --> T[The Human tries the feature branch at any time]
```

- **One feature branch per body of agile work.** An agile lane owns exactly one. Without lanes, bro proposes one for the issue or epic the Human names, and the Human approves its scope and name.
- **Tasks stack on it.** Each task branch is cut from the feature branch's tip and merges back into it once it closes, so the next task builds on the last. This merge is local and opens no PR.
- **Pushed as a backup.** bro pushes the feature branch so the work is on origin and the Human can fetch it. TMB opens no PR for it until its review passes. Whether a push alone runs CI depends on the repo's own CI settings.
- **Kept current.** When the working branch moves, bro brings it into the feature branch, so the final PR has no surprise conflicts. A conflict becomes a fix task on the feature branch.

## Review state

The review mode on a task is history: it is fixed at the close and never changes. What changes afterwards is the task's review state.

```mermaid
flowchart LR
    T[Truest task] --> RV[Reviewed before its push; never queued]
    A[Agile task merged into the feature branch] --> Q[Queued]
    Q -- the branch's review passes for its group --> BR[Batch-reviewed]
    Q -- the Human waives the review --> W[Waived]
```

- **Queued** means merged into the feature branch and waiting for review.
- **Batch-reviewed** means the feature branch's review passed for the task's group. The move is recorded with the review that cleared it.
- **Waived** means the Human let the feature branch merge without that review. The waiver names the branch, and the audit log keeps it.

## Task flow

```mermaid
flowchart TD
    A[Human asks] --> B[bro grounds the ask, writes the spec, provisions the task off the feature branch]
    B --> C[swe implements, tests the paths it touched, closes with its report]
    C --> V{The spec's checks pass on the commit?}
    V -- no --> C
    V -- yes --> E{bro: report covers every criterion, change fits the design?}
    E -- no --> R[bro amends the spec and reopens the task]
    R --> C
    E -- yes --> F[Close without review: the task records agile and the skipped review]
    F --> G[bro merges the task into the feature branch and pushes it]
    G --> Q[Task is queued]
    H[Human asks for a review now] -. optional .-> CR[code-reviewer reviews this task, as in truest]
    CR -. pass .-> X[Task never queues, or leaves the queue]
```

- **swe tests the patch.** It runs the checks for the paths it touched, and the spec's checks run once more on its commit before the completion counts. These local checks replace the per-task CI run.
- **bro tests the design.** It judges whether the report covers every success criterion and whether the change fits the architecture. It reviews no diff line by line.
- **bro merges into the feature branch.** The merge policy covers PRs into the working branch. A task's merge into its feature branch is bro's, because it is local work no one else has seen yet.
- **code-reviewer is on call.** The Human can ask for a review of any task at any time, and a passing review keeps that task out of the queue.

## Safe close

Dropping the per-task review removes one gate and nothing else. A task closes when every remaining gate holds:

```mermaid
flowchart TD
    A[swe completes] --> B{Completion report covers every criterion?}
    B -- no --> X1[Close refused, back to swe]
    B -- yes --> C{The spec's checks passed on this commit?}
    C -- no --> X1
    C -- yes --> D{Changed paths outside the spec reported with reasons bro accepts?}
    D -- no --> X2[bro has them reverted through swe, or records why they stay]
    X2 --> D
    D -- yes --> E{bro: architecture fit?}
    E -- no --> X3[bro records the misfit, amends the spec, reopens the task]
    E -- yes --> F[One step: task closed, its review mode and the skipped review recorded]
    F --> G{Feature branch moved since the task was cut?}
    G -- no --> P[Merge into the feature branch]
    G -- yes --> I[Rebase onto it; checks re-run on the rebased commit]
    I -- pass --> P
    I -- fail --> X1
```

- **What stays on.** swe's completion report, the spec's checks, the git and write guards, and the close as one step.
- **What the close records.** The task's review mode is resolved once, at the close, from its lane and then the project, and stored on the task. Everything later reads that stored mode, never the current setting.
- **Recovery.** A close that fails partway leaves the task as it was. bro fixes the cause and closes again.

## Feature branch review

```mermaid
flowchart TD
    A[Human says the feature is ready] --> B[bro brings the working branch into the feature branch]
    B --> C[Group the queued tasks whose changed files overlap]
    C --> D[One code-reviewer per group, groups in parallel]
    D --> E[Each reviewer reads its group's files in the net diff from the working branch to the feature branch]
    B --> S[The full test suite runs on the feature branch]
    E --> F{Verdict}
    F -- pass --> G[In one step, every task in the group moves from queued to batch-reviewed, recorded with the review]
    F -- fail --> H[bro files the findings as a new fix task on the feature branch]
    H --> I[The fix is reviewed before it merges, as in truest; the group stays queued until it passes]
    I --> G
    G --> M{Every group batch-reviewed, and the suite passes?}
    M -- yes --> P[bro opens one PR from the feature branch into the working branch]
    P --> CI[One CI run]
    CI --> MG[Merged per the merge policy]
```

- **The Human decides when.** The review runs when the Human says the feature is ready, such as when an MVP works end to end, not after each task.
- **Groups form after the fact.** Which files a task will touch is hard to know before it is planned, so tasks are not grouped up front. The groups come from the files each task actually changed, and tasks that share a file are reviewed together, so a reviewer sees their combined effect.
- **Net diff.** The review reads what the feature branch adds to the working branch, not each task's patch. Churn a later task undid is never reviewed, and a conflict resolved on the branch is reviewed as resolved.
- **The suite covers the gaps.** A reviewer reads its group's files and their dependents. The full suite on the feature branch catches what crosses two groups.
- **A pass updates the whole group.** Every task in the group becomes batch-reviewed at once, recorded with the review that cleared it. Each task still records agile as its review mode.
- **Failures.** A fail becomes a fix task on the feature branch, and that task is reviewed before it merges, like any truest task. Once it passes, the group is batch-reviewed.
- **Visibility.** TMB's health check reports agile tasks closed more than a day ago, by default, with neither a passing review nor a waiver, so the queue never hides (shipped).

## Merge gate

The feature branch reaches the working branch only through one gated PR.

```mermaid
flowchart TD
    A[PR from the feature branch into the working branch] --> B{Any of its tasks still queued?}
    B -- no --> OK[Allowed to merge per the merge policy]
    B -- yes --> W{Human recorded a waiver for this branch?}
    W -- yes --> L[Allowed; the covered tasks move to waived, and the waiver goes to the audit log]
    W -- no --> X[Blocked: run the feature branch review first]
```

- **Scope.** Task merges into the feature branch are not gated by the queue. Only the merge into the working branch is.
- **Waivers.** Only the Human records a waiver. It names the feature branch it covers, and the audit log keeps it with the list of tasks that merged unreviewed.
- **Dropped work.** A feature branch the Human abandons never merges, so its queued tasks need no review. bro records them as dropped and deletes the branch only when the Human says so.

## Switching review modes

```mermaid
flowchart TD
    A[Human runs /onboard] --> B[Project review mode changes]
    B --> B1[Later closes in the project, and in lanes without their own mode, use it]
    C[Human changes a lane's review mode] --> C1[Later closes in that lane use it]
    B1 --> K[Closed tasks keep their mode and review state]
    C1 --> K
    K --> Q[Queued tasks stay queued until batch-reviewed or waived]
    E[Task open when a mode changed] --> F[Takes the mode resolved at its close]
```

- **Only the Human switches.** The project's mode changes through /onboard. A lane's mode is set when the lane starts and changes later only through the lane change path in [LANES.md](LANES.md) (planned: GH 3025, with the approval gate in GH 3028). bro or another agent never switches a mode.
- **The close decides.** A task opened under one mode and closed under the other follows the mode resolved at its close.
- **Switching to truest keeps the branch.** Later tasks are reviewed before they merge into the feature branch, and the branch still needs its review, or a waiver, before it merges into the working branch.
- **Switching to agile starts a branch.** bro proposes a feature branch for the work still ahead, as in [The feature branch](#the-feature-branch).

## Shipped and planned

| Piece | State |
|---|---|
| Project review mode setting, truest by default | Shipped, read by no gate yet |
| Review mode recorded on each task at its close | Shipped, project mode only |
| Health-check report of agile tasks closed without a review or waiver | Shipped |
| Queue listing: closed agile tasks not yet reviewed, grouped by the files their specs named | Shipped |
| /onboard question for the project review mode | Planned (GH 2225) |
| Feature branch per body of agile work: tasks cut from it and merged into it locally, with no per-task PR | Planned (GH 2225) |
| Close without a per-task review | Planned (GH 2225) |
| Review states queued, batch-reviewed and waived | Planned (GH 2225) |
| Queue of a feature branch's tasks, grouped by the files each task changed | Planned (GH 2225) |
| Feature branch review on its net diff | Planned (GH 2225) |
| Merge gate on the feature branch PR, and audited waiver | Planned (GH 2225) |
| Lane review mode and lane feature branch, set at the lane's start, and the lane lookup at the close | Planned (GH 3025, GH 2225) |
| Agent prompts for agile review mode | Planned (GH 2225) |
