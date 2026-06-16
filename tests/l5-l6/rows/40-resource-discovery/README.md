# 40-resource-discovery

**Scenario:** Onboarded project. The user names a capability the project lacks (PDF table extraction) and asks bro to find third-party Claude Code resources. Bro should classify the gap (`tmb_resource-discovery` judgment) and call `resource_search`, then surface the ranked candidates.

**Determinism:** `setup-l5.sh` writes a candidate fixture and points `resource_search` at it via `TMB_RESOURCE_SEARCH_FIXTURE` — no live web. Ranking is computed in `scripts/resource-search.sh`, asserted at L2/L3. This row asserts the flow ran (the `resource_search` audit row), not ranking quality.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone — NOT in the chain manifest. Discovery carries no cumulative state.

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | A `resource_search` audit row exists |
| `tools-required.json` | `resource_search` called |
| `cost-budget.json` | Soft 50K tokens / 60s |
