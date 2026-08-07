import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffSnapshots, runDatabaseCli, type SchemaSnapshot } from "./tooling";

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
  it("renders a deterministic first schema and no-op diff", () => {
    expect(diffSnapshots(empty, usersSnapshot)).toBe(
      'CREATE TABLE "public"."users" (\n' +
        '  "email" text NOT NULL UNIQUE,\n' +
        '  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY\n' +
        ");\n",
    );
    expect(diffSnapshots(usersSnapshot, usersSnapshot)).toBe("");
  });

  it("requires explicit intent for destructive and ambiguous changes", () => {
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
});

describe("database CLI", () => {
  it("generates, byte-validates, and no-op regenerates a flat project", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const root = await fs.mkdtemp(path.join(packageRoot, ".orm-fixture-"));
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
      `import { database } from "../../src/index.ts";
import { users } from "./users.ts";
let migrated = false;
const snapshot = ${JSON.stringify(usersSnapshot)};
export default database({
  tables: { users },
  targetIdentity: "target",
  scratchIdentity: "scratch",
  target: async () => { throw new Error("generate must not open target"); },
  scratch: async () => ({
    identity: "scratch",
    reset: async () => { migrated = false; },
    execute: async () => { migrated = true; },
    introspect: async () => migrated ? snapshot : ${JSON.stringify(empty)},
    describe: async () => ({
      parameters: ["email"],
      columns: [{ name: "id", dataType: "uuid", nullable: false }],
    }),
  }),
});
`,
    );
    await fs.writeFile(
      path.join(root, "queries.ts"),
      `import { sql } from "../src/index.ts";
export const byEmail = sql.key("users.by-email", { email: "" })\`
  SELECT id FROM users WHERE email = :email
\`;
`,
    );
    const logs: string[] = [];
    const io = {
      log: (value: unknown = "") => logs.push(String(value)),
      error: (value: unknown = "") => logs.push(`ERROR ${String(value)}`),
    };

    expect(await runDatabaseCli(["generate"], { cwd: root, io })).toBe(0);
    expect(logs.at(-1)).toMatch(/generated/);
    expect((await fs.readdir(path.join(root, "database", "migrations"))).length).toBe(1);
    expect(await runDatabaseCli(["validate"], { cwd: root, io })).toBe(0);
    expect(logs.at(-1)).toBe("default: valid");
    expect(await runDatabaseCli(["generate"], { cwd: root, io })).toBe(0);
    expect(logs.at(-1)).toBe("default: unchanged");

    const generated = await fs.readFile(
      path.join(root, "database", "generated", "queries.ts"),
      "utf8",
    );
    expect(generated).toContain('"users.by-email"');
    expect(generated).toContain('readonly "id": string;');
  });

  it("prints help without loading a project", async () => {
    const logs: string[] = [];
    expect(
      await runDatabaseCli(["--help"], {
        cwd: os.tmpdir(),
        io: { log: (value = "") => logs.push(String(value)), error: () => undefined },
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("askr database migration apply");
  });
});
