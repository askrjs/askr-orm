import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  bigInt,
  boolean,
  defineDatabase,
  defineQuery,
  integer,
  numeric,
  table,
  text,
} from "./index";
import { sqlite } from "./sqlite";
import { diffSnapshots, runDatabaseCli, type SchemaSnapshot } from "./tooling-impl";

const temporaryDirectories: string[] = [];

const empty: SchemaSnapshot = {
  version: 1,
  enums: [],
  tables: [],
  views: [],
};

const usersSnapshot: SchemaSnapshot = {
  version: 1,
  enums: [],
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [
        {
          property: "email",
          name: "email",
          dataType: "text",
          nullable: false,
          primaryKey: false,
          unique: true,
        },
        {
          property: "id",
          name: "id",
          dataType: "uuid",
          nullable: false,
          primaryKey: true,
          unique: false,
          default: "gen_random_uuid()",
        },
      ],
      constraints: [],
    },
  ],
  views: [],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("schema migration generation", () => {
  it("should render a deterministic first schema and no-op diff", () => {
    expect(diffSnapshots(empty, usersSnapshot)).toBe(
      'CREATE TABLE "public"."users" (\n' +
        '  "email" text NOT NULL UNIQUE,\n' +
        '  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY\n' +
        ");\n",
    );
    expect(diffSnapshots(usersSnapshot, usersSnapshot)).toBe("");
  });

  it("should require explicit intent for destructive and ambiguous changes", () => {
    expect(() => diffSnapshots(usersSnapshot, empty)).toThrow(/Dropping table users requires/);
    const changed: SchemaSnapshot = {
      ...usersSnapshot,
      tables: [
        {
          ...usersSnapshot.tables[0]!,
          columns: [
            { ...usersSnapshot.tables[0]!.columns[0]!, dataType: "uuid" },
            ...usersSnapshot.tables[0]!.columns.slice(1),
          ],
        },
      ],
    };
    expect(() => diffSnapshots(usersSnapshot, changed)).toThrow(/requires convertUsing/);
  });

  it("should render supported SQLite renames and reject PostgreSQL-only alterations", () => {
    const renamed: SchemaSnapshot = {
      ...usersSnapshot,
      tables: [{ ...usersSnapshot.tables[0]!, name: "accounts", renamedFrom: "users" }],
    };
    expect(diffSnapshots(usersSnapshot, renamed, "sqlite")).toContain(
      'ALTER TABLE "users" RENAME TO "accounts"',
    );
    const changedType: SchemaSnapshot = {
      ...usersSnapshot,
      tables: [
        {
          ...usersSnapshot.tables[0]!,
          columns: usersSnapshot.tables[0]!.columns.map((column) =>
            column.name === "email"
              ? { ...column, dataType: "integer", convertUsing: "0" }
              : column,
          ),
        },
      ],
    };
    expect(() => diffSnapshots(usersSnapshot, changedType, "sqlite")).toThrow(
      /SQLite table rebuild/,
    );
    const withView = (query: string): SchemaSnapshot => ({
      ...usersSnapshot,
      views: [{ kind: "view", schema: "public", name: "user_emails", query }],
    });
    expect(() =>
      diffSnapshots(
        withView("SELECT email FROM users"),
        withView("SELECT id FROM users"),
        "sqlite",
      ),
    ).toThrow(/SQLite manual migration/);
  });
});

