### Fixed
- **A DB upgraded from v1.0.x now passes the `event_type_documented` data contract** (GH 1464): schema 38 re-types audit rows whose `event_type` is outside the closed set to the new `legacy_event`, keeping the old type in `content_json.legacy_event_type`, so the trajectory doctor and SessionStart stop failing on pre-closure rows.
