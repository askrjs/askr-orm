# `@askrjs/orm`

SQL-shaped data access for PostgreSQL 16–18 and SQLite on Node 24 or newer.

This package keeps a deliberately narrow surface: it has no identity map, lazy
loading, relation includes, nested writes, startup migration, or rollback
migrations.

## Define one database

```ts
import {
  defineDatabase,
  defineQuery,
  escapeLikePattern,
  like,
  table,
  text,
  uuid,
} from "@askrjs/orm";
import { postgres } from "@askrjs/orm/postgres";
import { generated } from "./generated.js";

const users = table("users", {
  id: uuid().primaryKey(),
  email: text().notNull().unique(),
});

const byEmail = defineQuery<{ email: string }>("users.by-email")`
  SELECT id, email FROM users WHERE email = ${"email"}
`;

export const database = defineDatabase({
  driver: postgres(),
  tables: { users },
  queries: { byEmail },
  generated,
});
```

`postgres()` lazily reads `DATABASE_URL` and `DATABASE_SHADOW_URL`. PostgreSQL
support has optional `pg` and `pg-query-stream` peers, so root and SQLite-only
imports do not load them. Use `sqlite()` from `@askrjs/orm/sqlite`; it reads
`DATABASE_PATH`, accepts an explicit filename, and always uses an isolated
in-memory shadow database.

Definitions validate dialect-specific columns before a connection is opened.
Every database selects exactly one dialect and owns an independent migration
history.

## Runtime

```ts
const db = await database.open();

await db.users.get(userId);
await db.users.insert({ id: userId, email });
await db.users.insert({ id: userId, email }, { returning: "row" });
await db.users.insertMany(rows, { returning: "rows" });
await db.users.update(userId, { email });
await db.users.delete(userId);
await db.users.upsert({ id: userId, email });
await db.users.upsertMany(rows);

const rows = await db.queries.byEmail({ email });

const search = `%${escapeLikePattern(userInput)}%`;
const matches = await db.users.where(({ users }) => like(users.email, search)).execute();
```

Composite primary keys accept only key objects; single-column keys also accept
their scalar value. Writes return status by default. Ordinary promises are the
non-atomic coordination mechanism; use `db.transaction(...)` when operations
must be atomic. Nested transactions use savepoints, and a transaction client
throws after its callback completes. If rollback cleanup itself fails, the
original callback error remains the error surfaced to the caller. Failed
PostgreSQL cleanup discards the pooled connection; failed SQLite rollback
quarantines the adapter and closes its database. If physical close fails, explicit
close retries cleanup. Open a new SQLite adapter before retrying application work.

`escapeLikePattern()` escapes `\\`, `%`, and `_` for literal-text searches.
`like()` and `ilike()` bind the pattern and emit the matching `ESCAPE '\\'`
clause; `ilike()` is PostgreSQL-only.

Read builders are immutable and parameterized, support typed projections and
joins, and expose preparation, streaming, and `toSQL()`. Dynamic identifiers
must use the identifier API; arbitrary SQL requires the explicit unsafe
boundary.

## Tooling and migrations

```text
askr add database postgres
askr add database sqlite
askr database generate
askr database validate
askr database migration plan
askr database migration apply --yes
```

PostgreSQL generated-artifact tooling uses a disposable scratch database and
proves actual separation from the target before reset. It normalizes supported
catalog shapes and describes query results without executing application queries.
See [PostgreSQL tooling](docs/postgres-tooling.md) for reset scope, supported
objects, conservative result types and connection requirements. Native and
installed PostgreSQL 16–18 CI lanes qualify the workflow. Complete coordinated
0.5.0 candidate qualification and maintainer review are still required.

Generation replays checksummed, forward-only SQL against the shadow database
before accepting it. It writes migration SQL plus one committed
`database/generated.ts` artifact containing schema identity, migration
manifest, and registered-query metadata. Opening a database never applies
migrations.

Drops, ambiguous conversions, and destructive constraint changes require an
explicit manual migration; live schema definitions do not retain `.drop()`
markers.

SQLite uses Node's synchronous `node:sqlite` API behind a re-entrant async
connection queue. Transactions and streams hold the connection; cancellation
is checked between streamed rows, but a synchronous statement already running
cannot be interrupted.

## 0.5.0 review

The [API decisions](docs/0.5.0-api.md) record every retained and removed name and
its migration. The [hardening report](docs/0.5.0-hardening.md) distinguishes
regression fixes, executed characterization and the remaining coordinated release gates.
The package version remains 0.4.0 until the coordinated candidate is prepared.
