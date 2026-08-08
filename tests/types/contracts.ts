import {
  createDatabaseClient,
  eq,
  table,
  text,
  uuid,
  type DatabaseAdapter,
  type InferInsert,
  type InferKey,
  type InferPatch,
  type InferRow,
} from "@askrjs/orm";

const groups = table("groups", {
  id: uuid().primaryKey(),
  name: text().notNull(),
});
const users = table("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull(),
  groupId: uuid().notNull(),
});

declare const adapter: DatabaseAdapter;
const db = createDatabaseClient({ users, groups }, adapter);

const row: InferRow<typeof users> = {
  id: "id",
  email: "a@example.com",
  groupId: "group",
};
const input: InferInsert<typeof users> = {
  email: "a@example.com",
  groupId: "group",
};
const patch: InferPatch<typeof users> = { email: "b@example.com" };
const key: InferKey<typeof users> = { id: "id" };
void [row, input, patch, key];

const joined = db.users
  .leftJoin(db.groups)
  .on(({ users: userColumns, groups: groupColumns }) => eq(userColumns.groupId, groupColumns.id));

// A joined query intentionally has no execute method until it has an explicit projection.
// @ts-expect-error explicit projection is required after a join
joined.execute();

const selected = joined.select(({ users: userColumns, groups: groupColumns }) => ({
  email: userColumns.email,
  groupName: groupColumns.name,
}));
const result: Promise<readonly Readonly<{ email: string; groupName: string | null }>[]> =
  selected.execute();
void result;

// @ts-expect-error id is generated and email is required
const invalidInsert: InferInsert<typeof users> = { groupId: "group" };
void invalidInsert;

// @ts-expect-error primary keys are not mutable through patch payloads
const invalidPatch: InferPatch<typeof users> = { id: "replacement" };
void invalidPatch;
