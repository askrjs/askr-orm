import { compileKeyedSql, keyedSql } from "./sql";
import { describe, expect, it } from "vitest";
import { and, columnRef, compileSql, eq, escapeLikePattern, inArray, like, sql } from "./index";
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
      compileSql(sql`SELECT * FROM ${sql.identifier("user data")} WHERE email = ${input}`),
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

  it("should escape literal LIKE wildcards and declare the escape character", () => {
    const search = String.raw`50%_off\today`;
    expect(compileSql(like(columnRef("items", "name"), `%${escapeLikePattern(search)}%`))).toEqual({
      text: `"items"."name" LIKE $1 ESCAPE '\\'`,
      values: [String.raw`%50\%\_off\\today%`],
    });
  });

  it("should require static keyed SQL and reuse repeated named parameters", () => {
    const query = keyedSql("users.by-email", { email: "" })`
      SELECT id FROM users WHERE email = :email OR backup_email = :email
    `;
    expect(compileKeyedSql(query, { email: "a@example.com" })).toEqual({
      text: "\n      SELECT id FROM users WHERE email = $1 OR backup_email = $1\n    ",
      values: ["a@example.com"],
    });
    expect(() => keyedSql("bad key", {})``).toThrow(/Invalid keyed SQL key/);
  });

  it("should replace only structural named parameters given inert SQL regions", () => {
    const exact = keyedSql("notes.search", { email: "" })`
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

  it("should keep placeholder-like text inert across escaped and JSON-shaped values", () => {
    const query = keyedSql("documents.by-id", { id: "", payload: {} })`
      SELECT ':id', E'escaped\\:id', payload FROM documents
      WHERE payload = :payload::jsonb AND id = :id
    `;
    const payload = { note: ":id", nested: [":payload", "::cast"] };

    expect(compileKeyedSql(query, { id: "doc-1", payload })).toEqual({
      text: "\n      SELECT ':id', E'escaped\\:id', payload FROM documents\n      WHERE payload = $1::jsonb AND id = $2\n    ",
      values: [payload, "doc-1"],
    });
  });

  it("should quote embedded identifier delimiters and preserve edge finite literals", () => {
    expect(
      compileSql(sql`SELECT ${sql.identifier('odd"name')} AS ${sql.identifier("select")}`),
    ).toEqual({
      text: 'SELECT "odd""name" AS "select"',
      values: [],
    });
    expect(
      compileSql(sql`SELECT ${sql.literal(-0)}, ${sql.literal(Number.MAX_SAFE_INTEGER)}`),
    ).toEqual({
      text: "SELECT 0, 9007199254740991",
      values: [],
    });
  });

  it("should make an empty condition set visibly invalid instead of matching every row", () => {
    expect(compileSql(and())).toEqual({ text: "()", values: [] });
  });

  it("should reject non-finite numbers given SQL literal formatting", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => compileSql(sql`SELECT ${sql.literal(value)}`)).toThrow(/finite number/i);
    }
  });

  it("should reject integer literals whose precision cannot be represented", () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() => compileSql(sql`SELECT ${sql.literal(value)}`)).toThrow(/safe integer/i);
    }
  });
});
