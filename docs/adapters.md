# Adapter contract

The runtime and tooling adapters are deliberately separate.

`DatabaseAdapter` is the application execution boundary:

- `execute` accepts parameterized `{ text, values }` and optional cancellation,
  timeout, and prepared-statement name.
- `executeScript` is optional and executes the complete parameter-free SQL script
  supplied by a migration. PostgreSQL ignores multi-statement result sets and
  SQLite uses DatabaseSync.exec. Drivers without this method retain the existing
  execute fallback and must supply complete-script semantics themselves. This is
  a migration boundary; ordinary execute still returns one query result.
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

Registered queries return adapter values without decoding or coercion. Generated
SQLite row fields use `number | string | Uint8Array | null`: SQLite column
declarations specify affinity rather than enforce a storage class, so even
`numeric`, `bigint`, and `boolean` columns may contain numbers, text, blobs, or
null. The built-in `node:sqlite` adapter uses number reads for integers; it does
not return JavaScript booleans, bigints, or dates. Integers outside the safe
JavaScript number range raise a driver error. Narrow or validate generated fields
before using a specific value type. Generated PostgreSQL fields follow the
standard `pg` parsers described in [PostgreSQL tooling](postgres-tooling.md).

`DatabaseToolingAdapter` is allowed only in tooling:

- `identity` is a stable, non-secret database identity.
- `reset` destroys and recreates only the isolated scratch schema/database.
- `execute` replays migration SQL.
- `introspect` returns the canonical schema snapshot expected by the private CLI implementation.
- `describe` uses PostgreSQL prepared-statement description and returns
  parameter and result metadata without running application data queries.

Set `targetIdentity` and `scratchIdentity` in `database/index.ts`. Tooling
checks these before reset or target migration work and fails closed on a match.
The built-in PostgreSQL driver additionally proves actual target/scratch
separation before reset and owns a pinned scratch workflow session. See
[PostgreSQL tooling](postgres-tooling.md) for destructive reset scope, supported
catalog shapes, conservative query metadata and connection requirements.

Driver errors may pass through the adapter. The ORM normalizes PostgreSQL
constraint, serialization, deadlock, timeout, cancellation, and connection
codes into `DatabaseError`, retaining the original error as `cause`.
