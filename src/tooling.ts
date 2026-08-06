import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { DatabaseAdapter } from "./adapter";
import type { DatabaseDefinition, DatabaseRegistry, DatabaseToolingAdapter } from "./definition";
import type { BundledMigration, MigrationManifest } from "./migrations";
import { quoteIdentifier, singularTypeName } from "./naming";
import type {
  AnyTable,
  ColumnAst,
  IndexDefinition,
  TableConstraint,
  ViewDefinition,
} from "./schema";

export interface DatabaseCliIo {
  log(message?: unknown): void;
  error(message?: unknown): void;
}

export interface RunDatabaseCliOptions {
  readonly cwd?: string;
  readonly io?: DatabaseCliIo;
  readonly confirm?: (message: string) => Promise<boolean>;
}

export interface SnapshotColumn extends Omit<ColumnAst, "codec" | "references" | "property"> {
  readonly property: string;
  readonly reference?: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  };
  readonly codec?: string;
}

export interface SnapshotTable {
  readonly schema: string;
  readonly name: string;
  readonly renamedFrom?: string;
  readonly drop?: boolean;
  readonly columns: readonly SnapshotColumn[];
  readonly constraints: readonly TableConstraint[];
}

export interface SchemaSnapshot {
  readonly version: 1;
  readonly enums: readonly {
    readonly schema: string;
    readonly name: string;
    readonly values: readonly string[];
  }[];
  readonly tables: readonly SnapshotTable[];
  readonly views: readonly ViewDefinition[];
}

interface LoadedDatabase {
  readonly name: string;
  readonly definition: DatabaseDefinition<Record<string, AnyTable>>;
  readonly databaseDir: string;
  readonly projectRoot: string;
}

interface KeyedSqlDescription {
  readonly key: string;
  readonly source: string;
  readonly parameters: readonly string[];
  readonly columns: readonly {
    readonly name: string;
    readonly dataType: string;
    readonly nullable: boolean;
  }[];
}

const GENERATED_FILES = [
  "index.ts",
  "schema.ts",
  "metadata.ts",
  "queries.ts",
  "migrations.ts",
  "schema.snapshot.json",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function columnSnapshot(property: string, column: AnyTable["$columns"][string]): SnapshotColumn {
  const reference = column.ast.references?.();
  const referenceOwner = reference ? columnOwners.get(reference) : undefined;
  return {
    property,
    name: column.ast.name,
    dataType: column.ast.dataType,
    nullable: column.ast.nullable,
    primaryKey: column.ast.primaryKey,
    unique: column.ast.unique,
    ...(column.ast.default === undefined ? {} : { default: column.ast.default }),
    ...(column.ast.generated === undefined ? {} : { generated: column.ast.generated }),
    ...(reference === undefined
      ? {}
      : {
          reference: {
            schema: referenceOwner?.schema ?? "public",
            table: referenceOwner?.table ?? findOwningTableName(reference) ?? "<unresolved>",
            column: reference.ast.name,
          },
        }),
    ...(column.ast.codec === undefined ? {} : { codec: column.ast.codec.name }),
    ...(column.ast.renamedFrom === undefined ? {} : { renamedFrom: column.ast.renamedFrom }),
    ...(column.ast.drop === undefined ? {} : { drop: column.ast.drop }),
    ...(column.ast.convertUsing === undefined ? {} : { convertUsing: column.ast.convertUsing }),
  };
}

const columnOwners = new WeakMap<object, { readonly schema: string; readonly table: string }>();

function findOwningTableName(column: object): string | undefined {
  return columnOwners.get(column)?.table;
}

export function snapshotDefinition(
  definition: DatabaseDefinition<Record<string, AnyTable>>,
): SchemaSnapshot {
  for (const table of Object.values(definition.tables)) {
    for (const column of Object.values(table.$columns)) {
      columnOwners.set(column, { schema: table.$schema, table: table.$name });
    }
  }
  const tables = Object.values(definition.tables)
    .map(
      (table): SnapshotTable => ({
        schema: table.$schema,
        name: table.$name,
        ...(table.$options.renamedFrom === undefined
          ? {}
          : { renamedFrom: table.$options.renamedFrom }),
        ...(table.$options.drop === undefined ? {} : { drop: table.$options.drop }),
        columns: Object.entries(table.$columns)
          .map(([property, column]) => columnSnapshot(property, column))
          .sort((left, right) => left.name.localeCompare(right.name)),
        constraints: [...(table.$options.constraints ?? [])].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      }),
    )
    .sort((left, right) =>
      `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`),
    );
  return {
    version: 1,
    enums: [...definition.enums]
      .map((entry) => ({
        schema: entry.schema,
        name: entry.name,
        values: [...entry.values],
      }))
      .sort((left, right) =>
        `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`),
      ),
    tables,
    views: [...definition.views].sort((left, right) =>
      `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`),
    ),
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function columnSql(column: SnapshotColumn): string {
  const parts = [quoteIdentifier(column.name), column.dataType];
  if (column.generated) {
    parts.push(`GENERATED ALWAYS AS (${column.generated}) STORED`);
  } else if (column.default) {
    parts.push(`DEFAULT ${column.default}`);
  }
  if (!column.nullable) parts.push("NOT NULL");
  if (column.primaryKey) parts.push("PRIMARY KEY");
  if (column.unique) parts.push("UNIQUE");
  if (column.reference) {
    parts.push(
      `REFERENCES ${qualified(column.reference.schema, column.reference.table)} (${quoteIdentifier(column.reference.column)})`,
    );
  }
  return parts.join(" ");
}

