import { describe, expect, it } from "vitest";
import { and, compileKeyedSql, compileSql, eq, identifier, inArray, sql } from "./index";

describe("SQL boundaries", () => {
  it("parameterizes values and quotes generated identifiers", () => {
    const input = `x'); DROP TABLE users; --`;
    expect(
      compileSql(sql`SELECT * FROM ${identifier("user data")} WHERE email = ${input}`),
    ).toEqual({
      text: 'SELECT * FROM "user data" WHERE email = $1',
      values: [input],
    });
  });

  it("compiles predicates without interpolating data", () => {
    const predicate = and(
      eq(sql.identifier("email"), "a@example.com"),
      inArray(sql.identifier("id"), ["one", "two"]),
    );
    expect(compileSql(predicate)).toEqual({
      text: '("email" = $1 AND "id" IN ($2, $3))',
      values: ["a@example.com", "one", "two"],
    });
  });

  it("requires static keyed SQL and reuses repeated named parameters", () => {
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
