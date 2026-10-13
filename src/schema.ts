import { quoteIdentifier, toSnakeCase } from "./naming";

/** Bidirectional converter between a column's stored (database) and application-facing value. */
export interface Codec<Database, Application> {
  readonly name: string;
  encode(value: Application): Database;
  decode(value: Database): Application;
  readonly typeScriptType?: string;
}

/** Target of a column's `references()` foreign key. */
export interface ColumnReference {
  readonly schema?: string;
  readonly table: string;
  readonly column: string;
}

/** Serializable description of a column's shape, produced by {@link ColumnBuilder}. */
export interface ColumnAst {
  readonly property: string;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly default?: string;
  readonly generated?: string;
  readonly references?: () => AnyColumn;
  readonly codec?: Codec<unknown, unknown>;
  readonly renamedFrom?: string;
  readonly dialect?: "postgres" | "sqlite";
  readonly convertUsing?: string;
}

declare const columnType: unique symbol;
declare const columnNotNull: unique symbol;
declare const columnHasDefault: unique symbol;
declare const columnPrimary: unique symbol;

/**
 * Immutable, chainable builder for a table column's definition. Each method returns a new
 * builder reflecting the change; built via the type-specific factories (e.g. {@link text},
 * {@link integer}, {@link uuid}) exported from this module.
 */
export class ColumnBuilder<
  T,
  NotNull extends boolean = false,
  HasDefault extends boolean = false,
  Primary extends boolean = false,
> {
  declare readonly [columnType]: T;
  declare readonly [columnNotNull]: NotNull;
  declare readonly [columnHasDefault]: HasDefault;
  declare readonly [columnPrimary]: Primary;
  readonly ast: Omit<ColumnAst, "property">;

  constructor(ast: Omit<ColumnAst, "property">) {
    this.ast = ast;
  }

  private copy<
    N extends boolean = NotNull,
    D extends boolean = HasDefault,
    P extends boolean = Primary,
  >(patch: Partial<Omit<ColumnAst, "property">>): ColumnBuilder<T, N, D, P> {
    return new ColumnBuilder<T, N, D, P>({ ...this.ast, ...patch });
  }

  /** Overrides the underlying SQL column name (defaults to the property's snake_case form). */
  name(name: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ name });
  }

  /** Marks the column `NOT NULL`. */
  notNull(): ColumnBuilder<T, true, HasDefault, Primary> {
    return this.copy<true>({ nullable: false });
  }

  /** Marks the column as (part of) the table's primary key; implies `notNull()`. */
  primaryKey(): ColumnBuilder<T, true, HasDefault, true> {
    return this.copy<true, HasDefault, true>({ primaryKey: true, nullable: false });
  }

  /** Adds a single-column `UNIQUE` constraint. */
  unique(): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ unique: true });
  }

  /** Sets a raw SQL default expression for the column. */
  default(expression: string): ColumnBuilder<T, NotNull, true, Primary> {
    return this.copy<NotNull, true, Primary>({ default: expression });
  }

  /** Sets the default to `CURRENT_TIMESTAMP`. */
  defaultNow(): ColumnBuilder<T, NotNull, true, Primary> {
    return this.default("CURRENT_TIMESTAMP");
  }

  /** Sets the default to `gen_random_uuid()`. PostgreSQL only. */
  defaultRandom(): ColumnBuilder<T, NotNull, true, Primary> {
    return new ColumnBuilder<T, NotNull, true, Primary>({
      ...this.ast,
      default: "gen_random_uuid()",
      dialect: "postgres",
    });
  }

  /** Marks the column as a generated column with the given SQL expression. */
  generatedAlwaysAs(expression: string): ColumnBuilder<T, NotNull, true, Primary> {
    return this.copy<NotNull, true, Primary>({ generated: expression });
  }

  /** Declares a foreign key to another table's column, given as a thunk to avoid circular references. */
  references(target: () => AnyColumn): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ references: target });
  }

  /** Applies a {@link Codec} to convert between the stored value and an application-facing type. */
  mapWith<Application>(
    codec: Codec<T, Application>,
  ): ColumnBuilder<Application, NotNull, HasDefault, Primary> {
    return new ColumnBuilder<Application, NotNull, HasDefault, Primary>({
      ...this.ast,
      codec: codec as Codec<unknown, unknown>,
    });
  }

  /** Records the column's previous SQL name, so migration codegen can generate a rename instead of a drop/add. */
  renamedFrom(name: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ renamedFrom: name });
  }

  /** Sets a `USING` expression for converting existing data when the column's type changes. */
  convertUsing(expression: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ convertUsing: expression });
  }
}

