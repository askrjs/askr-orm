import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";

const root = process.cwd();
const contract = JSON.parse(await fs.readFile("tests/public-contract.json", "utf8"));
const consumer = await fs.mkdtemp(path.join(os.tmpdir(), "askr-orm-packed-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this contract through npm run test:packed.");
const npm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
try {
  const records = JSON.parse(
    npm(["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], root),
  );
  const packed = Array.isArray(records) ? records[0] : Object.values(records)[0];
  assert(packed?.filename, "npm pack must provide an archive filename");
  await fs.writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "orm-packed-consumer", private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      path.join(consumer, packed.filename),
    ],
    consumer,
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(consumer, "node_modules/@askrjs/orm/package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.exports).sort(), contract.exportKeys);
  // Root and SQLite must work without PostgreSQL's optional peers.
  await assert.rejects(fs.access(path.join(consumer, "node_modules/pg")), { code: "ENOENT" });
  await fs.writeFile(
    path.join(consumer, "runtime.mjs"),
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import * as root from '@askrjs/orm';
    import * as postgres from '@askrjs/orm/postgres';
    import * as sqlite from '@askrjs/orm/sqlite';
    import * as tooling from '@askrjs/orm/tooling';
    const modules = { '.': root, './postgres': postgres, './sqlite': sqlite, './tooling': tooling };
    for (const [key, expected] of Object.entries(${JSON.stringify(contract.entrypoints)}))
      assert.deepEqual(Object.keys(modules[key]), expected.values, key);
    assert.deepEqual(Object.keys(root.sql).sort(), ['identifier', 'literal', 'unsafe']);
    for (const privatePath of ${JSON.stringify(contract.privateSubpaths)})
      await assert.rejects(import('@askrjs/orm/' + privatePath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    const fragment = root.sql\`SELECT \${root.sql.identifier('odd"name')} WHERE id = \${"semi;colon"}\`;
    assert.deepEqual(root.compileSql(fragment), { text: 'SELECT "odd""name" WHERE id = $1', values: ['semi;colon'] });
    const messages = [];
    assert.equal(await tooling.runDatabaseCli(['--help'], { io: { log: value => messages.push(value), error: value => { throw new Error(String(value)); } } }), 0);
    assert(messages.some(value => String(value).includes('migration')));
    const items = root.table('items', { id: root.integer().primaryKey(), value: root.text().notNull() });
    const definition = root.defineDatabase({ driver: sqlite.sqlite({ filename: ':memory:' }), tables: { items }, generated: { manifest: { migrations: [{ id: '01SCRIPT', parent: null, checksum: 'success', transactional: true, sql: 'CREATE TABLE "items" ("id" integer PRIMARY KEY, "value" text NOT NULL); INSERT INTO "items" VALUES (1, \\'semi;colon\\'); INSERT INTO "items" VALUES (2, \\'second\\');' }] } } });
    const db = await definition.open();
    try {
      assert.deepEqual(await db.migrations.apply(), { applied: ['01SCRIPT'] });
      assert.deepEqual(await db.items.select(({ items }) => items).orderBy(({ items }) => items.id).execute(), [{ id: 1, value: 'semi;colon' }, { id: 2, value: 'second' }]);
      const primary = new Error('rollback primary');
      await assert.rejects(db.transaction(async tx => { await tx.items.insert({ id: 3, value: 'discard' }); throw primary; }), error => error === primary);
      assert.equal((await db.items.select(({ items }) => items).execute()).length, 2);
      assert.equal((await db.migrations.plan()).pending.length, 0);
      let retiredMigrations;
      await db.transaction(async tx => { retiredMigrations = tx.migrations; });
      await assert.rejects(retiredMigrations.plan(), /Transaction client is no longer active/);
      await assert.rejects(retiredMigrations.apply(), /Transaction client is no longer active/);
      await assert.rejects(retiredMigrations.resolve('01SCRIPT', 'applied'), /Transaction client is no longer active/);
    } finally { await db.close(); }
  `,
  );
  execFileSync(process.execPath, [path.join(consumer, "runtime.mjs")], {
    cwd: consumer,
    stdio: "pipe",
  });
  // Also qualify the documented optional-peer minimum with a normal install.
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      path.join(consumer, packed.filename),
      "pg@8.23.0",
      "pg-query-stream@4.17.0",
      "@types/pg@8.23.1",
      "@types/node@26.3.0",
    ],
    consumer,
  );
  const fixture = path.join(consumer, "fixture.ts");
  const postgresWorkflow = Boolean(
    process.env.ASKR_ORM_TEST_DATABASE_URL && process.env.ASKR_ORM_TEST_SHADOW_URL,
  );
  if (postgresWorkflow) {
    await fs.mkdir(path.join(consumer, "database"));
    await fs.writeFile(
      path.join(consumer, "database/index.ts"),
      `
import { defineDatabase, defineQuery, table, text, uuid } from '@askrjs/orm';
import { postgres } from '@askrjs/orm/postgres';
const users = table('users', { id: uuid().primaryKey().defaultRandom(), emailAddress: text().name('email').notNull().unique() });
const byEmail = defineQuery<{email:string}>('users.by-email')\`SELECT id, email FROM users WHERE email = \${'email'} OR email = \${'email'}\`;
export default defineDatabase({ driver: postgres({ url: process.env.ASKR_ORM_TEST_DATABASE_URL!, shadowUrl: process.env.ASKR_ORM_TEST_SHADOW_URL!, pool: {max:1} }), tables: {users}, queries: {byEmail} });
`,
    );
    await fs.writeFile(
      path.join(consumer, "postgres-workflow.mjs"),
      `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {runDatabaseCli} from '@askrjs/orm/tooling';
const messages=[];
const io={log:(v='')=>messages.push(String(v)), error:(v='')=>messages.push(String(v))};
for (const command of ['generate','validate','generate']) assert.equal(await runDatabaseCli([command], {cwd:process.cwd(),io}), 0, messages.join('\\n'));
assert.equal(messages.at(-1),'default: unchanged');
assert.equal((await fs.readdir('database/migrations')).length,1);
const generated=await fs.readFile('database/generated.ts','utf8');
assert(generated.includes('readonly "id": string | null;'));
assert(generated.includes('readonly "email": string | null;'));
`,
    );
    execFileSync(process.execPath, [path.join(consumer, "postgres-workflow.mjs")], {
      cwd: consumer,
      stdio: "pipe",
    });
  }
  const imports = Object.entries(contract.entrypoints)
    .map(
      ([key]) =>
        `import * as Entry_${key === "." ? "root" : key.slice(2)} from '@askrjs/orm${key === "." ? "" : key.slice(1)}';`,
    )
    .join("\n");
  const negative = Object.entries(contract.entrypoints)
    .flatMap(([key, c]) =>
      c.removed.map(
        (name) =>
          `// @ts-expect-error removed public name\nimport type { ${name} as Removed_${key === "." ? "root" : key.slice(2)}_${name} } from '@askrjs/orm${key === "." ? "" : key.slice(1)}';`,
      ),
    )
    .join("\n");
  await fs.writeFile(
    fixture,
    `${imports}\n${await fs.readFile("tests/types/contracts.ts", "utf8")}\n${negative}\n// @ts-expect-error keyed SQL is replaced by defineQuery\nEntry_root.sql.key('old', {});\n// @ts-expect-error ColumnBuilder is a type-only contract\nnew Entry_root.ColumnBuilder({});\nconst generated: Entry_root.GeneratedDatabaseArtifact = { manifest: { migrations: [] } };\nconst codec: Entry_root.Codec<string,string> = { name: 'identity', encode: value => value, decode: value => value };\nconst postgresOptions: Entry_postgres.PostgresOptions = { url: 'postgresql://localhost/database', pool: { max: 2 } };
// @ts-expect-error pool sizes remain numbers
const invalidPool: Entry_postgres.PostgresOptions = { pool: { max: 'many' } };
const sqliteOptions: Entry_sqlite.SqliteOptions = { filename: ':memory:' };
void [generated, codec, postgresOptions, invalidPool, sqliteOptions];\n`,
  );
  await fs.writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        skipLibCheck: false,
      },
      files: ["fixture.ts", ...(postgresWorkflow ? ["database/generated.ts"] : [])],
    }),
  );
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: consumer, stdio: "pipe", encoding: "utf8" },
  );
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    skipLibCheck: false,
  };
  const program = ts.createProgram(
    [fixture, ...(postgresWorkflow ? [path.join(consumer, "database/generated.ts")] : [])],
    options,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => consumer,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  for (const [key, c] of Object.entries(contract.entrypoints)) {
    const moduleName = "@askrjs/orm" + (key === "." ? "" : key.slice(1));
    const declaration = program
      .getSourceFile(fixture)
      .statements.find(
        (statement) =>
          ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === moduleName,
      );
    const names = checker
      .getExportsOfModule(checker.getSymbolAtLocation(declaration.moduleSpecifier))
      .map((symbol) => symbol.name)
      .sort();
    assert.deepEqual(names, [...c.values, ...c.types].sort(), moduleName + " packed declarations");
  }
  console.log(
    JSON.stringify({
      entrypoints: 4,
      names: Object.values(contract.entrypoints).reduce(
        (n, c) => n + c.values.length + c.types.length,
        0,
      ),
      removed: Object.values(contract.entrypoints).reduce((n, c) => n + c.removed.length, 0),
      privateSubpaths: contract.privateSubpaths.length,
      postgresPeers: ["8.23.0", "4.17.0"],
      postgresWorkflow: postgresWorkflow
        ? "installed generate, validate, unchanged generate; TS6/7 artifact"
        : "not run without explicit test databases",
      sqliteScript: "complete, rollback, subsequent query",
    }),
  );
} finally {
  await fs.rm(consumer, { recursive: true, force: true });
}
