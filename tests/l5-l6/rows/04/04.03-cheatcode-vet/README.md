# 04.03-cheatcode-vet

**Scenario:** Onboarded project. The user names a candidate cheatcode (a PDF-table-extraction skill on GitHub) and asks bro whether it's safe enough to consider installing. Bro calls `cheatcode_vet` on the candidate, which gathers reputation + security-surface signals and emits a deterministic trust tier, then surfaces the tier + rationale + capabilities. The install decision still stays bro + Human (#659) — this row only proves the vet signal-gate ran.

**Determinism:** `setup-l5.sh` writes a `{repo, contents}` signal fixture and points `cheatcode_vet` at it via `TMB_CHEATCODE_VET_FIXTURE` — no live web. The trust-tier classification (registry tier + GitHub signals + security surface) is computed in `scripts/cheatcode-vet.sh`, asserted at L2/L3. This row asserts the flow ran (the `cheatcode_vet` audit row), not classification quality.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone — NOT in the chain manifest. Vetting carries no cumulative state.

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | A `cheatcode_vet` audit row exists |
| `tools-required.json` | `cheatcode_vet` called |
| `cost-budget.json` | Soft 50K tokens / 60s |
