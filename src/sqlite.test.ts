import { describe, expect, it } from "vitest";
import { defineDatabase, defineQuery, table, text } from "./index";
import { jsonb } from "./postgres";
import { sqlite } from "./sqlite";
import { createMigrationsApi } from "./migrations";

describe("SQLite dialect", () => {
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
