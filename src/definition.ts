import type { DatabaseAdapter, DatabaseOpenOptions } from "./adapter";
import { createDatabaseClient, type DatabaseClient } from "./client";
import type { MigrationManifest } from "./migrations";
import type { AnyTable, EnumDefinition, ViewDefinition } from "./schema";

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

export interface DatabaseDefinition<T extends Record<string, AnyTable>> {
  readonly kind: "database";
  readonly tables: T;
  readonly enums: readonly EnumDefinition<string>[];
  readonly views: readonly ViewDefinition[];
  readonly targetIdentity?: string;
  readonly scratchIdentity?: string;
  readonly target: () => Promise<DatabaseAdapter>;
  readonly scratch: () => Promise<DatabaseToolingAdapter>;
  readonly manifest?: MigrationManifest;
  open(target?: "target", options?: DatabaseOpenOptions): Promise<DatabaseClient<T>>;
}

export interface DefineDatabaseOptions<T extends Record<string, AnyTable>> {
  readonly tables: T;
  readonly enums?: readonly EnumDefinition<string>[];
  readonly views?: readonly ViewDefinition[];
  readonly targetIdentity?: string;
  readonly scratchIdentity?: string;
  readonly target: () => Promise<DatabaseAdapter>;
  readonly scratch: () => Promise<DatabaseToolingAdapter>;
  readonly manifest?: MigrationManifest;
}

export function database<T extends Record<string, AnyTable>>(
  options: DefineDatabaseOptions<T>,
): DatabaseDefinition<T> {
  return {
    kind: "database",
    tables: options.tables,
    enums: options.enums ?? [],
    views: options.views ?? [],
    ...(options.targetIdentity === undefined ? {} : { targetIdentity: options.targetIdentity }),
    ...(options.scratchIdentity === undefined ? {} : { scratchIdentity: options.scratchIdentity }),
    target: options.target,
    scratch: options.scratch,
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    async open(_target = "target", openOptions = {}) {
      return createDatabaseClient(
        options.tables,
        await options.target(),
        options.manifest,
        openOptions,
      );
    },
  };
}

export interface DatabaseRegistry<
  T extends Record<string, DatabaseDefinition<Record<string, AnyTable>>>,
> {
  readonly kind: "database-registry";
  readonly databases: T;
  open<K extends keyof T>(name: K, options?: DatabaseOpenOptions): ReturnType<T[K]["open"]>;
}

export function databases<
  const T extends Record<string, DatabaseDefinition<Record<string, AnyTable>>>,
>(definitions: T): DatabaseRegistry<T> {
  return {
    kind: "database-registry",
    databases: definitions,
    open(name, options) {
      const definition = definitions[name];
      if (!definition) throw new Error(`Unknown database ${String(name)}.`);
      return definition.open("target", options) as ReturnType<T[typeof name]["open"]>;
    },
  };
}
