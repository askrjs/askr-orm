import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseClient,
  defineDatabase,
  defineQuery,
  escapeLikePattern,
  like,
  table,
  text,
} from "./index";
import { jsonb } from "./postgres";
import { sqlite } from "./sqlite";
import { createMigrationsApi } from "./migrations";

describe("SQLite dialect", () => {
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
    const exec = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
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
});
