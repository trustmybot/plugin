-- 07-architecture-regen: tmb_refresh-architecture wraps architecture_regen.
-- architecture_regen writes regen_state rows (codebase_tree, module_graph,
-- changelog, file_registry) and updates file_registry with source files.
-- It writes arch docs to docs/trustmybot/architecture/auto/ on disk,
-- but does NOT register those docs in file_registry itself.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'regen_state-row-present-after-refresh (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM regen_state;

-- architecture_regen updates file_registry with tracked source files,
-- including the file_registry target entry in regen_state.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-populated-by-regen (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry;
