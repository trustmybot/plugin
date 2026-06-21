# 04.02-cheatcode-search

**Scenario:** Onboarded project. The user names a capability the project lacks (PDF table extraction) and asks bro to find Claude Code cheatcodes. Bro should spot the capability gap (`tmb_cheatcode` judgment — grab a cheatcode rather than grind it out), call `cheatcode_search`, then surface the ranked candidates.

**Determinism:** `setup-l5.sh` writes a tiered candidate fixture and points `cheatcode_search` at it via `TMB_CHEATCODE_SEARCH_FIXTURE` — no live web. Ranking (registry tier + relevance) is computed in `scripts/cheatcode-search.sh`, asserted at L2/L3. This row asserts the flow ran (the `cheatcode_search` audit row), not ranking quality.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone — NOT in the chain manifest. Discovery carries no cumulative state.

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | A `cheatcode_search` audit row exists |
| `tools-required.json` | `cheatcode_search` called |
| `cost-budget.json` | Soft 50K tokens / 60s |
