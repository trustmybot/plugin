### Changed
- **The push gate passes the reviewer's model** (GH 2932): the push-gate skill now tells bro to pass `reviewer_spawn`'s `model` along with its prompt, effort and agent type when spawning code-reviewer, and to omit it when absent. Without a `reviewer_spawn` in hand, bro takes both the model and the effort from the `require-spawn-effort` deny.
