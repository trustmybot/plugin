# docs/adapters/

The normative standard for building TMB platform adapters — the rules a host-specific adapter (Codex, Cursor, Gemini, …) must satisfy so it never bends the core plugin, never destabilizes another host's environment, and keeps TMB's own state compatible across all of them. Read this before writing any host-specific code.

| File | Purpose |
|---|---|
| `ADAPTER_CONTRACT.md` | The binding normative standard for platform-adapter development — core invariance, adapter isolation, host-located state, and the enforcement-parity matrix every adapter declares |