describe("database CLI", () => {
  it("should generate SQLite row types that accept native values from every storage class", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const root = await fs.mkdtemp(path.join(packageRoot, ".orm-sqlite-types-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "database");
    await fs.mkdir(path.join(directory, "migrations"), { recursive: true });
    const schema = "CREATE TABLE typed(n numeric,b bigint,flag boolean,label text,count integer)";
    await fs.writeFile(
      path.join(directory, "migrations", "01TYPED.sql"),
      `-- askr:id 01TYPED\n-- askr:parent none\n-- askr:transactional true\n\n${schema};\n`,
    );
    await fs.writeFile(
      path.join(directory, "index.ts"),
      `import { bigInt, boolean, defineDatabase, defineQuery, integer, numeric, table, text } from "../../src/index.ts";
import { sqlite } from "../../src/sqlite.ts";
const typed = table("typed", { n: numeric(), b: bigInt(), flag: boolean(), label: text(), count: integer() });
const values = defineQuery<Record<never, never>>("typed.values")\`SELECT *, n + 1 AS expression FROM typed ORDER BY rowid\`;
export default defineDatabase({ driver: sqlite({ filename: ${JSON.stringify(path.join(root, "target.sqlite"))} }), tables: { typed }, queries: { values } });
`,
    );
    const messages: string[] = [];
    const io = {
      log: (value: unknown = "") => messages.push(String(value)),
      error: (value: unknown = "") => messages.push(String(value)),
    };
    for (const command of ["generate", "validate", "generate"]) {
      expect(await runDatabaseCli([command], { cwd: root, io }), messages.join("\n")).toBe(0);
    }
    expect(messages.at(-1)).toBe("default: unchanged");

    const values = defineQuery<Record<never, never>>(
      "typed.values",
    )`SELECT *, n + 1 AS expression FROM typed ORDER BY rowid`;
    const driver = sqlite({ filename: ":memory:" });
    const adapter = await driver.open();
    const db = await defineDatabase({
      driver: { ...driver, open: async () => adapter },
      tables: {
        typed: table("typed", {
          n: numeric(),
          b: bigInt(),
          flag: boolean(),
          label: text(),
          count: integer(),
        }),
      },
      queries: { values },
    }).open();
    try {
      await adapter.executeScript!(`${schema};
INSERT INTO typed VALUES (1.25,42,1,'label',3);
INSERT INTO typed VALUES ('text','text','text',X'0102','text');
INSERT INTO typed VALUES (X'0102',X'0102',X'0102',NULL,X'0102');
INSERT INTO typed VALUES (NULL,NULL,NULL,NULL,NULL);`);
      const rows = await db.queries.values({});
      const blob = new Uint8Array([1, 2]);
      expect(rows).toEqual([
        { n: 1.25, b: 42, flag: 1, label: "label", count: 3, expression: 2.25 },
        { n: "text", b: "text", flag: "text", label: blob, count: "text", expression: 1 },
        { n: blob, b: blob, flag: blob, label: null, count: blob, expression: 1 },
        { n: null, b: null, flag: null, label: null, count: null, expression: null },
      ]);
    } finally {
      await db.close();
    }

    const consumer = path.join(root, "consumer.ts");
    await fs.writeFile(
      consumer,
      `import type { GeneratedDatabaseQueries } from "./database/generated";
type Row = GeneratedDatabaseQueries["typed.values"]["row"];
const numeric: Row = { n: 1.25, b: 42, flag: 1, label: "label", count: 3, expression: 2.25 };
const textual: Row = { n: "text", b: "text", flag: "text", label: new Uint8Array([1, 2]), count: "text", expression: 1 };
const blob: Row = { n: new Uint8Array([1, 2]), b: new Uint8Array([1, 2]), flag: new Uint8Array([1, 2]), label: null, count: new Uint8Array([1, 2]), expression: 1 };
const empty: Row = { n: null, b: null, flag: null, label: null, count: null, expression: null };
// @ts-expect-error SQLite does not return JavaScript booleans.
const invalidBoolean: Row["flag"] = true;
// @ts-expect-error The built-in adapter does not enable bigint reads.
const invalidBigint: Row["b"] = 42n;
// @ts-expect-error SQLite does not return Date instances.
const invalidDate: Row["expression"] = new Date();
void [numeric, textual, blob, empty, invalidBoolean, invalidBigint, invalidDate];
`,
    );
    const program = ts.createProgram([consumer], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      paths: { "@askrjs/orm": [path.join(packageRoot, "src/index.ts")] },
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });

  it("should generate, byte-validate, and no-op regenerate a flat project", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const root = await fs.mkdtemp(path.join(packageRoot, ".orm-fixture- #% "));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "database"), { recursive: true });
    await fs.writeFile(
      path.join(root, "database", "users.ts"),
      `import { table, text, uuid } from "../../src/index.ts";
export const users = table("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
});
`,
    );
    await fs.writeFile(
      path.join(root, "database", "index.ts"),
      `import { defineDatabase, defineQuery } from "../../src/index.ts";
import { users } from "./users.ts";
const byEmail = defineQuery<{ email: string }>("users.by-email")\`SELECT id FROM users WHERE email = \${"email"}\`;
let migrated = false;
const snapshot = ${JSON.stringify(usersSnapshot)};
export default defineDatabase({
  driver: {
    dialect: "postgres",
    targetIdentity: "target",
    shadowIdentity: "scratch",
    open: async () => { throw new Error("generate must not open target"); },
    shadow: async () => ({
      identity: "scratch",
      reset: async () => { migrated = false; },
      execute: async () => { migrated = true; },
      introspect: async () => migrated ? snapshot : ${JSON.stringify(empty)},
      describe: async () => ({
        parameters: ["email"],
        columns: [{ name: "id", dataType: "uuid", nullable: false }],
      }),
    }),
  },
  tables: { users },
  queries: { byEmail },
});
`,
    );
    const logs: string[] = [];
    const io = {
      log: (value: unknown = "") => logs.push(String(value)),
      error: (value: unknown = "") => logs.push(`ERROR ${String(value)}`),
    };

    expect(await runDatabaseCli(["generate"], { cwd: root, io }), logs.join("\n")).toBe(0);
    expect(logs.at(-1)).toMatch(/generated/);
    expect((await fs.readdir(path.join(root, "database", "migrations"))).length).toBe(1);
    expect(await runDatabaseCli(["validate"], { cwd: root, io }), logs.join("\n")).toBe(0);
    expect(logs.at(-1)).toBe("default: valid");
    expect(await runDatabaseCli(["generate"], { cwd: root, io }), logs.join("\n")).toBe(0);
    expect(logs.at(-1)).toBe("default: unchanged");

    const generated = await fs.readFile(path.join(root, "database", "generated.ts"), "utf8");
    expect(generated).toContain('"users.by-email"');
    expect(generated).toContain('readonly "id": string;');
  });

  it("should print help without loading a project", async () => {
    const logs: string[] = [];
    expect(
      await runDatabaseCli(["--help"], {
        cwd: os.tmpdir(),
        io: { log: (value = "") => logs.push(String(value)), error: () => undefined },
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("askr database migration apply");
    expect(
      await runDatabaseCli(["migration", "status", "--help"], {
        cwd: os.tmpdir(),
        io: { log: (value = "") => logs.push(String(value)), error: () => undefined },
      }),
    ).toBe(0);
  });
});
