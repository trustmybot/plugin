### Changed
- **The grouped review no longer holds the database while it runs git** (GH 2225): `review_batch_record` checks every task's commit against the reviewed head before it starts writing, and refuses a task that changed in between, asking for the call to be repeated.
