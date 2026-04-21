# Goals

Write what you want. Be specific. Link to relevant files, issues, or context.

The Architect will read this, discuss with you via `bro/DISCUSSION.md` until
aligned, then produce a BLUEPRINT for your approval.

## Example

### v1.0 — User authentication

Add email + password authentication to the API.

- Users register with email, password (min 8 chars), display name
- Bcrypt hashing, never store plaintext
- JWT tokens with 1-day expiry
- Rate limit login attempts (5 per 15 minutes per IP)
- Tests: unit for password hashing, integration for full flow

Related:
- Existing DB schema: `db/schema.sql`
- Auth middleware: `src/middleware/auth.ts`

## How to close a goal

The Architect wraps completed goals in `<closed>` tags:

```markdown
<closed reason="Shipped in v1.0.3, PR #42">
### v1.0 — User authentication
...
</closed>
```
