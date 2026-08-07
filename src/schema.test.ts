import { describe, expect, expectTypeOf, it } from "vitest";
import {
  postgresEnum,
  table,
  text,
  timestampTz,
  toSnakeCase,
  uuid,
  type Codec,
  type InferInsert,
  type InferKey,
  type InferPatch,
  type InferRow,
} from "./index";

const lowerCaseEmail: Codec<string, string> = {
  name: "lowercase-email",
  encode: (value) => value.toLowerCase(),
  decode: (value) => value,
  typeScriptType: "string",
};

const groups = table("groups", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
});

const users = table("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique().mapWith(lowerCaseEmail),
  groupId: uuid()
    .notNull()
    .references(() => groups.id),
  displayName: text(),
  createdAt: timestampTz().notNull().defaultNow(),
});

describe("schema definitions", () => {
  it("should map property names and preserves relational metadata without connecting", () => {
    expect(users.groupId.ast.name).toBe("group_id");
    expect(users.createdAt.ast.default).toBe("CURRENT_TIMESTAMP");
    expect(users.groupId.ast.references?.()).toBe(groups.id);
    expect(users.email.ast.codec?.encode("USER@EXAMPLE.COM")).toBe("user@example.com");
  });

  it("should handle acronym and delimiter naming deterministically", () => {
    expect(["groupId", "HTTPServerId", "display-name", "already_snake"].map(toSnakeCase)).toEqual([
      "group_id",
      "http_server_id",
      "display_name",
      "already_snake",
    ]);
  });

  it("should define Postgres enum columns", () => {
    const status = postgresEnum("account_status", ["active", "disabled"]);
    expect(status.column().ast.dataType).toBe("public.account_status");
  });

  it("should infer readonly rows, inserts, patches, and primary keys", () => {
    expectTypeOf<InferRow<typeof users>>().toEqualTypeOf<
      Readonly<{
        id: string;
        email: string;
        groupId: string;
        displayName: string | null;
        createdAt: string;
      }>
    >();
    expectTypeOf<InferInsert<typeof users>>().toMatchTypeOf<{
      email: string;
      groupId: string;
    }>();
    expectTypeOf<InferPatch<typeof users>>().toMatchTypeOf<{
      email?: string;
    }>();
    expectTypeOf<InferKey<typeof users>>().toEqualTypeOf<Readonly<{ id: string }>>();
  });
});
