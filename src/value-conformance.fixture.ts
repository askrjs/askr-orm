import assert from "node:assert/strict";
import type { DatabaseAdapter, DialectName } from "./adapter";
import {
  bytes,
  compileSql,
  DatabaseError,
  defineDatabase,
  integer,
  sql,
  table,
  text,
} from "./index";

export async function assertValueConformance(
  adapter: DatabaseAdapter,
  dialect: DialectName,
): Promise<void> {
  const items = table("orm_value_probe", {
    id: integer().primaryKey(),
    note: text(),
    payload: bytes().notNull(),
  });
  const db = await defineDatabase({
    tables: { items },
    driver: {
      dialect,
      open: async () => adapter,
      shadow: async () => {
        throw new Error("No shadow in value probe.");
      },
    },
  }).open();
  const rows = [
    { id: 1, note: null, payload: new Uint8Array() },
    { id: 2, note: "", payload: new Uint8Array([0, 255, 39, 59, 128]) },
    {
      id: 3,
      note: "'quoted'; -- $99 😀".repeat(30_000),
      payload: Uint8Array.from({ length: 65_536 }, (_, i) => i % 256),
    },
  ];
  try {
    await adapter.execute({
      text: `CREATE TABLE "orm_value_probe" ("id" integer PRIMARY KEY, "note" text, "payload" ${dialect === "postgres" ? "bytea" : "blob"} NOT NULL)`,
      values: [],
    });
    await db.items.insertMany(rows, { chunkSize: 2 });
    const actual = await db.items
      .select(({ orm_value_probe }) => orm_value_probe)
      .orderBy(({ orm_value_probe }) => orm_value_probe.id)
      .execute();
    assert.deepEqual(
      actual.map((row) => ({ ...row, payload: new Uint8Array(row.payload) })),
      rows,
    );
    await assert.rejects(
      db.items.insert(rows[0]!),
      (error) =>
        error instanceof DatabaseError && error.category === "constraint" && Boolean(error.cause),
    );
    assert.deepEqual(await db.items.get(2), actual[1]);
    assert.throws(() => compileSql(sql`SELECT ${sql.identifier("bad\0name")}`), /identifier/i);
    assert.equal(
      (await db.items.select(({ orm_value_probe }) => orm_value_probe).execute()).length,
      3,
    );
  } finally {
    await adapter.execute({ text: 'DROP TABLE IF EXISTS "orm_value_probe"', values: [] });
  }
}