/** A {@link ColumnBuilder} of any value/nullability/default/primary-key combination. */
export type AnyColumn = ColumnBuilder<unknown, boolean, boolean, boolean>;
/** The application-facing value type of a column, `| null` unless it is `notNull()`. */
export type ColumnValue<C> =
  C extends ColumnBuilder<infer T, infer N, boolean, boolean>
    ? N extends true
      ? T
      : T | null
    : never;
type RequiredInsertKeys<C extends Record<string, AnyColumn>> = {
  [K in keyof C]: C[K] extends ColumnBuilder<unknown, true, false> ? K : never;
}[keyof C];
type OptionalInsertKeys<C extends Record<string, AnyColumn>> = Exclude<
  keyof C,
  RequiredInsertKeys<C>
>;

/** Table-level `CHECK (expression)` constraint, built via {@link check}. */
export interface CheckConstraint {
  readonly kind: "check";
  readonly name?: string;
  readonly expression: string;
}

/** Table-level `UNIQUE (columns...)` constraint, built via {@link unique}. */
export interface UniqueConstraint {
  readonly kind: "unique";
  readonly name?: string;
  readonly columns: readonly string[];
}

/** Table-level index definition, built via {@link index}. */
export interface IndexDefinition {
  readonly kind: "index";
  readonly name?: string;
  readonly expressions: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
  readonly method?: string;
}

/** A single table-level constraint passed via {@link TableOptions.constraints}. */
export type TableConstraint = CheckConstraint | UniqueConstraint | IndexDefinition;

/** Options accepted by {@link table}. */
export interface TableOptions {
  readonly schema?: string;
  readonly renamedFrom?: string;
  readonly constraints?: readonly TableConstraint[];
}

/** Result of {@link table}: the columns plus table metadata (`$name`, `$schema`, etc). */
export type TableDefinition<C extends Record<string, AnyColumn>, Name extends string = string> = {
  readonly [K in keyof C]: C[K];
} & {
  readonly $kind: "table";
  readonly $name: Name;
  readonly $schema: string;
  readonly $columns: C;
  readonly $options: TableOptions;
};

/** A {@link TableDefinition} of any columns/name, used for generic table-accepting APIs. */
export interface AnyTable {
  readonly $kind: "table";
  readonly $name: string;
  readonly $schema: string;
  readonly $columns: Record<string, AnyColumn>;
  readonly $options: TableOptions;
}
/** Row shape returned by reads against a table. */
export type InferRow<T extends AnyTable> = Readonly<{
  [K in keyof T["$columns"]]: ColumnValue<T["$columns"][K]>;
}>;
/** Input shape accepted by inserts: columns without a default are required, others optional. */
export type InferInsert<T extends AnyTable> = Readonly<
  {
    [K in RequiredInsertKeys<T["$columns"]>]: ColumnValue<T["$columns"][K]>;
  } & {
    [K in OptionalInsertKeys<T["$columns"]>]?: Exclude<ColumnValue<T["$columns"][K]>, null> | null;
  }
>;
/** Input shape accepted by updates: all non-primary-key columns, all optional. */
export type InferPatch<T extends AnyTable> = Readonly<
  Partial<{
    [
      K in keyof T["$columns"] as T["$columns"][K] extends ColumnBuilder<
        unknown,
        boolean,
        boolean,
        true
      >
        ? never
        : K
    ]: ColumnValue<T["$columns"][K]>;
  }>
>;
/** Primary key shape for a table: just its primary-key column(s). */
export type InferKey<T extends AnyTable> = Readonly<{
  [
    K in keyof T["$columns"] as T["$columns"][K] extends ColumnBuilder<
      unknown,
      boolean,
      boolean,
      true
    >
      ? K
      : never
  ]: ColumnValue<T["$columns"][K]>;
}>;

function column<T>(dataType: string): ColumnBuilder<T> {
  return new ColumnBuilder<T>({
    name: "",
    dataType,
    nullable: true,
    primaryKey: false,
    unique: false,
  });
}

/** Defines a `uuid` column. */
export const uuid = (): ColumnBuilder<string> => column<string>("uuid");
/** Defines a `text` column. */
export const text = (): ColumnBuilder<string> => column<string>("text");
/** Defines a `boolean` column. */
export const boolean = (): ColumnBuilder<boolean> => column<boolean>("boolean");
/** Defines an `integer` column. */
export const integer = (): ColumnBuilder<number> => column<number>("integer");
/** Defines a `bigint` column. */
export const bigInt = (): ColumnBuilder<bigint> => column<bigint>("bigint");
/** Defines a `real` (single-precision float) column. */
export const real = (): ColumnBuilder<number> => column<number>("real");
/** Defines a `double precision` column. */
export const doublePrecision = (): ColumnBuilder<number> => column<number>("double precision");
/** Defines a `numeric` column, optionally with precision and scale. */
export const numeric = (precision?: number, scale?: number): ColumnBuilder<string> =>
  column<string>(
    precision === undefined
      ? "numeric"
      : `numeric(${precision}${scale === undefined ? "" : `,${scale}`})`,
  );
