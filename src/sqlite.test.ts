import { assertCodecConformance } from "./codec-conformance.fixture";
import { createDatabaseClient } from "./client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { defineDatabase, defineQuery, escapeLikePattern, like, table, text } from "./index";
import { jsonb } from "./postgres";
import { sqlite } from "./sqlite";
import { createMigrationsApi } from "./migrations";

describe("SQLite dialect", () => {
  it.each(["commit", "rollback", "savepoint", "session"] as const)(
    "queues root writes inherited from a finished %s",
    async (scope) => {
      const directory = await mkdtemp(path.join(tmpdir(), "askr-owner-"));
      const driver = sqlite({ filename: path.join(directory, "database.sqlite") });
      let adapter = await driver.open();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let insert!: Promise<unknown>;
      try {
        const items = table("items", { id: text().primaryKey() });
        const db = createDatabaseClient({ items }, adapter);
        await adapter.execute({ text: "CREATE TABLE items (id text primary key)", values: [] });
        const schedule = async () => {
          insert = barrier.then(() => {
            const write = db.items.insert({ id: "root" });
            markStarted();
            return write;
          });
        };
        if (scope === "commit") await adapter.transaction(schedule);
        if (scope === "session") await adapter.session!(schedule);
        if (scope === "savepoint") await adapter.transaction((tx) => tx.transaction(schedule));
        if (scope === "rollback")
          await expect(
            adapter.transaction(async () => {
              await schedule();
              throw new Error("rollback A");
            }),
          ).rejects.toThrow("rollback A");
        await expect(
          adapter.transaction(async (tx) => {
            await tx.execute({ text: "INSERT INTO items VALUES ('rollback')", values: [] });
            release();
            await started;
            throw new Error("rollback B");
          }),
        ).rejects.toThrow("rollback B");
        await expect(insert).resolves.toMatchObject({ rowsAffected: 1 });
        await adapter.close?.();
        adapter = await driver.open();
        expect((await adapter.execute({ text: "SELECT id FROM items", values: [] })).rows).toEqual([
          { id: "root" },
        ]);
      } finally {
        await adapter.close?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects escaped transaction clients and iterators before their next query", async () => {
    const items = table("items", { id: text().primaryKey() });
    const adapter = await sqlite({ filename: ":memory:" }).open();
    try {
      await adapter.execute({ text: "CREATE TABLE items(id text primary key)", values: [] });
      const db = createDatabaseClient({ items }, adapter);
      await db.items.insertMany([{ id: "a" }, { id: "b" }]);
      const { tx, started, unread } = await db.transaction(async (tx) => {
        const started = tx.items.stream()[Symbol.asyncIterator]();
        expect((await started.next()).done).toBe(false);
        return { tx, started, unread: tx.items.stream()[Symbol.asyncIterator]() };
      });
      await expect(tx.items.insert({ id: "escaped" })).rejects.toThrow(/no longer active/);
      await expect(started.next()).rejects.toThrow(/no longer active/);
      await expect(unread.next()).rejects.toThrow(/no longer active/);
      expect(await db.items.get("escaped")).toBeNull();
    } finally {
      await adapter.close?.();
    }
  });
  it("decodes mapped columns for every select entry point", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    try {
      await assertCodecConformance(adapter);
    } finally {
      await adapter.close?.();
    }
  });

  it("uses the database default when a batch contains completely empty rows", async () => {
    const items = table("items", {
      id: text().primaryKey().default("'declared'"),
      label: text().default("'declared'"),
    });
    const adapter = await sqlite({ filename: ":memory:" }).open();
    try {
      await adapter.execute({
        text: "CREATE TABLE items(id text primary key default 'db-id', label text default 'db-label')",
        values: [],
      });
      const db = createDatabaseClient({ items }, adapter);
      const options = { returning: "rows" as const };
      expect(await db.items.insertMany([{ id: "first", label: "one" }, {}], options)).toEqual([
        { id: "first", label: "one" },
        { id: "db-id", label: "db-label" },
      ]);
      expect(await db.items.upsertMany([{ id: "db-id", label: "changed" }, {}], options)).toEqual([
        { id: "db-id", label: "changed" },
        { id: "db-id", label: "db-label" },
      ]);
    } finally {
      await adapter.close?.();
    }
  });
  it.each([1, 3])("applies SQLite bulk defaults at chunk size %i", async (chunkSize) => {
    const items = table("items", { id: text().primaryKey(), label: text().default("'default'") });
    const adapter = await sqlite({ filename: ":memory:" }).open();
    try {
      await adapter.execute({
        text: "CREATE TABLE items(id text primary key, label text default 'default')",
        values: [],
      });
      const db = createDatabaseClient({ items }, adapter);
      const options = { chunkSize, returning: "rows" as const };
      expect(
        await db.items.insertMany(
          [{ id: "a", label: "first" }, { id: "b" }, { id: "c", label: null }],
          options,
        ),
      ).toEqual([
        { id: "a", label: "first" },
        { id: "b", label: "default" },
        { id: "c", label: null },
      ]);
      expect(
        await db.items.upsertMany([{ id: "a" }, { id: "b", label: null }, { id: "c" }], options),
      ).toEqual([
        { id: "a", label: "default" },
        { id: "b", label: null },
        { id: "c", label: "default" },
      ]);
      if (chunkSize === 3) {
        await expect(
          db.items.insertMany([{ id: "new" }, { id: "a", label: "duplicate" }], options),
        ).rejects.toThrow();
        expect(await db.items.get("new")).toBeNull();
      }
    } finally {
      await adapter.close?.();
    }
  });

  it("should match escaped LIKE wildcards as literal text", async () => {
    const items = table("items", { value: text().primaryKey() });
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const db = createDatabaseClient({ items }, adapter);
    try {
      await adapter.execute({
        text: 'CREATE TABLE "public"."items" ("value" text PRIMARY KEY)',
        values: [],
      });
      await db.items.insertMany([{ value: "save 50%_today" }, { value: "save 500Xtoday" }]);

      await expect(
        db.items
          .where(({ items: columns }) => like(columns.value, `%${escapeLikePattern("50%_today")}%`))
          .execute(),
      ).resolves.toEqual([{ value: "save 50%_today" }]);
    } finally {
      await adapter.close?.();
    }
  });

  it("should preserve the callback error when rollback fails", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const callbackError = new Error("callback failed");
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return originalExec.call(this, sql);
    });

    try {
      await expect(
        adapter.transaction(async () => {
          throw callbackError;
        }),
      ).rejects.toBe(callbackError);
    } finally {
      exec.mockRestore();
      await adapter.close?.();
    }
  });

  it("should execute parameterized CRUD, nested transactions, and streams", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    await adapter.execute({
      text: 'CREATE TABLE "public"."users" ("id" text PRIMARY KEY, "name" text NOT NULL)',
      values: [],
    });
    await adapter.execute({
      text: 'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)',
      values: ["u1", "Ada"],
    });
    await adapter.transaction(async (transaction) => {
      await transaction.execute({
        text: 'UPDATE "public"."users" SET "name" = $1',
        values: ["Grace"],
      });
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute({ text: 'DELETE FROM "public"."users"', values: [] });
          throw new Error("rollback nested");
        }),
      ).rejects.toThrow("rollback nested");
    });
    const rows = [];
    for await (const row of adapter.stream!<{ name: string }>({
      text: 'SELECT "name" FROM "public"."users"',
      values: [],
    })) {
      rows.push(row);
    }
    expect(rows).toEqual([{ name: "Grace" }]);
    await adapter.close?.();
    await adapter.close?.();
  });

  it("should serialize concurrent sibling savepoints", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    await adapter.execute({ text: "CREATE TABLE values_table (value text)", values: [] });

    await expect(
      adapter.transaction(async (transaction) => {
        await Promise.all([
          transaction.transaction(async (nested) => {
            await nested.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["a"] });
            await nested.transaction(async (recursive) => {
              await recursive.execute({
                text: "INSERT INTO values_table VALUES ($1)",
                values: ["nested"],
              });
            });
          }),
          transaction.transaction(async (nested) => {
            await nested.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["b"] });
          }),
        ]);
      }),
    ).resolves.toBeUndefined();

    expect(
      (
        await adapter.execute<{ value: string }>({
          text: "SELECT value FROM values_table ORDER BY value",
          values: [],
        })
      ).rows,
    ).toEqual([{ value: "a" }, { value: "b" }, { value: "nested" }]);
    await adapter.close?.();
  });

  it("should preserve interleaved commit and rollback across four savepoint levels", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    await adapter.execute({ text: "CREATE TABLE values_table (value text)", values: [] });
    await adapter.transaction(async (outer) => {
      await outer.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["outer"] });
      await expect(
        outer.transaction(async (levelTwo) => {
          await levelTwo.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["two"] });
          await levelTwo.transaction(async (levelThree) => {
            await levelThree.execute({
              text: "INSERT INTO values_table VALUES ($1)",
              values: ["three"],
            });
            await expect(
              levelThree.transaction(async (levelFour) => {
                await levelFour.execute({
                  text: "INSERT INTO values_table VALUES ($1)",
                  values: ["rolled-back"],
                });
                throw new Error("rollback level four");
              }),
            ).rejects.toThrow("rollback level four");
          });
          throw new Error("rollback level two");
        }),
      ).rejects.toThrow("rollback level two");
      await outer.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["committed"] });
    });
    expect(
      (
        await adapter.execute<{ value: string }>({
          text: "SELECT value FROM values_table ORDER BY value",
          values: [],
        })
      ).rows,
    ).toEqual([{ value: "committed" }, { value: "outer" }]);
    await adapter.close?.();
  });

  it("should serialize adapters that target the same SQLite file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "askr-orm-sqlite-"));
    const filename = path.join(directory, "shared.sqlite");
    const first = await sqlite({ filename }).open();
    const second = await sqlite({ filename }).open();
    try {
      await first.execute({ text: "CREATE TABLE values_table (value text)", values: [] });
      await expect(
        Promise.all([
          first.transaction(async (transaction) => {
            await transaction.execute({
              text: "INSERT INTO values_table VALUES ($1)",
              values: ["a"],
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
          }),
          second.execute({ text: "INSERT INTO values_table VALUES ($1)", values: ["b"] }),
        ]),
      ).resolves.toBeDefined();
    } finally {
      await first.close?.();
      await second.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("should serialize concurrent bulk writes from adapters sharing a SQLite file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "askr-orm-sqlite-bulk-"));
    const filename = path.join(directory, "shared.sqlite");
    const items = table("items", { id: text().primaryKey(), value: text().notNull() });
    const first = await sqlite({ filename }).open();
    const second = await sqlite({ filename }).open();
    const firstDb = createDatabaseClient({ items }, first);
    const secondDb = createDatabaseClient({ items }, second);
    try {
      await first.execute({
        text: 'CREATE TABLE "public"."items" ("id" text PRIMARY KEY, "value" text NOT NULL)',
        values: [],
      });
      await expect(
        Promise.all([
          firstDb.items.insertMany(
            Array.from({ length: 20 }, (_, id) => ({ id: `first-${id}`, value: `first-${id}` })),
            { chunkSize: 3 },
          ),
          secondDb.items.insertMany(
            Array.from({ length: 20 }, (_, id) => ({ id: `second-${id}`, value: `second-${id}` })),
            { chunkSize: 4 },
          ),
        ]),
      ).resolves.toEqual([{ rowsAffected: 20 }, { rowsAffected: 20 }]);
      await expect(
        Promise.all([
          firstDb.items.upsertMany(
            Array.from({ length: 20 }, (_, id) => ({ id: String(id), value: `first-${id}` })),
            { chunkSize: 3 },
          ),
          secondDb.items.upsertMany(
            Array.from({ length: 20 }, (_, id) => ({ id: String(id), value: `second-${id}` })),
            { chunkSize: 4 },
          ),
        ]),
      ).resolves.toEqual([{ rowsAffected: 20 }, { rowsAffected: 20 }]);
      expect((await secondDb.items.limit(100).execute()).map(({ id }) => id)).toHaveLength(60);
    } finally {
      await first.close?.();
      await second.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("should register explicit keyed SQL and reject PostgreSQL-only columns before open", async () => {
    const users = table("users", { id: text().primaryKey(), name: text().notNull() });
    const byId = defineQuery<{ id: string }>("users.byId")`SELECT * FROM users WHERE id = ${"id"}`;
    const definition = defineDatabase({
      driver: sqlite({ filename: ":memory:" }),
      tables: { users },
      queries: { byId },
    });
    expect(definition.dialect).toBe("sqlite");
    expect(byId.compile({ id: "u1" })).toEqual({
      text: "SELECT * FROM users WHERE id = $1",
      values: ["u1"],
    });
    expect(() =>
      defineDatabase({
        driver: sqlite({ filename: ":memory:" }),
        tables: { events: table("events", { payload: jsonb() }) },
      }),
    ).toThrow(/requires the postgres dialect/);
  });

  it("should apply migrations under the SQLite connection lock", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const migrations = createMigrationsApi(adapter, {
      migrations: [
        {
          id: "01",
          parent: null,
          checksum: "initial",
          sql: 'CREATE TABLE "public"."items" ("id" text PRIMARY KEY)',
          transactional: true,
        },
      ],
    });
    await expect(migrations.apply()).resolves.toEqual({ applied: ["01"] });
    expect((await migrations.plan()).pending).toHaveLength(0);
    await adapter.close?.();
  });

  it("should resolve failed non-transactional migrations on SQLite", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const migrations = createMigrationsApi(adapter, {
      migrations: [
        {
          id: "01FAILED",
          parent: null,
          checksum: "failed",
          sql: "SELECT * FROM missing_resolution_table",
          transactional: false,
        },
      ],
    });
    await expect(migrations.apply()).rejects.toThrow();
    await expect(migrations.plan()).rejects.toThrow(/migration resolve/);
    await expect(migrations.resolve("01FAILED", "rolled-back")).resolves.toBeUndefined();
    expect((await migrations.plan()).pending.map(({ id }) => id)).toEqual(["01FAILED"]);
    await adapter.close?.();
  });
});
