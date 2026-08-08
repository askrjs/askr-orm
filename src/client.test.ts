import { describe, expect, it } from "vitest";
import type { DatabaseAdapter, ExecutionResult, QueryOptions, TransactionOptions } from "./adapter";
import { createDatabaseClient, eq, table, text, uuid } from "./index";
import type { SqlQuery } from "./sql";

class RecordingAdapter implements DatabaseAdapter {
  readonly queries: SqlQuery[] = [];
  transactions = 0;
  rows: Record<string, unknown>[] = [];

  async execute<Row = Record<string, unknown>>(
    query: SqlQuery,
    _options?: QueryOptions,
  ): Promise<ExecutionResult<Row>> {
    this.queries.push(query);
    return { rows: this.rows as Row[], rowCount: this.rows.length || 1 };
  }

  async transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    _options?: TransactionOptions,
  ): Promise<T> {
    this.transactions += 1;
    return callback(this);
  }
}

const groups = table("groups", {
  id: uuid().primaryKey(),
  name: text().notNull(),
});
const users = table("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull(),
  groupId: uuid().notNull(),
});

describe("database client", () => {
  it("should use status-first CRUD and explicit returning", async () => {
    const adapter = new RecordingAdapter();
    const db = createDatabaseClient({ users, groups }, adapter);
    expect(await db.users.insert({ email: "a@example.com", groupId: "g" })).toEqual({
      rowsAffected: 1,
    });
    expect(adapter.queries[0]).toEqual({
      text: 'INSERT INTO "public"."users" ("email", "group_id") VALUES ($1, $2)',
      values: ["a@example.com", "g"],
    });

    adapter.rows = [{ id: "u", email: "a@example.com", group_id: "g" }];
    await expect(
      db.users.insert({ email: "a@example.com", groupId: "g" }, { returning: "row" }),
    ).resolves.toEqual({ id: "u", email: "a@example.com", groupId: "g" });
  });

  it("should not create implicit transactions for bulk writes", async () => {
    const adapter = new RecordingAdapter();
    const db = createDatabaseClient({ users }, adapter);
    await db.users.insertMany([
      { email: "one@example.com", groupId: "g" },
      { email: "two@example.com", groupId: "g" },
    ]);
    expect(adapter.transactions).toBe(0);

    await db.transaction(async (transaction) =>
      transaction.users.insert({ email: "three@example.com", groupId: "g" }),
    );
    expect(adapter.transactions).toBe(1);
  });

  it("should require explicit join projection and compile null-safe left joins", () => {
    const adapter = new RecordingAdapter();
    const db = createDatabaseClient({ users, groups }, adapter);
    const query = db.users
      .leftJoin(db.groups)
      .on(({ users: userColumns, groups: groupColumns }) =>
        eq(userColumns.groupId, groupColumns.id),
      )
      .select(({ users: userColumns, groups: groupColumns }) => ({
        email: userColumns.email,
        groupName: groupColumns.name,
      }))
      .where(({ users: userColumns }) => eq(userColumns.email, "a@example.com"));
    expect(query.toSQL()).toEqual({
      text: 'SELECT "users"."email" AS "email", "groups"."name" AS "groupName" FROM "public"."users" AS "users" LEFT JOIN "public"."groups" AS "groups" ON "users"."group_id" = "groups"."id" WHERE ("users"."email" = $1)',
      values: ["a@example.com"],
    });
  });

  it("should reject self-joins without aliases", () => {
    const db = createDatabaseClient({ users }, new RecordingAdapter());
    expect(() => db.users.join(db.users)).toThrow(/self-joins require an explicit alias/);
    expect(() => db.users.join(db.users, { as: "otherUsers" })).not.toThrow();
  });
});