/** Defines a `json` column. */
export const json = <T = unknown>(): ColumnBuilder<T> => column<T>("json");
/** Defines a `jsonb` column. PostgreSQL only. */
export const jsonb = <T = unknown>(): ColumnBuilder<T> =>
  new ColumnBuilder<T>({ ...column<T>("jsonb").ast, dialect: "postgres" });
/** Defines a `date` column. */
export const date = (): ColumnBuilder<string> => column<string>("date");
/** Defines a `timestamp without time zone` column. */
export const timestamp = (): ColumnBuilder<string> => column<string>("timestamp without time zone");
/** Defines a `timestamp with time zone` column. PostgreSQL only. */
export const timestampTz = (): ColumnBuilder<string> =>
  new ColumnBuilder<string>({
    ...column<string>("timestamp with time zone").ast,
    dialect: "postgres",
  });
/** Defines a raw binary column. */
export const bytes = (): ColumnBuilder<Uint8Array> => column<Uint8Array>("bytes");
/** Defines a `bytea` column. PostgreSQL only. */
export const bytea = (): ColumnBuilder<Uint8Array> =>
  new ColumnBuilder<Uint8Array>({ ...column<Uint8Array>("bytea").ast, dialect: "postgres" });
/** Defines a column with an arbitrary PostgreSQL-only type name. */
export const postgresType = <T>(name: string): ColumnBuilder<T> =>
  new ColumnBuilder<T>({ ...column<T>(name).ast, dialect: "postgres" });

/** Result of {@link postgresEnum}: a PostgreSQL enum type usable as a column via `.column()`. */
export interface EnumDefinition<V extends string> {
  readonly kind: "enum";
  readonly name: string;
  readonly schema: string;
  readonly values: readonly V[];
  column(): ColumnBuilder<V>;
}

/** Declares a PostgreSQL enum type with the given values, for use as a column type. */
export function postgresEnum<const V extends readonly [string, ...string[]]>(
  name: string,
  values: V,
  options: { readonly schema?: string } = {},
): EnumDefinition<V[number]> {
  const schema = options.schema ?? "public";
  return {
    kind: "enum",
    name,
    schema,
    values,
    column: () => column<V[number]>(`${quoteIdentifier(schema)}.${quoteIdentifier(name)}`),
  };
}

/**
 * Declares a table from its columns, defaulting each column's SQL name to the snake_case form
 * of its property name.
 */
export function table<const Name extends string, const C extends Record<string, AnyColumn>>(
  name: Name,
  columns: C,
  options: TableOptions = {},
): TableDefinition<C, Name> {
  const normalized = Object.fromEntries(
    Object.entries(columns).map(([property, value]) => [
      property,
      new ColumnBuilder({
        ...value.ast,
        name: value.ast.name || toSnakeCase(property),
      }),
    ]),
  ) as C;
  return Object.assign({}, normalized, {
    $kind: "table" as const,
    $name: name,
    $schema: options.schema ?? "public",
    $columns: normalized,
    $options: options,
  });
}

/** Builds a table-level `CHECK` constraint for {@link TableOptions.constraints}. */
export const check = (expression: string, name?: string): CheckConstraint => ({
  kind: "check",
  expression,
  ...(name === undefined ? {} : { name }),
});

/** Builds a table-level `UNIQUE` constraint over one or more columns. */
export const unique = (columns: readonly string[], name?: string): UniqueConstraint => ({
  kind: "unique",
  columns,
  ...(name === undefined ? {} : { name }),
});

/** Builds an index definition over one or more expressions. */
export const index = (
  expressions: readonly string[],
  options: Omit<IndexDefinition, "kind" | "expressions" | "unique"> & {
    readonly unique?: boolean;
  } = {},
): IndexDefinition => ({
  kind: "index",
  expressions,
  unique: options.unique ?? false,
  ...(options.name === undefined ? {} : { name: options.name }),
  ...(options.where === undefined ? {} : { where: options.where }),
  ...(options.method === undefined ? {} : { method: options.method }),
});

/** Result of {@link view}: a named SQL `SELECT` exposed as a view. */
export interface ViewDefinition {
  readonly kind: "view";
  readonly name: string;
  readonly schema: string;
  readonly query: string;
}

/** Declares a database view backed by a raw SQL query. */
export function view(
  name: string,
  query: string,
  options: { readonly schema?: string } = {},
): ViewDefinition {
  return { kind: "view", name, schema: options.schema ?? "public", query };
}
