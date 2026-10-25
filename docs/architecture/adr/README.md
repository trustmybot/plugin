# docs/architecture/adr/

Architecture decision records. Each ADR captures one decision: the context that forced it, the options weighed, the choice, and its consequences. Read these when you need to know why a structure was chosen over its alternatives.

- **Status** moves Proposed → Accepted → Superseded. A superseded ADR stays in place and names the ADR that replaced it.
- **Naming** is `NNNN-kebab-title.md`, numbered in order. Numbers are never reused, even when an ADR is superseded or withdrawn.

| ADR | Title | Status |
|---|---|---|
| [`0001`](./0001-world-model-structural-layer.md) | World model structural layer — own tree-sitter index plus LSP checks | Accepted |
| [`0002`](./0002-world-model-concept-layer.md) | World model concept layer — ordered, anchored steps and derived chains | Accepted |
