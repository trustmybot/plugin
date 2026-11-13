# Extending the team

Every case of flows 4.2 to 4.5 in [FLOWS.md](FLOWS.md): how a project gains agents, skills and second opinions, and what each path refuses. Acquiring a published capability (flow 4.1) is in [CHEATCODES.md](CHEATCODES.md); what each agent may do once it exists is in [RESPONSIBILITIES.md](RESPONSIBILITIES.md).

## 4.2 Agent creation

```mermaid
flowchart TD
    A[Routing hits a role with no agent] --> B{Name allowed?}
    B -- bro, swe or code-reviewer --> X[Refused]
    B -- has a shipped template --> T{Human confirms the copy?}
    T -- yes --> W
    T -- no --> Q
    B -- new --> Q[Up to three clarifying questions]
    Q --> D[Tailored draft]
    D --> H{Human approves?}
    H -- no --> Z[Nothing written]
    H -- yes --> W[Project agent file written and registered]
    W --> R[Later sessions route to it; the file commits with the project]
```

bro is a reserved name, and swe and code-reviewer are refused because a project copy would shadow the workflow backbone.

## 4.3 Skill creation

```mermaid
flowchart TD
    A[Recurring pattern] --> D[bro drafts the skill]
    D --> H{Human approves?}
    H -- no --> Z[Nothing written]
    H -- yes --> S[Skill lands in the project's skills folder]
    S --> O[A project-local override agent extends its skill list]
```

bro never edits an agent's body; attaching a skill only extends the agent's skill list, through a project-local override.

## 4.4 Consultant invocation

```mermaid
flowchart TD
    A[Human asks for a second opinion] --> C{Role exists?}
    C -- yes --> S
    C -- template --> N[Copy the template and register]
    C -- no --> F[Draft from scratch and register]
    N --> S[Spawn the consultant on the question]
    F --> S
    S --> R[Analysis recorded on the issue, checked when it stops]
    R --> B[bro reports; the Human decides]
```

A prompt matching a consultant's domain gets an advisory routing hint. The consultant never decides and never writes workflow state.

## 4.5 Roundtable

```mermaid
flowchart TD
    A{Human typed /roundtable?} -- no --> X[No table, short of an audited waiver with a reason]
    A -- yes --> S[bro spawns 2–5 consultants on the shared topic]
    S --> P[Each full position lands on the carrier issue]
    P --> V[bro records each stance as a vote]
    V --> W[Last expected vote: table awaits the Human]
    W --> R{Anything to ratify?}
    R -- no --> K[Closes as skipped]
    R -- yes --> H[Human ratifies in one question]
    H --> C[Ratification, outcome and summary land in one transaction]
```

- **The Human ratifies** agreements as a multi-select and each disagreement as a single choice.
- **A missing capture is reported, never blocked.**
