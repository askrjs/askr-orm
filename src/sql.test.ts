import { describe, expect, it } from "vitest";
import { and, compileKeyedSql, compileSql, eq, identifier, inArray, literal, sql } from "./index";
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

  it("should replace only structural named parameters given inert SQL regions", () => {
    const exact = sql.key("notes.search", { email: "" })`
      SELECT id FROM users WHERE note = 'contact via :email for help' AND email = :email
    `;
    expect(compileKeyedSql(exact, { email: "attacker@example.com" })).toEqual({
      text: "\n      SELECT id FROM users WHERE note = 'contact via :email for help' AND email = $1\n    ",
      values: ["attacker@example.com"],
    });

    let seed = 0x5eed;
    for (let sample = 0; sample < 100; sample += 1) {
      seed = (seed * 16_807) % 2_147_483_647;
      const name = `p_${seed.toString(36)}`;
      const inert = `:${name}`;
      const source = [
        `SELECT '${inert}', "quoted ${inert}", $$${inert}$$, $tag$${inert}$tag$`,
        `-- ${inert}`,
        `/* ${inert} */ WHERE id = :${name}`,
      ].join("\n");
      const query = {
        kind: "keyed-sql" as const,
        key: `guardrail.${sample}`,
        source,
        parameters: { [name]: 0 },
      };

      expect(compileKeyedSql(query, { [name]: sample })).toEqual({
        text: source.replace(`WHERE id = :${name}`, "WHERE id = $1"),
        values: [sample],
      });
    }
  });

  it("should reject non-finite numbers given SQL literal formatting", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => compileSql(sql`SELECT ${literal(value)}`)).toThrow(/finite number/i);
    }
  });
});
