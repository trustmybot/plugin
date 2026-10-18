### Fixed
- **The Writer/Populated spec contract now triggers on any project's schema files** (GH 1362): the spec-shape gate only matched this repo's `schema.sql`, `db.ts` and `migrations` names; it now also fires for any `.sql` file, a `schema.*` basename and `migrations`, `migration` or `migrate` directories.
