import { describe, expect, it } from "vitest";
import { and, compileKeyedSql, compileSql, eq, identifier, inArray, sql } from "./index";
import { rewritePlaceholders, sqlStructure } from "./placeholders";

describe("SQL boundaries", () => {
  it("should rewrite only structural placeholders", () => {
    const source = `SELECT '$1', '"public".' FROM "public"."items" WHERE id = $1 -- $2\nAND note = $$ $3 $$`;
    expect(rewritePlaceholders(source, [7], { sqlite: true })).toEqual({
      text: `SELECT '$1', '"public".' FROM "items" WHERE id = ? -- $2\nAND note = $$ $3 $$`,
      values: [7],
    });
  });

  it("should mask non-structural SQL for migration classification", () => {
    expect(sqlStructure(`ALTER TABLE users ADD COLUMN "type" text DEFAULT 'DROP'`)).toBe(
      "ALTER TABLE users ADD COLUMN        text DEFAULT       ",
    );
  });
  it("should parameterize values and quote generated identifiers", () => {
    const input = `x'); DROP TABLE users; --`;
    expect(
      compileSql(sql`SELECT * FROM ${identifier("user data")} WHERE email = ${input}`),
    ).toEqual({
      text: 'SELECT * FROM "user data" WHERE email = $1',
      values: [input],
    });
  });

  it("should compile predicates without interpolating data", () => {
    const predicate = and(
      eq(sql.identifier("email"), "a@example.com"),
      inArray(sql.identifier("id"), ["one", "two"]),
    );
    expect(compileSql(predicate)).toEqual({
      text: '("email" = $1 AND "id" IN ($2, $3))',
      values: ["a@example.com", "one", "two"],
    });
  });

  it("should require static keyed SQL and reuse repeated named parameters", () => {
    const query = sql.key("users.by-email", { email: "" })`
      SELECT id FROM users WHERE email = :email OR backup_email = :email
    `;
    expect(compileKeyedSql(query, { email: "a@example.com" })).toEqual({
      text: "\n      SELECT id FROM users WHERE email = $1 OR backup_email = $1\n    ",
      values: ["a@example.com"],
    });
    expect(() => sql.key("bad key", {})``).toThrow(/Invalid keyed SQL key/);
  });
});
