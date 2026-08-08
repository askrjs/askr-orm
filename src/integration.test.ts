import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "./adapter";
import { createDatabaseClient, eq, table, text, uuid, type DatabaseClient } from "./index";
import { postgres, timestampTz } from "./postgres";
import { createMigrationsApi, type MigrationManifest } from "./migrations";

const databaseUrl = process.env.ASKR_ORM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const groups = table("orm_groups", {
  id: uuid().primaryKey(),
  name: text().notNull(),
});
const users = table("orm_users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  groupId: uuid()
    .notNull()
    .references(() => groups.id),
  createdAt: timestampTz().notNull().defaultNow(),
});

integration("PostgreSQL adapter conformance", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let adapter: DatabaseAdapter;
  let db: DatabaseClient<{ users: typeof users; groups: typeof groups }>;

  beforeAll(async () => {
    adapter = await postgres({ url: databaseUrl!, shadowUrl: `${databaseUrl!}_shadow` }).open();
    db = createDatabaseClient({ users, groups }, adapter);
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await pool.query('DROP TABLE IF EXISTS "orm_users", "orm_groups" CASCADE');
    await pool.query('CREATE TABLE "orm_groups" ("id" uuid PRIMARY KEY, "name" text NOT NULL)');
    await pool.query(
      'CREATE TABLE "orm_users" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "email" text NOT NULL UNIQUE, "group_id" uuid NOT NULL REFERENCES "orm_groups" ("id"), "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
  });

  afterAll(async () => {
    await pool.query(
      'DROP TABLE IF EXISTS "_askr_migrations", "orm_migration_probe", "orm_users", "orm_groups" CASCADE',
    );
    await pool.end();
    await adapter.close?.();
  });

  it("should cover CRUD, returning, bulk chunking, joins, and preparation", async () => {
    const groupId = randomUUID();
    await db.groups.insert({ id: groupId, name: "Operators" });
    const inserted = await db.users.insert(
      { email: `${randomUUID()}@example.com`, groupId },
      { returning: "row" },
    );
    expect(inserted.groupId).toBe(groupId);
    expect(await db.users.get(inserted.id)).toEqual(inserted);

    const bulk = await db.users.insertMany(
      [
        { email: `${randomUUID()}@example.com`, groupId },
        { email: `${randomUUID()}@example.com`, groupId },
      ],
      { returning: "rows", chunkSize: 2 },
    );
    expect(bulk).toHaveLength(2);

    const query = db.users
      .join(db.groups)
      .on(({ orm_users: userColumns, orm_groups: groupColumns }) =>
        eq(userColumns.groupId, groupColumns.id),
      )
      .select(({ orm_users: userColumns, orm_groups: groupColumns }) => ({
        email: userColumns.email,
        groupName: groupColumns.name,
      }))
      .where(({ orm_users: userColumns }) => eq(userColumns.id, inserted.id));
    expect(await query.prepare(`orm-${randomUUID()}`).execute()).toEqual([
      { email: inserted.email, groupName: "Operators" },
    ]);
  });

  it("should keep atomicity caller-owned", async () => {
    const groupId = randomUUID();
    await db.groups.insert({ id: groupId, name: "Rollback" });
    const email = `${randomUUID()}@example.com`;
    await expect(
      db.transaction(
        async (transaction) => {
          await transaction.users.insert({ email, groupId });
          throw new Error("rollback");
        },
        { isolation: "serializable" },
      ),
    ).rejects.toThrow("rollback");
    expect(
      await db.users.where(({ orm_users: columns }) => eq(columns.email, email)).first(),
    ).toBeNull();
  });

  it("should isolate nested savepoints and cancel cursor streams", async () => {
    const groupId = randomUUID();
    await db.groups.insert({ id: groupId, name: "Savepoints" });
    const rolledBackEmail = `${randomUUID()}@example.com`;
    const committedEmail = `${randomUUID()}@example.com`;
    await db.transaction(async (transaction) => {
      await expect(
        transaction.transaction(async (nested) => {
          await nested.users.insert({ email: rolledBackEmail, groupId });
          throw new Error("nested rollback");
        }),
      ).rejects.toThrow("nested rollback");
      await transaction.users.insert({ email: committedEmail, groupId });
    });
    expect(
      await db.users.where(({ orm_users: columns }) => eq(columns.email, rolledBackEmail)).first(),
    ).toBeNull();
    expect(
      await db.users.where(({ orm_users: columns }) => eq(columns.email, committedEmail)).first(),
    ).not.toBeNull();

    const controller = new AbortController();
    const iterator = db.users.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort(new Error("stop stream"));
    await expect(iterator.next()).rejects.toThrow();
  });

  it("should apply bundled migrations with ledger and advisory-lock checks", async () => {
    await pool.query('DROP TABLE IF EXISTS "_askr_migrations", "orm_migration_probe"');
    const manifest: MigrationManifest = {
      migrations: [
        {
          id: "01ORMPROBE",
          parent: null,
          checksum: "probe-checksum",
          sql: 'CREATE TABLE "orm_migration_probe" ("id" integer PRIMARY KEY)',
          transactional: true,
        },
      ],
    };
    const migrations = createMigrationsApi(adapter, manifest);
    expect((await migrations.plan()).pending).toHaveLength(1);
    expect(await migrations.apply()).toEqual({ applied: ["01ORMPROBE"] });
    expect((await migrations.plan()).pending).toHaveLength(0);
    await expect(
      createMigrationsApi(adapter, {
        migrations: [{ ...manifest.migrations[0]!, checksum: "edited" }],
      }).plan(),
    ).rejects.toThrow(/checksum drift/);
  });
});