function constraintSql(table: SnapshotTable, constraint: TableConstraint): string {
  const name = constraint.name ? `CONSTRAINT ${quoteIdentifier(constraint.name)} ` : "";
  if (constraint.kind === "check") return `${name}CHECK (${constraint.expression})`;
  if (constraint.kind === "unique") {
    return `${name}UNIQUE (${constraint.columns.map(quoteIdentifier).join(", ")})`;
  }
  throw new Error(`Index ${constraint.name ?? "<unnamed>"} is not an inline constraint.`);
}

function indexName(table: SnapshotTable, index: IndexDefinition, position: number): string {
  return index.name ?? `${table.name}_${position + 1}_idx`;
}

function createTableSql(table: SnapshotTable): string {
  const inline = table.constraints.filter((entry) => entry.kind !== "index");
  const parts = [
    ...table.columns.filter((column) => !column.drop).map(columnSql),
    ...inline.map((constraint) => constraintSql(table, constraint)),
  ];
  const statements = [
    `CREATE TABLE ${qualified(table.schema, table.name)} (\n  ${parts.join(",\n  ")}\n);`,
  ];
  table.constraints
    .filter((entry): entry is IndexDefinition => entry.kind === "index")
    .forEach((index, position) => {
      statements.push(
        `CREATE${index.unique ? " UNIQUE" : ""} INDEX ${quoteIdentifier(indexName(table, index, position))} ON ${qualified(table.schema, table.name)}${index.method ? ` USING ${index.method}` : ""} (${index.expressions.join(", ")})${index.where ? ` WHERE ${index.where}` : ""};`,
      );
    });
  return statements.join("\n");
}

function activeSnapshot(snapshot: SchemaSnapshot): SchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables
      .filter((table) => !table.drop)
      .map((table) => ({
        ...table,
        columns: table.columns.filter((column) => !column.drop),
      })),
  };
}

function renderInitialSchema(snapshot: SchemaSnapshot): string {
  const statements: string[] = [];
  const schemas = new Set([
    ...snapshot.enums.map((entry) => entry.schema),
    ...snapshot.tables.map((entry) => entry.schema),
    ...snapshot.views.map((entry) => entry.schema),
  ]);
  for (const schema of [...schemas].sort()) {
    if (schema !== "public")
      statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
  }
  for (const value of snapshot.enums) {
    statements.push(
      `CREATE TYPE ${qualified(value.schema, value.name)} AS ENUM (${value.values.map(sqlString).join(", ")});`,
    );
  }
  for (const table of snapshot.tables.filter((entry) => !entry.drop)) {
    statements.push(createTableSql(table));
  }
  for (const view of snapshot.views) {
    statements.push(`CREATE VIEW ${qualified(view.schema, view.name)} AS\n${view.query};`);
  }
  return `${statements.join("\n\n")}\n`;
}

function byName<T extends { readonly schema: string; readonly name: string }>(
  values: readonly T[],
): Map<string, T> {
  return new Map(values.map((value) => [`${value.schema}.${value.name}`, value]));
}

