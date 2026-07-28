# Migration safety

Migration files are forward-only SQL in `database/migrations/`. Their required
headers are:

```sql
-- askr:id 01J...
-- askr:parent 01H...
-- askr:transactional true
-- askr:risk safe
```

The first migration uses parent `none`. Files sort by ULID and form one linear
chain. The generated manifest embeds the complete SQL, id, parent,
transactional flag, risk marker, and SHA-256 checksum.

The target ledger is `_askr_migrations`. Planning rejects:

- edited checksums;
- missing or extra files;
- reordered or forked parents;
- failed or interrupted entries;
- a target/scratch identity collision.

`migration apply` prints the exact pending ids and risk markers, then requires
an interactive answer or `--yes`. It pins a session, obtains the package
advisory lock, and rechecks history. Each normal migration and its successful
ledger write run in one transaction.

A file marked `transactional false` is recorded as `applying` before execution.
On an observed error it becomes `failed`; an interruption leaves it
`applying`. Both states block all subsequent plans and applies. After inspecting
the real database, resolve it explicitly:

```text
askr database migration resolve 01J... --database app --applied
askr database migration resolve 01J... --database app --rolled-back
```

Generated diffs fail closed for table/column drops, renames, required-column
additions, enum value removal/reordering, type conversions, and constraint
changes unless the definition carries supported explicit intent. Use
`migration create` for data movement or unsupported PostgreSQL objects.

Opening a database never applies migrations. Programmatic `plan()` and
`apply()` use the same manifest, ledger checks, session lock, and transaction
rules as the CLI, but never prompt.
