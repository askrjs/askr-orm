import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseAdapter, ExecutionResult, QueryOptions, TransactionOptions } from "./adapter";
import { createDatabaseClient, eq, table, text, timestampTz, uuid } from "./index";
import { createMigrationsApi, type MigrationManifest } from "./migrations";
import type { SqlQuery } from "./sql";

const databaseUrl = process.env.ASKR_ORM_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

class PgAdapter implements DatabaseAdapter {
  readonly identity = databaseUrl ?? "integration-disabled";

  constructor(
    private readonly pool: Pool,
    private readonly client?: PoolClient,
    private readonly ownsPool = false,
  ) {}

  async execute<Row = Record<string, unknown>>(
    query: SqlQuery,
    options: QueryOptions = {},
  ): Promise<ExecutionResult<Row>> {
    const executor = this.client ?? this.pool;
    const result = (await executor.query({
      text: query.text,
      values: [...query.values],
      ...(options.preparedName === undefined ? {} : { name: options.preparedName }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { query_timeout: options.timeoutMs }),
    } as never)) as unknown as QueryResult;
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = this.client ?? (await this.pool.connect());
    const release = this.client ? undefined : () => client.release();
    try {
      const isolation = options.isolation
        ? ` ISOLATION LEVEL ${options.isolation.toUpperCase()}`
        : "";
      const readOnly = options.readOnly ? " READ ONLY" : "";
      await client.query(`BEGIN${isolation}${readOnly}`);
      const result = await callback(new PgAdapter(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      release?.();
    }
  }

  async session<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.client) return callback(this);
    const client = await this.pool.connect();
    try {
      return await callback(new PgAdapter(this.pool, client));
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

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
  const adapter = new PgAdapter(pool);
  const db = createDatabaseClient({ users, groups }, adapter);

  beforeAll(async () => {
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
  });

  it("covers CRUD, returning, bulk chunking, joins, and preparation", async () => {
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
      { returning: "row", chunkSize: 2 },
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

  it("keeps atomicity caller-owned", async () => {
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

  it("applies bundled migrations with ledger and advisory-lock checks", async () => {
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