export function diffSnapshots(current: SchemaSnapshot, desiredInput: SchemaSnapshot): string {
  const desired = activeSnapshot(desiredInput);
  if (current.tables.length === 0 && current.enums.length === 0 && current.views.length === 0) {
    return renderInitialSchema(desired);
  }
  const statements: string[] = [];
  const currentEnums = byName(current.enums);
  const desiredEnums = byName(desired.enums);
  for (const value of desired.enums) {
    const existing = currentEnums.get(`${value.schema}.${value.name}`);
    if (!existing) {
      statements.push(
        `CREATE TYPE ${qualified(value.schema, value.name)} AS ENUM (${value.values.map(sqlString).join(", ")});`,
      );
      continue;
    }
    if (
      existing.values.some((entry, index) => value.values[index] !== entry) ||
      value.values.length < existing.values.length
    ) {
      throw new Error(`Enum ${value.name} removes or reorders values; use a manual migration.`);
    }
    for (const added of value.values.slice(existing.values.length)) {
      statements.push(
        `ALTER TYPE ${qualified(value.schema, value.name)} ADD VALUE ${sqlString(added)};`,
      );
    }
  }
  for (const value of current.enums) {
    if (!desiredEnums.has(`${value.schema}.${value.name}`)) {
      throw new Error(`Dropping enum ${value.name} requires an explicit manual migration.`);
    }
  }

  const currentTables = byName(current.tables);
  const desiredTables = byName(desired.tables);
  for (const table of desired.tables) {
    const declaredTable = desiredInput.tables.find(
      (entry) => entry.schema === table.schema && entry.name === table.name,
    )!;
    let existing = currentTables.get(`${table.schema}.${table.name}`);
    if (!existing && table.renamedFrom) {
      existing = currentTables.get(`${table.schema}.${table.renamedFrom}`);
      if (!existing) throw new Error(`renamedFrom table ${table.renamedFrom} does not exist.`);
      statements.push(
        `ALTER TABLE ${qualified(table.schema, table.renamedFrom)} RENAME TO ${quoteIdentifier(table.name)};`,
      );
    }
    if (!existing) {
      statements.push(createTableSql(table));
      continue;
    }
    const existingColumns = new Map(existing.columns.map((column) => [column.name, column]));
    const desiredColumns = new Map(table.columns.map((column) => [column.name, column]));
    for (const column of table.columns) {
      let old = existingColumns.get(column.name);
      if (!old && column.renamedFrom) {
        old = existingColumns.get(column.renamedFrom);
        if (!old) {
          throw new Error(
            `${table.name}.${column.property} renamedFrom ${column.renamedFrom} does not exist.`,
          );
        }
        statements.push(
          `ALTER TABLE ${qualified(table.schema, table.name)} RENAME COLUMN ${quoteIdentifier(column.renamedFrom)} TO ${quoteIdentifier(column.name)};`,
        );
      }
      if (!old) {
        if (!column.nullable && column.default === undefined && column.generated === undefined) {
          throw new Error(
            `Adding required column ${table.name}.${column.name} needs a default or manual migration.`,
          );
        }
        statements.push(
          `ALTER TABLE ${qualified(table.schema, table.name)} ADD COLUMN ${columnSql(column)};`,
        );
        continue;
      }
      if (old.dataType !== column.dataType) {
        if (!column.convertUsing) {
          throw new Error(
            `Changing ${table.name}.${column.name} from ${old.dataType} to ${column.dataType} requires convertUsing or a manual migration.`,
          );
        }
        statements.push(
          `ALTER TABLE ${qualified(table.schema, table.name)} ALTER COLUMN ${quoteIdentifier(column.name)} TYPE ${column.dataType} USING ${column.convertUsing};`,
        );
      }
      if (old.nullable && !column.nullable) {
        throw new Error(
          `Making ${table.name}.${column.name} required is ambiguous; use a manual data migration.`,
        );
      }
      if (!old.nullable && column.nullable) {
        statements.push(
          `ALTER TABLE ${qualified(table.schema, table.name)} ALTER COLUMN ${quoteIdentifier(column.name)} DROP NOT NULL;`,
        );
      }
    }
    for (const old of existing.columns) {
      if (!desiredColumns.has(old.name)) {
        const renamed = declaredTable.columns.some(
          (column) => column.renamedFrom === old.name && !column.drop,
        );
        if (renamed) continue;
        const intent = declaredTable.columns.find(
          (column) => column.drop && (column.name === old.name || column.renamedFrom === old.name),
        );
        if (!intent) {
          throw new Error(
            `Dropping ${table.name}.${old.name} requires a column retained with .drop() or a manual migration.`,
          );
        }
        statements.push(
          `ALTER TABLE ${qualified(table.schema, table.name)} DROP COLUMN ${quoteIdentifier(old.name)};`,
        );
      }
    }
    if (JSON.stringify(existing.constraints) !== JSON.stringify(table.constraints)) {
      throw new Error(
        `Changing constraints or indexes on ${table.name} requires a manual migration.`,
      );
    }
  }
  for (const table of current.tables) {
    if (desiredTables.has(`${table.schema}.${table.name}`)) continue;
    const renamed = desiredInput.tables.some(
      (candidate) =>
        !candidate.drop &&
        candidate.schema === table.schema &&
        candidate.renamedFrom === table.name,
    );
    if (renamed) continue;
    const intent = desiredInput.tables.find(
      (candidate) =>
        candidate.drop &&
        candidate.schema === table.schema &&
        (candidate.name === table.name || candidate.renamedFrom === table.name),
    );
    if (!intent) {
      throw new Error(`Dropping table ${table.name} requires table options { drop: true }.`);
    }
    statements.push(`DROP TABLE ${qualified(table.schema, table.name)};`);
  }

  const currentViews = byName(current.views);
  const desiredViews = byName(desired.views);
  for (const view of desired.views) {
    const old = currentViews.get(`${view.schema}.${view.name}`);
    if (!old)
      statements.push(`CREATE VIEW ${qualified(view.schema, view.name)} AS\n${view.query};`);
    else if (old.query !== view.query) {
      statements.push(
        `CREATE OR REPLACE VIEW ${qualified(view.schema, view.name)} AS\n${view.query};`,
      );
    }
  }
  for (const view of current.views) {
    if (!desiredViews.has(`${view.schema}.${view.name}`)) {
      throw new Error(`Dropping view ${view.name} requires a manual migration.`);
    }
  }
  return statements.length === 0 ? "" : `${statements.join("\n\n")}\n`;
}

