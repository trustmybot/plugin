# First contact

Every case of flow 2.1 in [FLOWS.md](FLOWS.md): how `/onboard` learns a project's shape and policy, round by round.

```mermaid
flowchart TD
    A[First bro turn, project not onboarded] --> S{Trajectory server running?}
    S -- no --> X1[bro dispatches nothing and follows its recovery procedure]
    S -- yes --> B[Re-probe: origin, forge CLI, offline scan of every repo]
    B --> R0{Nested session or stray DB?}
    R0 -- yes --> C0[Round 0: pick the project, remove empty stray DBs]
    R0 -- no --> C1
    C0 -- use the workspace --> C1[Round 1: Local-only or Remote-tracked]
    C0 -- make this directory its own project --> Z1[Marker and fresh DB written here; the Human restarts and onboards there]
    C0 -- cancel --> Z2[Nothing written]
    C1 --> RT{Remote-tracked or re-onboard?}
    RT -- yes --> C2[Round 2: branching, PR target, remotes]
    C2 --> RS{Remote-tracked?}
    RS -- yes --> C3[Round 3: issue sync]
    RS -- no --> C4
    RT -- no --> C4
    C3 --> C4[Round 4: Bash sandbox]
    C4 --> C5[Round 5: opt-in TMB bug reports]
    C5 --> C5b[Round 5b: project review mode]
    C5b --> C5c[Round 5c: pre-push hook on or off]
    C5c --> C6[Round 6, per repo: verification defaults]
    C6 --> C7[Round 7, per repo: no-code path classes]
    C7 --> D[Workspace answers and onboarded marker land in one transaction]
    C6 -. writes a file .-> F[Repo working tree: the Human commits it to the PR target]
    C7 -. writes a file .-> F
```

The first bro turn on a project that isn't onboarded runs `/onboard` before any reply; the Human can re-run it any time.

| Round | Runs when | Asks | Leaves |
|---|---|---|---|
| 0 | The session is nested, or a stray trajectory DB exists | Which project to use (offered only when the session is nested); whether to remove empty stray DBs | the standalone choice, the stray DBs removed |
| 1 | Always | Project shape: Local-only or Remote-tracked | no value of its own: Remote-tracked keeps each repo's remotes and the sync choice, Local-only removes the recorded remotes and turns issue sync off |
| 2 | Remote shape, a re-onboard, or a workspace whose repos differ | Branching model and PR target (once, or per repo when they differ); then remotes | each repo's branching, PR target and remotes |
| 3 | Remote shape | Issue sync | the issue-sync setting |
| 4 | Always | Bash sandbox | the sandbox setting |
| 5 | Always | Opt-in TMB bug reports (flow 5.1) | the consent, no by default |
| 5b | Always | The project review mode: truest, or agile on a long-lived feature branch ([AGILE.md](AGILE.md)); a stored mode is offered as Keep. Planned (GH 3281): bro recommends the project's mode, and the round then asks one mode per repo, truest, agile, exempt or the project's, each with bro's recommendation | the review mode, truest by default and untouched when the round is skipped; planned, agile by default, and each repo's mode |
| 5c | Always | Whether TMB's pre-push hook is on or off for the project ([INSTALL.md](INSTALL.md#session-start)); a stored setting is offered as Keep. Only the Human sets it, here; no agent tool can change it | the pre-push setting, on by default and untouched when the round is skipped |
| 6 | Per repo, when its PR target has no verification defaults and its environment profile names a lint, typecheck or test command | Which of the [environment profile](ENVIRONMENT.md)'s lint, typecheck and test commands every task runs | a verification-defaults file in the repo's working tree |
| 7 | Per repo, when docs or prompts paths are detected on its PR target | Whether to class the detected paths as docs and prompts, keep everything code, or keep the current classes; every other path stays code | a path-classes file in the repo's working tree when the Human takes the detected classes |

- **Fresh evidence each round.** Each question shows the evidence behind its recommended option, listed first.
- **Re-runs keep what stands.** A re-run pre-selects the current values, and changes a setting only when the Human picks a new one: a kept or unasked setting keeps its stored value. Identity is the onboarded marker alone. Since no shape is stored, switching from Local-only back to Remote-tracked detects the remotes again.
- **A Local-only first run asks no branching question.** Each repo gets GitHub Flow, with its default branch as the PR target.
- **Round 0 ends the run two ways.** Making the directory its own project writes the marker and a fresh DB there and stops, and the Human restarts and onboards in it. Cancel writes nothing. A stray DB is removed only if it is still empty when the answers land; a refusal is reported and the DB stays.
- **The marker lands last.** Round 2's branching and PR target are written per repo as each is answered. The workspace answers (remotes, issue sync, sandbox, bug reports, review mode, pre-push hook) land together with the marker. An interrupted run leaves the project not onboarded and keeps any repo policy already answered, which the re-run offers as the current value. The sandbox settings and the stray-DB removal are applied after that transaction; a failure there is reported and does not undo the marker.
- **Rounds 6 and 7 can skip a repo.** Each is skipped, with the reason shown, when the repo's PR target branch does not exist yet or its existing file is invalid. bro records the repo's environment profile before Round 6 when none exists. A skipped round is offered again on the next run.
- **Failures.** A failed step is reported word for word, retried once, and then the run stops. Picking Local-only on a project with a forge remote is questioned once, then accepted. Picking Remote-tracked when no repo has a remote onboards with a warning that nothing will sync.
- **The review-mode round recommends, the Human decides.** Planned (GH 3281). bro recommends a mode for the project and one per repo from what each shows, with the reason beside it ([GIT.md](GIT.md#multi-repo-workspaces)). The Human accepts the set in one answer or edits it. Agile is the fallback: it is what bro recommends when nothing is clear, and what applies when the round is skipped and no mode is stored. A re-run offers each stored mode as Keep and never changes one on its own.
- **Repos come from the scan.** First contact reads the repos the first scan found (flow 2.2). When no repo is known yet, bro runs the scan first.
- **Repo files stay the Human's to commit.** Rounds 6 and 7 apply on their own, outside that transaction. Each writes its file to the repo's working tree, never commits it, and never overwrites a different existing file. The file takes effect once the Human commits it to the PR target, because tasks read it from there.
