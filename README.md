# `@askrjs/orm`

SQL-shaped data access for PostgreSQL 16–18 and SQLite on Node 24 or newer.

This package is a clean v1 candidate and remains intentionally unreleased at
version `0.0.0`. It has no identity map, lazy loading, relation includes,
nested writes, startup migration, or rollback migrations.

## Define one database

```ts
import { defineDatabase, defineQuery, table, text, uuid } from "@askrjs/orm";
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
```

Composite primary keys accept only key objects; single-column keys also accept
their scalar value. Writes return status by default. Ordinary promises are the
non-atomic coordination mechanism; use `db.transaction(...)` when operations
must be atomic. Nested transactions use savepoints, and a transaction client
throws after its callback completes.

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