function parseMigration(content: string, file: string): BundledMigration {
  const id = /^-- askr:id ([A-Z0-9]+)$/m.exec(content)?.[1];
  const parentValue = /^-- askr:parent (.+)$/m.exec(content)?.[1];
  const transactionalValue = /^-- askr:transactional (true|false)$/m.exec(content)?.[1];
  const risk = /^-- askr:risk (safe|review|destructive)$/m.exec(content)?.[1] as
    | BundledMigration["risk"]
    | undefined;
  if (!id || parentValue === undefined || !transactionalValue) {
    throw new Error(`Migration ${file} is missing required askr headers.`);
  }
  if (!file.startsWith(`${id}.`))
    throw new Error(`Migration file ${file} does not match id ${id}.`);
  return {
    id,
    parent: parentValue === "none" ? null : parentValue,
    checksum: sha256(content),
    sql: content,
    transactional: transactionalValue === "true",
    ...(risk === undefined ? {} : { risk }),
  };
}

async function readMigrations(databaseDir: string): Promise<MigrationManifest> {
  const directory = path.join(databaseDir, "migrations");
  const entries = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const migrations = await Promise.all(
    entries
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map(async (file) =>
        parseMigration(await fs.readFile(path.join(directory, file), "utf8"), file),
      ),
  );
  let parent: string | null = null;
  for (const migration of migrations) {
    if (migration.parent !== parent) {
      throw new Error(
        `Migration ${migration.id} has parent ${migration.parent ?? "none"}; expected ${parent ?? "none"}.`,
      );
    }
    parent = migration.id;
  }
  return { migrations };
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = ULID_ALPHABET[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

function ulid(): string {
  const time = encodeBase32(BigInt(Date.now()), 10);
  const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return `${time}${encodeBase32(random, 16)}`;
}

async function findDatabaseEntry(
  start: string,
): Promise<{ projectRoot: string; databaseDir: string }> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, "database", "index.ts");
    if (await fs.stat(candidate).catch(() => null)) {
      return { projectRoot: current, databaseDir: path.dirname(candidate) };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        "No database/index.ts found. Run this command from an Askr database project.",
      );
    }
    current = parent;
  }
}

async function loadDatabases(cwd: string): Promise<{
  readonly all: readonly LoadedDatabase[];
  readonly projectRoot: string;
}> {
  const location = await findDatabaseEntry(cwd);
  const module = (await tsImport(path.join(location.databaseDir, "index.ts"), {
    parentURL: pathToFileURL(location.projectRoot).href,
  })) as Record<string, unknown>;
  const exported = module.default ?? module.database ?? module.databases;
  if (!exported || typeof exported !== "object") {
    throw new Error("database/index.ts must default-export database(...) or databases(...).");
  }
  if ((exported as { kind?: string }).kind === "database") {
    return {
      projectRoot: location.projectRoot,
      all: [
        {
          name: "default",
          definition: exported as DatabaseDefinition<Record<string, AnyTable>>,
          databaseDir: location.databaseDir,
          projectRoot: location.projectRoot,
        },
      ],
    };
  }
  if ((exported as { kind?: string }).kind !== "database-registry") {
    throw new Error("Unsupported database root export.");
  }
  const registry = exported as DatabaseRegistry<
    Record<string, DatabaseDefinition<Record<string, AnyTable>>>
  >;
  return {
    projectRoot: location.projectRoot,
    all: Object.entries(registry.databases).map(([name, definition]) => ({
      name,
      definition,
      databaseDir: path.join(location.databaseDir, name),
      projectRoot: location.projectRoot,
    })),
  };
}

