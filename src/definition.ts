import type { DatabaseAdapter, DatabaseDriver, DatabaseOpenOptions } from "./adapter";
import { createDatabaseClient, type DatabaseClient } from "./client";
import type { MigrationManifest } from "./migrations";
import type { AnyTable, EnumDefinition, ViewDefinition } from "./schema";
import type { RegisteredQuery } from "./registered-query";

export interface DatabaseToolingAdapter {
  readonly identity: string;
  reset(): Promise<void>;
  execute(sql: string): Promise<void>;
  introspect(): Promise<unknown>;
  describe(
    sql: string,
    parameterNames: readonly string[],
  ): Promise<{
    readonly parameters: readonly string[];
    readonly columns: readonly {
      readonly name: string;
      readonly dataType: string;
      readonly nullable: boolean;
    }[];
  }>;
  close?(): Promise<void>;
}

export interface DatabaseDefinition<
  T extends Record<string, AnyTable>,
  Q extends Record<string, RegisteredQuery<Record<string, unknown>>> = Record<never, never>,
> {
  readonly kind: "database";
  readonly tables: T;
  readonly dialect: DatabaseDriver["dialect"];
  readonly queries: Q;
  readonly enums: readonly EnumDefinition<string>[];
  readonly views: readonly ViewDefinition[];
  readonly targetIdentity?: string;
  readonly scratchIdentity?: string;
  readonly target: () => Promise<DatabaseAdapter>;
  readonly scratch: () => Promise<DatabaseToolingAdapter>;
  readonly manifest?: MigrationManifest;
  open(target?: "target", options?: DatabaseOpenOptions): Promise<DatabaseClient<T, Q>>;
}

export interface GeneratedDatabaseArtifact {
  readonly schemaIdentity?: string;
  readonly manifest?: MigrationManifest;
  readonly queries?: Readonly<Record<string, unknown>>;
}

export interface CleanDatabaseOptions<
  T extends Record<string, AnyTable>,
  Q extends Record<string, RegisteredQuery<Record<string, unknown>>> = Record<never, never>,
> {
  readonly driver: DatabaseDriver;
  readonly tables: T;
  readonly queries?: Q;
  readonly generated?: GeneratedDatabaseArtifact;
  readonly enums?: readonly EnumDefinition<string>[];
  readonly views?: readonly ViewDefinition[];
}

export function defineDatabase<
  const T extends Record<string, AnyTable>,
  const Q extends Record<string, RegisteredQuery<Record<string, unknown>>> = Record<never, never>,
>(options: CleanDatabaseOptions<T, Q>): DatabaseDefinition<T, Q> {
  assertDialectCompatibility(options.driver.dialect, options.tables, options.enums ?? []);
  const queries = options.queries ?? ({} as Q);
  return {
    kind: "database",
    dialect: options.driver.dialect,
    tables: options.tables,
    queries,
    enums: options.enums ?? [],
    views: options.views ?? [],
    ...(options.driver.targetIdentity === undefined
      ? {}
      : { targetIdentity: options.driver.targetIdentity }),
    ...(options.driver.shadowIdentity === undefined
      ? {}
      : { scratchIdentity: options.driver.shadowIdentity }),
    target: () => options.driver.open(),
    scratch: () => options.driver.shadow(),
    ...(options.generated?.manifest === undefined ? {} : { manifest: options.generated.manifest }),
    async open(_target = "target", openOptions = {}) {
      return createDatabaseClient(
        options.tables,
        await options.driver.open(),
        options.generated?.manifest,
        openOptions,
        queries,
      );
    },
  };
}

function assertDialectCompatibility(
  dialect: DatabaseDriver["dialect"],
  tables: Record<string, AnyTable>,
  enums: readonly EnumDefinition<string>[],
): void {
  if (dialect === "sqlite" && enums.length > 0) {
    throw new Error("PostgreSQL enums cannot be used by a SQLite database definition.");
  }
  for (const table of Object.values(tables)) {
    for (const column of Object.values(table.$columns)) {
      if (column.ast.dialect && column.ast.dialect !== dialect) {
        throw new Error(
          `${table.$name}.${column.ast.name} requires the ${column.ast.dialect} dialect.`,
        );
      }
    }
  }
}
