import { expect } from "vite-plus/test";
import { eq, sql, table, text } from "./index";
import { createDatabaseClient } from "./client";
import type { DatabaseAdapter } from "./adapter";

export async function assertCodecConformance(adapter: DatabaseAdapter) {
  const items = table("orm_codec_probe", {
    id: text().primaryKey(),
    amount: text().notNull().mapWith<number>({
      name: "numeric-text",
      encode: String,
      decode: Number,
    }),
  });
  try {
    await adapter.execute({
      text: "CREATE TABLE orm_codec_probe (id text primary key, amount text)",
      values: [],
    });
    const db = createDatabaseClient({ items }, adapter);
    const row = { id: "one", amount: 42 };
    await db.items.insert(row);
    expect(await db.items.get("one")).toEqual(row);
    expect(await db.items.all()).toEqual([row]);
    const projection = db.items.select(({ orm_codec_probe }) => ({
      aliased: orm_codec_probe.amount,
    }));
    expect(await projection.execute()).toEqual([{ aliased: 42 }]);
    expect(await projection.prepare("amount").execute()).toEqual([{ aliased: 42 }]);
    const rows = [];
    for await (const result of projection.stream()) rows.push(result);
    expect(rows).toEqual([{ aliased: 42 }]);
    for (const [match, expected] of [
      ["one", 42],
      ["absent", null],
    ] as const) {
      const joined = db.items
        .leftJoin(db.items, { as: "other" })
        .on(({ other }) => eq(other.id, match))
        .select(({ other }) => ({ amount: other.amount, raw: sql<string>`'42'` }));
      expect(await joined.execute()).toEqual([{ amount: expected, raw: "42" }]);
    }
  } finally {
    await adapter.execute({ text: "DROP TABLE orm_codec_probe", values: [] });
  }
}
