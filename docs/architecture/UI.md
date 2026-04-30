# UI primitives — what bro can render

Reference for the interactive UI tools Claude Code exposes. Both bro (when deciding how to ask the Human) and the Human (so the rendered widget matches mental expectations) use these names.

## Callable primitives

| Primitive | UI rendered | Bro can call directly? | Headless behavior |
|---|---|---|---|
| `AskUserQuestion` | Multi-choice picker (TUI form) | Yes — anywhere | Errors out → `tmb_headless-fallback` applies |
| `ExitPlanMode` | Plan-approval modal (accept / reject) | Only inside Plan Mode | Renders as text + binary prompt |
| `EnterPlanMode` | None — toggles state only | Yes | State toggle only |
| Permission prompts | Inline approve/deny when a tool needs auth | No — auto-rendered | Auto-approves if `defaultMode: "auto"` |
| Notification hooks | OS desktop notification | No — fires from `Notification` hook events | Hook fires; OS handles |

In normal flow (research, planning, code-touching chain, push gate, consultant invocation), `AskUserQuestion` is the only directly-renderable widget.

## AskUserQuestion modes

Four named layouts. Use the names in chat.

### radio

Single-select. Label + description shown as two-line options.

- Default for any 2–5 discrete-option decision
- Cleanest at half-width terminals
- No preview pane → description does the work

### radio + preview

Single-select with side-by-side layout: option labels on left, preview pane on right.

- **Description disappears** in this mode — preview is the differentiator
- Only when visual comparison genuinely needs ASCII / code side-by-side
- Don't mix with non-preview options in the same question — incoherent UX
- Previews must fit ~30–40 columns at half-width

### checkbox

Multi-select. Label + description shown for each option.

- Phrase the question for plural answers ("Which features…?", not "Which one…?")
- No preview support — `multiSelect: true` disables it
- Use when choices are not mutually exclusive

### tabbed

2–4 questions packed into one call, rendered as tabs.

- Each tab independently configures `multiSelect`, `options`, `header`
- Mix radio + radio+preview + checkbox tabs freely
- Use when 2–4 *related* decisions need answering together
- Don't pad with filler tabs

## Constraints (apply to every mode)

- Header: ≤12 chars (the tab/chip label)
- Question text: one sentence, ends with `?`
- Label: ≤5 words per option
- Description: ≤15 words per option (only renders in radio / checkbox modes)
- Options per question: 2–4
- Questions per call: 1–4 (>1 = tabbed)
- "Other" is auto-rendered for free-text — never add it manually

## When NOT to use AskUserQuestion

- Open-ended ("what's on your mind?", design feedback, freeform spec) → plain prose
- Narrative explanation, tradeoffs, status updates → markdown
- Long-form comparisons that don't fit ~5 word labels → write the tradeoff as prose, then ask a smaller targeted question
