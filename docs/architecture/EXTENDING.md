# Extending the team

Every case of flows 4.2 to 4.5 in [FLOWS.md](FLOWS.md): how a project gains agents, skills and second opinions, and what each path refuses. Acquiring a published capability (flow 4.1) is in [CHEATCODES.md](CHEATCODES.md); what each agent may do once it exists is in [RESPONSIBILITIES.md](RESPONSIBILITIES.md).

## 4.2 Agent creation

```mermaid
flowchart TD
    A[Routing hits a role with no agent] --> B{Name allowed?}
    B -- bro, swe or code-reviewer --> X[Refused]
    B -- a project agent file of that name exists --> T{TMB wrote it?}
    T -- yes --> U[Show the diff; the Human says yes or no]
    T -- no --> V[The Human picks skip, adopt or overwrite; skip is the default]
    U -- yes --> W
    V -- adopt or overwrite --> W
    U -- no --> Z
    V -- skip --> Z
    B -- new --> Q[Up to three clarifying questions]
    Q --> D[Tailored draft]
    D --> H{Human approves?}
    H -- revise --> D
    H -- no --> Z[Draft discarded; nothing lands in the project's agents folder]
    H -- yes --> W[Project agent file written and registered]
    W --> R[Later sessions route to it; the file stays local to this checkout]
```

bro is a reserved name, and swe and code-reviewer are refused because a project copy would shadow the workflow backbone.

- **Every draft starts from one generic scaffold.** There is no per-role template; the clarifying questions tailor the draft.
- **An approval covers one file and lapses.** A draft approved but not written within a short window needs a new approval.
- **The file is not committed by default.** It lands in the project's Claude folder, which TMB keeps out of commits; the Human un-ignores it to share the agent with the team.
- **A backbone copy comes only from an attachment.** Attaching a skill or a cheatcode to swe or code-reviewer creates a project-local copy that differs from the shipped agent only in its skill and tool lists. Refreshing that copy's body after a plugin upgrade is planned (GH 3260); until then the copy keeps the body it was made from.

## 4.3 Skill creation

```mermaid
flowchart TD
    A[Recurring pattern] --> D[bro drafts the skill]
    D -- the name is already registered --> Q2[The Human picks another name, or edits the existing skill]
    Q2 --> D
    D --> H{Human approves?}
    H -- revise --> D
    H -- no --> Z[Draft discarded; nothing lands in the project's skills folder]
    H -- yes --> S[Skill lands in the project's skills folder]
    S --> O[A project-local override agent extends its skill list]
```

bro never edits an agent's body; attaching a skill only extends the agent's skill list, through a project-local override.

## 4.4 Consultant invocation

```mermaid
flowchart TD
    A[Human asks for a second opinion] --> C{Role exists?}
    C -- yes --> S[Spawn the consultant on the question]
    C -- no --> F[Flow 4.2: draft, the Human approves, write and register]
    F -- approved --> S
    F -- rejected --> Z[No consultant; bro answers the question itself and says so]
    S --> R[Analysis recorded on the issue, checked when it stops]
    R --> B[bro reports; the Human decides]
```

When a prompt matches a consultant's domain, a hint suggests routing it to that consultant; the hint is only advice. The consultant never decides and never writes workflow state.

## 4.5 Roundtable

Planned (GH 3360): the roundtable is cut; consultants stay.

```mermaid
flowchart TD
    A{Human typed /roundtable?} -- no --> X[No table, short of an audited waiver with a reason]
    A -- yes --> N{At least two consultants fit the topic?}
    N -- no --> X2[No table; bro says which roles are missing]
    N -- yes --> S[bro spawns 2–5 consultants on the shared topic]
    S --> P[Each full position lands on the carrier issue]
    S -- a consultant fails or returns nothing --> Y[bro spawns it again once; if it fails again the table closes as skipped, with the reason]
    P --> V[bro records each stance as a vote]
    V --> W[Last expected vote: table awaits the Human]
    W --> R{Anything to ratify?}
    R -- no --> K[Closes as skipped]
    R -- yes --> H[Human ratifies in one question]
    H --> C[Ratification, outcome and summary land in one transaction]
    C --> F2[The Human picks which ratified agreements become issues]
```

- **The Human ratifies** agreements as a multi-select and each disagreement as a single choice.
- **A table never waits forever.** It awaits the Human only once every expected vote has landed, so a consultant that never answers is spawned again once and then ends the table as skipped.
- **A missing capture is reported, never blocked.** After the close, bro is told which records the table lacks and reports them to the Human; the close itself goes through.
