-- Step 04 tests the registry-cold gate response. Step 01's seed_after adds
-- a `deep_scan_completed` audit row (so step 02+ have an onboarded project).
-- Without this seed_before, step 04's gate would not fire — bro would skip
-- scan_run, repos stays at 0, the assertion fails.
--
-- This SQL mirrors what step 04's setup-l5.sh does in L5 isolation:
-- "Drop the fixture-seeded deep_scan_completed audit row so the gate fires."

DELETE FROM audit WHERE event_type = 'deep_scan_completed';