function selectDatabases(
  loaded: Awaited<ReturnType<typeof loadDatabases>>,
  name: string | undefined,
  all: boolean,
  migrationCommand: boolean,
): readonly LoadedDatabase[] {
  if (all) return loaded.all;
  if (name) {
    const selected = loaded.all.find((entry) => entry.name === name);
    if (!selected) throw new Error(`Unknown database ${name}.`);
    return [selected];
  }
  if (loaded.all.length === 1 && !migrationCommand) return loaded.all;
  if (loaded.all.length === 1 && loaded.all[0]?.name === "default") return loaded.all;
  throw new Error(
    migrationCommand
      ? "Migration commands require --database <name> or explicit --all."
      : "Multiple databases are configured; pass --database <name>.",
  );
}

async function scanFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ["node_modules", ".git", "dist", "coverage", "generated"].includes(entry.name)
      ) {
        continue;
      }
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) output.push(target);
    }
  }
  await visit(root);
  return output.sort();
}

async function describeKeyedSql(
  projectRoot: string,
  scratch: DatabaseToolingAdapter,
): Promise<readonly KeyedSqlDescription[]> {
  const descriptions: KeyedSqlDescription[] = [];
  const keys = new Set<string>();
  const pattern =
    /\bsql\.key(?:<[^`]*?>)?\(\s*["']([A-Za-z][A-Za-z0-9_.-]*)["']\s*,[\s\S]*?\)\s*`([^`]*)`/g;
  for (const file of await scanFiles(projectRoot)) {
    const source = await fs.readFile(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const key = match[1]!;
      const sqlSource = match[2]!;
      if (keys.has(key)) throw new Error(`Duplicate keyed SQL key ${key}.`);
      keys.add(key);
      const parameters = [
        ...new Set([...sqlSource.matchAll(/(?<!:):([a-z_][a-z0-9_]*)/gi)].map((item) => item[1]!)),
      ];
      const described = await scratch.describe(
        sqlSource.replace(/(?<!:):([a-z_][a-z0-9_]*)/gi, (_match, name: string) => {
          return `$${parameters.indexOf(name) + 1}`;
        }),
        parameters,
      );
      descriptions.push({
        key,
        source: sqlSource,
        parameters,
        columns: described.columns,
      });
    }
  }
  return descriptions.sort((left, right) => left.key.localeCompare(right.key));
}

function tsType(dataType: string, nullable: boolean): string {
  const normalized = dataType.toLowerCase();
  const base =
    normalized === "boolean"
      ? "boolean"
      : /^(?:smallint|integer|real|double precision)$/.test(normalized)
        ? "number"
        : normalized === "bigint"
          ? "bigint"
          : normalized === "bytea"
            ? "Uint8Array"
            : /^(?:json|jsonb)$/.test(normalized)
              ? "unknown"
              : "string";
  return nullable ? `${base} | null` : base;
}

function renderSchemaTypes(database: LoadedDatabase): string {
  const lines = [
    "// Generated by @askrjs/orm. Do not edit.",
    'import type { InferInsert, InferKey, InferPatch, InferRow } from "@askrjs/orm";',
    "",
  ];
  for (const property of Object.keys(database.definition.tables).sort()) {
    const typeName = singularTypeName(property);
    const modulePath = `../${property}`;
    lines.push(
      `type ${typeName}Table = typeof import(${JSON.stringify(modulePath)})[${JSON.stringify(property)}];`,
      `export type ${typeName} = InferRow<${typeName}Table>;`,
      `export type New${typeName} = InferInsert<${typeName}Table>;`,
      `export type ${typeName}Patch = InferPatch<${typeName}Table>;`,
      `export type ${typeName}Key = InferKey<${typeName}Table>;`,
      "",
    );
  }
  return lines.join("\n");
}

function renderMetadata(snapshot: SchemaSnapshot): string {
  return `// Generated by @askrjs/orm. Do not edit.\nexport const databaseMetadata = ${JSON.stringify(
    activeSnapshot(snapshot),
    null,
    2,
  )} as const;\n`;
}

function renderQueries(descriptions: readonly KeyedSqlDescription[]): string {
  const lines = ["// Generated by @askrjs/orm. Do not edit.", "export interface DatabaseQueries {"];
  for (const query of descriptions) {
    lines.push(`  readonly ${JSON.stringify(query.key)}: {`);
    lines.push("    readonly parameters: {");
    for (const parameter of query.parameters)
      lines.push(`      readonly ${JSON.stringify(parameter)}: unknown;`);
    lines.push("    };", "    readonly row: {");
    for (const column of query.columns) {
      lines.push(
        `      readonly ${JSON.stringify(column.name)}: ${tsType(column.dataType, column.nullable)};`,
      );
    }
    lines.push("    };", "  };");
  }
  lines.push("}", "");
  return lines.join("\n");
}

function renderMigrations(manifest: MigrationManifest): string {
  return `// Generated by @askrjs/orm. Do not edit.\nimport type { MigrationManifest } from "@askrjs/orm";\n\nexport const migrationManifest = ${JSON.stringify(
    manifest,
    null,
    2,
  )} as const satisfies MigrationManifest;\n`;
}

function generatedArtifacts(
  database: LoadedDatabase,
  snapshot: SchemaSnapshot,
  descriptions: readonly KeyedSqlDescription[],
  manifest: MigrationManifest,
): Readonly<Record<(typeof GENERATED_FILES)[number], string>> {
  return {
    "index.ts":
      '// Generated by @askrjs/orm. Do not edit.\nexport * from "./schema";\nexport * from "./metadata";\nexport * from "./queries";\nexport * from "./migrations";\n',
    "schema.ts": renderSchemaTypes(database),
    "metadata.ts": renderMetadata(snapshot),
    "queries.ts": renderQueries(descriptions),
    "migrations.ts": renderMigrations(manifest),
    "schema.snapshot.json": stableJson(activeSnapshot(snapshot)),
  };
}

async function replay(database: LoadedDatabase): Promise<{
  readonly scratch: DatabaseToolingAdapter;
  readonly manifest: MigrationManifest;
  readonly current: SchemaSnapshot;
}> {
  const scratch = await database.definition.scratch();
  if (
    database.definition.targetIdentity &&
    scratch.identity === database.definition.targetIdentity
  ) {
    await scratch.close?.();
    throw new Error("Scratch and target database identities are equal; refusing to reset target.");
  }
  if (
    database.definition.scratchIdentity &&
    scratch.identity !== database.definition.scratchIdentity
  ) {
    await scratch.close?.();
    throw new Error("Scratch adapter identity does not match configured scratchIdentity.");
  }
  const manifest = await readMigrations(database.databaseDir);
  try {
    await scratch.reset();
    for (const migration of manifest.migrations) await scratch.execute(migration.sql);
    const current = (await scratch.introspect()) as SchemaSnapshot;
    if (!current || current.version !== 1 || !Array.isArray(current.tables)) {
      throw new Error("Scratch introspection did not return an Askr SchemaSnapshot.");
    }
    return { scratch, manifest, current };
  } catch (error) {
    await scratch.close?.();
    throw error;
  }
}

async function writeArtifacts(
  database: LoadedDatabase,
  artifacts: ReturnType<typeof generatedArtifacts>,
): Promise<void> {
  const directory = path.join(database.databaseDir, "generated");
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(artifacts).map(([file, content]) =>
      fs.writeFile(path.join(directory, file), content, "utf8"),
    ),
  );
}

async function validateOne(database: LoadedDatabase): Promise<void> {
  const desired = activeSnapshot(snapshotDefinition(database.definition));
  const replayed = await replay(database);
  try {
    const actual = activeSnapshot(replayed.current);
    if (stableJson(actual) !== stableJson(desired)) {
      throw new Error("Migration history does not produce the TypeScript schema definition.");
    }
    const descriptions = await describeKeyedSql(database.projectRoot, replayed.scratch);
    const expected = generatedArtifacts(database, desired, descriptions, replayed.manifest);
    for (const [file, content] of Object.entries(expected)) {
      const target = path.join(database.databaseDir, "generated", file);
      const committed = await fs.readFile(target, "utf8").catch(() => null);
      if (committed !== content) {
        throw new Error(`Generated artifact database/generated/${file} is stale.`);
      }
    }
  } finally {
    await replayed.scratch.close?.();
  }
}

function migrationContents(
  id: string,
  parent: string | null,
  sqlText: string,
  transactional: boolean,
  risk: NonNullable<BundledMigration["risk"]>,
): string {
  return `-- askr:id ${id}\n-- askr:parent ${parent ?? "none"}\n-- askr:transactional ${transactional}\n-- askr:risk ${risk}\n\n${sqlText.trim()}\n`;
}

async function generateOne(database: LoadedDatabase): Promise<string | null> {
  const desired = snapshotDefinition(database.definition);
  const replayed = await replay(database);
  let created: string | null = null;
  try {
    const delta = diffSnapshots(replayed.current, desired);
    if (delta) {
      const id = ulid();
      const parent = replayed.manifest.migrations.at(-1)?.id ?? null;
      const risk = /\b(?:DROP|ALTER\s+TABLE.+TYPE)\b/i.test(delta) ? "destructive" : "safe";
      const content = migrationContents(id, parent, delta, true, risk);
      const directory = path.join(database.databaseDir, "migrations");
      await fs.mkdir(directory, { recursive: true });
      created = path.join(directory, `${id}.sql`);
      await fs.writeFile(created, content, "utf8");
      await replayed.scratch.execute(content);
    }
    const finalSnapshot = activeSnapshot((await replayed.scratch.introspect()) as SchemaSnapshot);
    if (stableJson(finalSnapshot) !== stableJson(activeSnapshot(desired))) {
      throw new Error("Generated migration did not produce the desired schema.");
    }
    const manifest = await readMigrations(database.databaseDir);
    const descriptions = await describeKeyedSql(database.projectRoot, replayed.scratch);
    await writeArtifacts(database, generatedArtifacts(database, desired, descriptions, manifest));
    return created;
  } catch (error) {
    if (created) await fs.unlink(created).catch(() => undefined);
    throw error;
  } finally {
    await replayed.scratch.close?.();
  }
}

async function refreshGenerated(database: LoadedDatabase): Promise<void> {
  const desired = activeSnapshot(snapshotDefinition(database.definition));
  const replayed = await replay(database);
  try {
    if (stableJson(activeSnapshot(replayed.current)) !== stableJson(desired)) {
      throw new Error(
        "Manual migration history does not produce the TypeScript schema definition.",
      );
    }
    const descriptions = await describeKeyedSql(database.projectRoot, replayed.scratch);
    await writeArtifacts(
      database,
      generatedArtifacts(database, desired, descriptions, replayed.manifest),
    );
  } finally {
    await replayed.scratch.close?.();
  }
}

async function createManualMigration(
  database: LoadedDatabase,
  transactional: boolean,
): Promise<string> {
  const manifest = await readMigrations(database.databaseDir);
  const id = ulid();
  const content = migrationContents(
    id,
    manifest.migrations.at(-1)?.id ?? null,
    "-- Write the forward-only data or DDL transition here.",
    transactional,
    "review",
  );
  const directory = path.join(database.databaseDir, "migrations");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.sql`);
  await fs.writeFile(file, content, "utf8");
  return file;
}

interface ParsedArgs {
  readonly command: readonly string[];
  readonly database?: string;
  readonly all: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly cwd: string;
  readonly nonTransactional: boolean;
  readonly resolution: "applied" | "rolled-back";
}

function parseArgs(args: readonly string[], defaultCwd: string): ParsedArgs {
  const command: string[] = [];
  let database: string | undefined;
  let all = false;
  let yes = false;
  let json = false;
  let cwd = defaultCwd;
  let nonTransactional = false;
  let resolution: "applied" | "rolled-back" = "applied";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--database") {
      database = args[++index];
      if (!database) throw new Error("--database requires a value.");
    } else if (value.startsWith("--database=")) database = value.slice(11);
    else if (value === "--all") all = true;
    else if (value === "--yes") yes = true;
    else if (value === "--json") json = true;
    else if (value === "--non-transactional") nonTransactional = true;
    else if (value === "--applied") resolution = "applied";
    else if (value === "--rolled-back") resolution = "rolled-back";
    else if (value === "--help" || value === "-h") command.push("help");
    else if (value === "--cwd") {
      const next = args[++index];
      if (!next) throw new Error("--cwd requires a value.");
      cwd = path.resolve(next);
    } else if (value.startsWith("--cwd=")) cwd = path.resolve(value.slice(6));
    else if (value.startsWith("-")) throw new Error(`Unknown option ${value}.`);
    else command.push(value);
  }
  return {
    command,
    ...(database === undefined ? {} : { database }),
    all,
    yes,
    json,
    cwd,
    nonTransactional,
    resolution,
  };
}

function helpText(): string {
  return `askr database - Generate, validate, and migrate Askr databases

Usage:
  askr database validate [--database <name>]
  askr database generate [--database <name>]
  askr database migration create [--database <name>] [--non-transactional]
  askr database migration status --database <name>
  askr database migration plan --database <name>
  askr database migration apply --database <name> [--yes]
  askr database migration resolve <id> --database <name> [--applied|--rolled-back]

Options:
  --all                 Select all configured databases explicitly
  --cwd <dir>           Resolve database/index.ts from another directory
  --json                Emit machine-readable output
  --yes                 Apply the displayed migration plan without prompting
`;
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question(`${message} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}

async function targetAdapter(database: LoadedDatabase): Promise<DatabaseAdapter> {
  const adapter = await database.definition.target();
  if (
    database.definition.scratchIdentity &&
    adapter.identity === database.definition.scratchIdentity
  ) {
    await adapter.close?.();
    throw new Error(
      "Target and scratch database identities are equal; refusing migration command.",
    );
  }
  return adapter;
}

export async function runDatabaseCli(
  args: readonly string[],
  options: RunDatabaseCliOptions = {},
): Promise<number> {
  const io = options.io ?? console;
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, options.cwd ?? process.cwd());
    if (
      parsed.command.length === 0 ||
      parsed.command[0] === "help" ||
      parsed.command[0] === "--help"
    ) {
      io.log(helpText().trimEnd());
      return 0;
    }
    const loaded = await loadDatabases(parsed.cwd);
    const action = parsed.command.join(" ");
    const migrationCommand = parsed.command[0] === "migration";
    const selected = selectDatabases(loaded, parsed.database, parsed.all, migrationCommand);
    const results: unknown[] = [];
    for (const database of selected) {
      if (action === "validate") {
        await validateOne(database);
        results.push({ database: database.name, status: "valid" });
      } else if (action === "generate") {
        const file = await generateOne(database);
        results.push({
          database: database.name,
          status: file ? "generated" : "unchanged",
          migration: file ? path.relative(database.projectRoot, file) : null,
        });
      } else if (action === "migration create") {
        const file = await createManualMigration(database, !parsed.nonTransactional);
        try {
          await refreshGenerated(database);
        } catch (error) {
          await fs.unlink(file).catch(() => undefined);
          throw error;
        }
        results.push({
          database: database.name,
          status: "created",
          migration: path.relative(database.projectRoot, file),
        });
      } else if (
        action === "migration status" ||
        action === "migration plan" ||
        action === "migration apply"
      ) {
        const adapter = await targetAdapter(database);
        try {
          const manifest = await readMigrations(database.databaseDir);
          const client = (await import("./migrations")).createMigrationsApi(adapter, manifest);
          const plan = await client.plan();
          if (action === "migration apply") {
            if (!parsed.json) {
              io.log(
                `${database.name}: ${plan.pending.length} pending migration(s)\n${plan.pending
                  .map(
                    (entry) =>
                      `  ${entry.id} [${entry.risk ?? "review"}] ${entry.transactional ? "transactional" : "NON-TRANSACTIONAL"}`,
                  )
                  .join("\n")}`,
              );
            }
            if (
              plan.pending.length > 0 &&
              !parsed.yes &&
              !(await (options.confirm ?? defaultConfirm)("Apply this exact migration plan?"))
            ) {
              throw new Error("Migration apply cancelled.");
            }
            const applied = await client.apply();
            results.push({ database: database.name, status: "applied", ...applied });
          } else {
            results.push({ database: database.name, status: "planned", plan });
          }
        } finally {
          await adapter.close?.();
        }
      } else if (parsed.command[0] === "migration" && parsed.command[1] === "resolve") {
        const id = parsed.command[2];
        if (!id) throw new Error("migration resolve requires an id.");
        const resolution = parsed.resolution;
        const adapter = await targetAdapter(database);
        try {
          const manifest = await readMigrations(database.databaseDir);
          const client = (await import("./migrations")).createMigrationsApi(adapter, manifest);
          await client.resolve(id, resolution);
          results.push({ database: database.name, status: "resolved", id, resolution });
        } finally {
          await adapter.close?.();
        }
      } else {
        throw new Error(`Unknown database command: ${action}`);
      }
    }
    if (parsed.json) io.log(JSON.stringify({ status: "ok", results }));
    else {
      for (const result of results) {
        const value = result as Record<string, unknown>;
        if (value.plan) {
          const plan = value.plan as {
            pending: readonly BundledMigration[];
            applied: readonly unknown[];
          };
          io.log(
            `${value.database}: ${plan.applied.length} applied, ${plan.pending.length} pending`,
          );
        } else {
          io.log(
            `${value.database}: ${value.status}${value.migration ? ` (${value.migration})` : ""}`,
          );
        }
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.error(
      args.includes("--json") ? JSON.stringify({ status: "error", error: message }) : message,
    );
    return 1;
  }
}

export async function hasDatabaseEntry(cwd: string): Promise<boolean> {
  return findDatabaseEntry(cwd).then(
    () => true,
    () => false,
  );
}

export async function validateDiscoveredDatabase(cwd: string): Promise<{
  readonly status: "passed" | "failed";
  readonly stdout: string;
  readonly stderr: string;
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runDatabaseCli(["validate", "--cwd", cwd], {
    cwd,
    io: {
      log: (value = "") => logs.push(String(value)),
      error: (value = "") => errors.push(String(value)),
    },
  });
  return {
    status: code === 0 ? "passed" : "failed",
    stdout: logs.join("\n"),
    stderr: errors.join("\n"),
  };
}
