# Adapter contract

The runtime and tooling adapters are deliberately separate.

`DatabaseAdapter` is the application execution boundary:

- `execute` accepts parameterized `{ text, values }` and optional cancellation,
  timeout, and prepared-statement name.
- `transaction` owns `BEGIN`, isolation/read-only settings, commit, and
  rollback.
- `session` pins a physical database session.
- `migrationLock` holds the dialect lock for the full plan and apply operation:
  PostgreSQL uses an advisory lock and SQLite uses its serialized connection.
- `stream` is optional. Calling `.stream()` fails clearly when the adapter does
  not provide a cursor-backed implementation.
- `close` is optional and idempotent.

An adapter must pass values to the driver separately from SQL text and never
interpolate application data. Placeholder rendering is dialect-owned.

`DatabaseToolingAdapter` is allowed only in tooling:

- `identity` is a stable, non-secret database identity.
- `reset` destroys and recreates only the isolated scratch schema/database.
- `execute` replays migration SQL.
- `introspect` returns the canonical `SchemaSnapshot`.
- `describe` uses PostgreSQL prepared-statement description and returns
  parameter and result metadata without running application data queries.

Set `targetIdentity` and `scratchIdentity` in `database/index.ts`. Tooling
checks these before reset or target migration work and fails closed on a match.

Driver errors may pass through the adapter. The ORM normalizes PostgreSQL
constraint, serialization, deadlock, timeout, cancellation, and connection
codes into `DatabaseError`, retaining the original error as `cause`.
