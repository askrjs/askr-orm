import { describe, expect, it } from "vitest";
import { sqlite } from "./sqlite";
import { createMigrationsApi, type MigrationManifest } from "./migrations";

describe("SQLite migration scripts and lock recovery", () => {
  it("should roll back every statement and ledger write after a middle statement fails, then recover", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const manifest: MigrationManifest = {
      migrations: [
        {
          id: "01SCRIPT",
          parent: null,
          checksum: "script",
          transactional: true,
          sql: 'CREATE TABLE "items" ("id" integer PRIMARY KEY); INSERT INTO "items" VALUES (1); INSERT INTO "missing_items" VALUES (2);',
        },
      ],
    };
    try {
      await expect(createMigrationsApi(adapter, manifest).apply()).rejects.toThrow(/missing_items/);
      expect(
        (
          await adapter.execute({
            text: "SELECT name FROM sqlite_schema WHERE name = 'items'",
            values: [],
          })
        ).rows,
      ).toEqual([]);
      expect(
        (await adapter.execute({ text: 'SELECT * FROM "_askr_migrations"', values: [] })).rows,
      ).toEqual([]);
      expect((await createMigrationsApi(adapter, manifest).plan()).pending).toHaveLength(1);
      const corrected = {
        migrations: [
          {
            ...manifest.migrations[0]!,
            sql: 'CREATE TABLE "items" ("id" integer PRIMARY KEY); INSERT INTO "items" VALUES (3);',
          },
        ],
      };
      await expect(createMigrationsApi(adapter, corrected).apply()).resolves.toEqual({
        applied: ["01SCRIPT"],
      });
      expect((await adapter.execute({ text: 'SELECT * FROM "items"', values: [] })).rows).toEqual([
        { id: 3 },
      ]);
      expect((await createMigrationsApi(adapter, corrected).plan()).pending).toHaveLength(0);
    } finally {
      await adapter.close?.();
    }
  });

  it("should commit every statement of a successful migration script", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    try {
      await expect(
        createMigrationsApi(adapter, {
          migrations: [
            {
              id: "01SUCCESS",
              parent: null,
              checksum: "success",
              transactional: true,
              sql: 'CREATE TABLE "items" ("value" text); INSERT INTO "items" VALUES (\'semi;colon\'); INSERT INTO "items" VALUES (\'second\');',
            },
          ],
        }).apply(),
      ).resolves.toEqual({ applied: ["01SUCCESS"] });
      expect(
        (await adapter.execute({ text: 'SELECT * FROM "items" ORDER BY rowid', values: [] })).rows,
      ).toEqual([{ value: "semi;colon" }, { value: "second" }]);
    } finally {
      await adapter.close?.();
    }
  });

  it("should release its migration lock and preserve state after cancellation before execution", async () => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const controller = new AbortController();
    const reason = new DOMException("cancel migration", "AbortError");
    const manifest: MigrationManifest = {
      migrations: [
        {
          id: "01CANCEL",
          parent: null,
          checksum: "cancel",
          transactional: true,
          sql: 'CREATE TABLE "items" ("id" integer PRIMARY KEY)',
        },
      ],
    };
    const migrations = createMigrationsApi(adapter, manifest);
    try {
      await expect(
        migrations.apply({
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "started") controller.abort(reason);
          },
        }),
      ).rejects.toMatchObject({ category: "cancellation", cause: reason });
      expect(
        (
          await adapter.execute({
            text: "SELECT name FROM sqlite_schema WHERE name = 'items'",
            values: [],
          })
        ).rows,
      ).toEqual([]);
      expect((await migrations.plan()).pending).toHaveLength(1);
      await expect(migrations.apply()).resolves.toEqual({ applied: ["01CANCEL"] });
    } finally {
      await adapter.close?.();
    }
  });
});
