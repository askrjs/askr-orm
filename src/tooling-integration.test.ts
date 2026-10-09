import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { postgres } from "./postgres";
import { runDatabaseCli, type SchemaSnapshot } from "./tooling-impl";

const targetUrl = process.env.ASKR_ORM_TEST_DATABASE_URL;
const shadowUrl = process.env.ASKR_ORM_TEST_SHADOW_URL;
const postgresTests = targetUrl && shadowUrl ? describe : describe.skip;

postgresTests("real PostgreSQL tooling", () => {
  it("refuses to reset the actual target through a different URL spelling", async () => {
    const pool = new Pool({ connectionString: targetUrl });
    const alias = new URL(targetUrl!);
    alias.searchParams.set("application_name", "askr-alias-guard");
    const scratch = await postgres({ url: targetUrl!, shadowUrl: alias.href }).shadow();
    try {
      await pool.query("CREATE TABLE askr_tooling_target_guard (value text)");
      await pool.query("INSERT INTO askr_tooling_target_guard VALUES ('preserve me')");
      await expect(scratch.reset()).rejects.toThrow(/target|distinct|separate/i);
      expect((await pool.query("SELECT value FROM askr_tooling_target_guard")).rows).toEqual([
        { value: "preserve me" },
      ]);
    } finally {
      await scratch.close?.();
      await pool.query("DROP TABLE IF EXISTS askr_tooling_target_guard");
      await pool.end();
    }
  });

  it("resets only scratch and returns a physical, deterministic schema snapshot", async () => {
    const scratch = await postgres({ url: targetUrl!, shadowUrl: shadowUrl! }).shadow();
    try {
      await scratch.reset();
      expect(await scratch.introspect()).toEqual({ version: 1, enums: [], tables: [], views: [] });
      await scratch.execute(`
        CREATE SCHEMA "catalog #%";
        CREATE TYPE "catalog #%".status AS ENUM ('new', 'it''s ready');
        CREATE TABLE "catalog #%".users (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          email varchar(100) NOT NULL UNIQUE,
          status "catalog #%".status,
          slug text GENERATED ALWAYS AS (lower(email)) STORED,
          CONSTRAINT positive_length CHECK (length(email) > 0)
        );
        CREATE INDEX lower_email ON "catalog #%".users (lower(email)) WHERE status IS NOT NULL;
        CREATE VIEW "catalog #%".emails AS SELECT email FROM "catalog #%".users;
      `);
      const snapshot = (await scratch.introspect()) as SchemaSnapshot;
      expect(snapshot.version).toBe(1);
      expect(snapshot.enums).toEqual([
        { schema: "catalog #%", name: "status", values: ["new", "it's ready"] },
      ]);
      expect(snapshot.tables).toHaveLength(1);
      expect(snapshot.tables[0]).toMatchObject({ schema: "catalog #%", name: "users" });
      expect(snapshot.tables[0]!.columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "email",
            dataType: "character varying(100)",
            nullable: false,
          }),
          expect.objectContaining({ name: "id", primaryKey: true, default: "gen_random_uuid()" }),
          expect.objectContaining({ name: "slug", generated: expect.any(String) }),
        ]),
      );
      expect(snapshot.tables[0]!.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "check", name: "positive_length" }),
          expect.objectContaining({
            kind: "index",
            name: "lower_email",
            where: expect.any(String),
          }),
          expect.objectContaining({ kind: "unique", columns: ["email"] }),
        ]),
      );
      expect(snapshot.views).toEqual([
        expect.objectContaining({ name: "emails", query: expect.stringContaining("email") }),
      ]);
      expect(await scratch.introspect()).toEqual(snapshot);
      await scratch.reset();
      expect(await scratch.introspect()).toEqual({ version: 1, enums: [], tables: [], views: [] });
    } finally {
      await scratch.close?.();
    }
  });

  it("describes output and parameters without executing reads or writes, and recovers errors", async () => {
    const scratch = await postgres({
      url: targetUrl!,
      shadowUrl: shadowUrl!,
      pool: { max: 1 },
    }).shadow();
    try {
      await scratch.reset();
      await scratch.execute(
        "CREATE TABLE users (id integer PRIMARY KEY, label text); CREATE SEQUENCE description_side_effect",
      );
      const result = await scratch.describe("SELECT id, label, $1::text AS input FROM users", [
        "input",
      ]);
      expect(result).toEqual({
        parameters: ["input"],
        columns: [
          { name: "id", dataType: "integer", nullable: true },
          { name: "label", dataType: "text", nullable: true },
          { name: "input", dataType: "text", nullable: true },
        ],
      });
      expect(
        await scratch.describe("SELECT nextval('description_side_effect') AS value", []),
      ).toMatchObject({ columns: [{ name: "value", dataType: "bigint" }] });
      expect(
        await scratch.describe("INSERT INTO users VALUES ($1::integer, 'ignored') RETURNING id", [
          "id",
        ]),
      ).toMatchObject({ columns: [{ name: "id", dataType: "integer" }] });
      await expect(scratch.describe("SELECT absent FROM users", [])).rejects.toThrow();
      await expect(
        scratch.describe("SELECT 1; INSERT INTO users VALUES (1, 'batch must never execute')", []),
      ).rejects.toThrow(/multiple commands/);
      expect(await scratch.describe("SELECT id FROM users", [])).toMatchObject({
        columns: [{ name: "id" }],
      });
      const observer = new Pool({ connectionString: shadowUrl });
      try {
        expect((await observer.query("SELECT count(*)::integer AS count FROM users")).rows).toEqual(
          [{ count: 0 }],
        );
        expect(
          (await observer.query("SELECT is_called FROM description_side_effect")).rows,
        ).toEqual([{ is_called: false }]);
      } finally {
        await observer.end();
      }
    } finally {
      await scratch.close?.();
    }
  });

  it("generates, validates, no-op regenerates and rejects stale artifacts against real PostgreSQL", async () => {
    const root = await fs.mkdtemp(
      path.join(path.resolve(import.meta.dirname, ".."), ".orm-pg-fixture- #% "),
    );
    const directory = path.join(root, "database");
    const messages: string[] = [];
    const io = {
      log: (v: unknown = "") => messages.push(String(v)),
      error: (v: unknown = "") => messages.push(`ERROR ${v}`),
    };
    const run = (command: string) => runDatabaseCli([command], { cwd: root, io });
    try {
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "index.ts"),
        `
import { defineDatabase, defineQuery, table, text, uuid, integer } from "../../src/index.ts";
import { postgres } from "../../src/postgres.ts";
const users = table("users", { id: uuid().primaryKey().defaultRandom(), emailAddress: text().name("email").notNull().unique() });
const events = table("events", { id: integer().primaryKey(), userId: uuid().name("user_id").references(() => users.id), payload: text() });
const byEmail = defineQuery<{ email: string }>("users.by-email")\`SELECT id, email FROM users WHERE email = \${"email"}\`;
export default defineDatabase({ driver: postgres({ url: ${JSON.stringify(targetUrl)}, shadowUrl: ${JSON.stringify(shadowUrl)}, pool: { max: 1 } }), tables: { users, events }, queries: { byEmail } });
`,
      );
      expect(await run("generate"), messages.join("\n")).toBe(0);
      const files = await fs.readdir(path.join(directory, "migrations"));
      expect(files).toHaveLength(1);
      const artifactPath = path.join(directory, "generated.ts");
      const generated = await fs.readFile(artifactPath, "utf8");
      expect(generated).toContain('readonly "id": string | null;');
      expect(generated).toContain('readonly "email": string | null;');
      expect(await run("validate"), messages.join("\n")).toBe(0);
      const migrationPath = path.join(directory, "migrations", files[0]!);
      const migration = await fs.readFile(migrationPath, "utf8");
      await fs.writeFile(migrationPath, `${migration}\nALTER TABLE users ADD COLUMN drift text;\n`);
      expect(await run("validate")).toBe(1);
      expect(messages.at(-1)).toMatch(/history does not produce/);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(generated);
      await fs.writeFile(migrationPath, `${migration}\nSELECT 1 / 0;\n`);
      expect(await run("generate")).toBe(1);
      expect(messages.at(-1)).toMatch(/division by zero/);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(generated);
      expect(await fs.readdir(path.join(directory, "migrations"))).toEqual(files);
      await fs.writeFile(migrationPath, migration);
      expect(await run("validate"), messages.join("\n")).toBe(0);
      expect(await run("generate"), messages.join("\n")).toBe(0);
      expect(messages.at(-1)).toBe("default: unchanged");
      expect(await fs.readdir(path.join(directory, "migrations"))).toEqual(files);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(generated);
      await fs.writeFile(artifactPath, `${generated}// stale\n`);
      expect(await run("validate")).toBe(1);
      expect(messages.at(-1)).toMatch(/stale/);
      await fs.writeFile(artifactPath, generated);
      expect(await run("validate"), messages.join("\n")).toBe(0);
      const entryPath = path.join(directory, "index.ts");
      const originalEntry = await fs.readFile(entryPath, "utf8");
      const expanded = originalEntry
        .replace(
          "export default defineDatabase",
          `
const zTags = table("z_tags", { id: integer().primaryKey(), label: text() });
const aPosts = table("a_posts", { id: integer().primaryKey(), tagId: integer().references(() => zTags.id) });
export default defineDatabase`,
        )
        .replace("tables: { users, events }", "tables: { users, events, aPosts, zTags }");
      await fs.writeFile(entryPath, expanded);
      expect(await run("generate"), messages.join("\n")).toBe(0);
      expect(await run("validate"), messages.join("\n")).toBe(0);
      expect(await run("generate"), messages.join("\n")).toBe(0);
      expect(messages.at(-1)).toBe("default: unchanged");
      expect(await fs.readdir(path.join(directory, "migrations"))).toHaveLength(2);
      const renamed = expanded
        .replace('.name("email")', '.name("contact_email").renamedFrom("email")')
        .replace(
          "SELECT id, email FROM users WHERE email",
          "SELECT id, contact_email FROM users WHERE contact_email",
        );
      await fs.writeFile(entryPath, renamed);
      expect(await run("generate"), messages.join("\n")).toBe(0);
      expect(await run("validate"), messages.join("\n")).toBe(0);
      expect(await run("generate"), messages.join("\n")).toBe(0);
      expect(messages.at(-1)).toBe("default: unchanged");
      expect(await fs.readdir(path.join(directory, "migrations"))).toHaveLength(3);
      const renamedArtifact = await fs.readFile(artifactPath, "utf8");
      await fs.writeFile(entryPath, renamed.replace("SELECT id, contact_email", "SELECT id, id"));
      expect(await run("generate")).toBe(1);
      expect(messages.at(-1)).toMatch(/duplicate output column/i);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(renamedArtifact);
      await fs.writeFile(entryPath, renamed);
      expect(await run("validate"), messages.join("\n")).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("qualifies composite keys, quoted enums, native expressions and query value types", async () => {
    const root = await fs.mkdtemp(
      path.join(path.resolve(import.meta.dirname, ".."), ".orm-pg-complex-"),
    );
    const directory = path.join(root, "database");
    const messages: string[] = [];
    const io = {
      log: (v: unknown = "") => messages.push(String(v)),
      error: (v: unknown = "") => messages.push(`ERROR ${v}`),
    };
    try {
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "index.ts"),
        `
import { defineDatabase, defineQuery, table, text, integer, numeric, bytes, index, check, view } from "../../src/index.ts";
import { postgres, postgresEnum, postgresType } from "../../src/postgres.ts";
const status = postgresEnum('status " key', ['new', "it's ready"], { schema: "catalog #%" });
const entries = table("entries", {
  tenantId: integer().primaryKey(), id: integer().primaryKey(),
  state: status.column(), email: postgresType<string>("varchar(80)").notNull(),
  lowerEmail: text().generatedAlwaysAs("lower(email)"), amount: numeric(10, 2).default("0.00"), data: bytes(),
}, { schema: "catalog #%", constraints: [check("length(email) > 0", "email_nonempty"), index(["lower(email)"], { name: "lower_email", where: "state IS NOT NULL" })] });
const emails = view("emails", 'SELECT email FROM "catalog #%".entries', { schema: "catalog #%" });
const values = defineQuery<Record<never, never>>("values")\`SELECT 9007199254740993::bigint AS count, DATE '2026-10-09' AS day, ARRAY[1,2] AS numbers\`;
export default defineDatabase({ driver: postgres({ url: ${JSON.stringify(targetUrl)}, shadowUrl: ${JSON.stringify(shadowUrl)}, pool: { max: 1 } }), tables: { entries }, enums: [status], views: [emails], queries: { values } });
`,
      );
      for (const command of ["generate", "validate", "generate"]) {
        expect(await runDatabaseCli([command], { cwd: root, io }), messages.join("\n")).toBe(0);
      }
      expect(messages.at(-1)).toBe("default: unchanged");
      expect(await fs.readdir(path.join(directory, "migrations"))).toHaveLength(1);
      const artifact = await fs.readFile(path.join(directory, "generated.ts"), "utf8");
      expect(artifact).toContain('readonly "count": string | null;');
      expect(artifact).toContain('readonly "day": Date | null;');
      expect(artifact).toContain('readonly "numbers": unknown | null;');
      const observer = new Pool({ connectionString: shadowUrl });
      try {
        const [row] = (
          await observer.query(
            "SELECT 9007199254740993::bigint AS count, DATE '2026-10-09' AS day, ARRAY[1,2] AS numbers",
          )
        ).rows;
        expect(row.count).toBe("9007199254740993");
        expect(row.day).toBeInstanceOf(Date);
        expect(row.numbers).toEqual([1, 2]);
      } finally {
        await observer.end();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed if target cannot be reached and preserves existing scratch data", async () => {
    const unreachable = new URL(targetUrl!);
    unreachable.port = "1";
    const observer = new Pool({ connectionString: shadowUrl });
    const scratch = await postgres({
      url: unreachable.href,
      shadowUrl: shadowUrl!,
      pool: { connectionTimeoutMillis: 200 },
    }).shadow();
    try {
      await observer.query(
        "CREATE TABLE reset_guard (value text); INSERT INTO reset_guard VALUES ('preserve')",
      );
      await expect(scratch.reset()).rejects.toThrow();
      expect((await observer.query("SELECT value FROM reset_guard")).rows).toEqual([
        { value: "preserve" },
      ]);
    } finally {
      await scratch.close?.();
      await observer.query("DROP TABLE IF EXISTS reset_guard");
      await observer.end();
    }
  });

  it("serializes concurrent descriptions on one pooled connection and releases it on close", async () => {
    const scratch = await postgres({
      url: targetUrl!,
      shadowUrl: shadowUrl!,
      pool: { max: 1 },
    }).shadow();
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          scratch.describe("SELECT $1::integer AS value", ["value"]),
        ),
      );
      for (const result of results)
        expect(result).toEqual({
          parameters: ["value"],
          columns: [{ name: "value", dataType: "integer", nullable: true }],
        });
    } finally {
      await scratch.close?.();
    }
    await scratch.close?.();
    await expect(scratch.introspect()).rejects.toThrow(/closed/);
  });

  it("rolls back failed reset and preserves its error and existing scratch data", async () => {
    const observer = new Pool({ connectionString: shadowUrl });
    const scratch = await postgres({
      url: targetUrl!,
      shadowUrl: shadowUrl!,
      pool: { options: "-c default_transaction_read_only=on" },
    }).shadow();
    try {
      await observer.query(
        "CREATE TABLE readonly_reset_guard (value text); INSERT INTO readonly_reset_guard VALUES ('preserve')",
      );
      await expect(scratch.reset()).rejects.toThrow(/read.only/i);
      expect((await observer.query("SELECT value FROM readonly_reset_guard")).rows).toEqual([
        { value: "preserve" },
      ]);
    } finally {
      await scratch.close?.();
      await observer.query("DROP TABLE IF EXISTS readonly_reset_guard");
      await observer.end();
    }
  });

  it("holds the scratch workflow lock until close, then lets another owner reset", async () => {
    const first = await postgres({
      url: targetUrl!,
      shadowUrl: shadowUrl!,
      pool: { max: 1 },
    }).shadow();
    const second = await postgres({
      url: targetUrl!,
      shadowUrl: shadowUrl!,
      pool: { max: 1 },
    }).shadow();
    const observer = new Pool({ connectionString: shadowUrl });
    let reset: Promise<void> | undefined;
    try {
      await first.reset();
      await first.execute("CREATE TABLE workflow_guard (value text)");
      reset = second.reset();
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await observer.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        if (result.rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(
        (await observer.query("SELECT to_regclass('workflow_guard') AS relation")).rows[0].relation,
      ).toBe("workflow_guard");
      await first.close?.();
      await reset;
      expect(await second.introspect()).toEqual({ version: 1, enums: [], tables: [], views: [] });
    } finally {
      await first.close?.();
      await reset?.catch(() => undefined);
      await second.close?.();
      await observer.end();
    }
  });

  it.each([
    [
      "identity",
      "CREATE TABLE unsupported (id integer GENERATED ALWAYS AS IDENTITY)",
      /Identity column/,
    ],
    ["materialized view", "CREATE MATERIALIZED VIEW unsupported AS SELECT 1 AS id", /kind m/],
    [
      "foreign key action",
      "CREATE TABLE parent (id integer PRIMARY KEY); CREATE TABLE unsupported (id integer REFERENCES parent ON DELETE CASCADE)",
      /Foreign key.*cannot be represented/,
    ],
    [
      "included index",
      "CREATE TABLE unsupported (id integer, label text); CREATE INDEX included ON unsupported (id) INCLUDE (label)",
      /covering index/,
    ],
    [
      "unvalidated check",
      "CREATE TABLE unsupported (id integer); ALTER TABLE unsupported ADD CONSTRAINT positive CHECK (id > 0) NOT VALID",
      /unvalidated constraint/,
    ],
    [
      "nulls not distinct",
      "CREATE TABLE unsupported (id integer UNIQUE NULLS NOT DISTINCT)",
      /cannot be represented/,
    ],
    [
      "inheritance",
      "CREATE TABLE parent (id integer); CREATE TABLE unsupported () INHERITS (parent)",
      /cannot be represented/,
    ],
    ["unlogged table", "CREATE UNLOGGED TABLE unsupported (id integer)", /cannot be represented/],
    [
      "nondefault collation",
      'CREATE TABLE unsupported (id text COLLATE "C")',
      /cannot be represented/,
    ],
  ])(
    "rejects unsupported %s rather than accepting an incomplete schema",
    async (_name, sql, error) => {
      const scratch = await postgres({ url: targetUrl!, shadowUrl: shadowUrl! }).shadow();
      try {
        await scratch.reset();
        await scratch.execute(sql);
        await expect(scratch.introspect()).rejects.toThrow(error);
      } finally {
        await scratch.close?.();
      }
    },
  );
});
