import { toSnakeCase } from "./naming";

export interface Codec<Database, Application> {
  readonly name: string;
  encode(value: Application): Database;
  decode(value: Database): Application;
  readonly typeScriptType?: string;
}

export interface ColumnReference {
  readonly schema?: string;
  readonly table: string;
  readonly column: string;
}

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
  readonly drop?: boolean;
  readonly convertUsing?: string;
}

declare const columnType: unique symbol;
declare const columnNotNull: unique symbol;
declare const columnHasDefault: unique symbol;
declare const columnPrimary: unique symbol;

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

  name(name: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ name });
  }

  notNull(): ColumnBuilder<T, true, HasDefault, Primary> {
    return this.copy<true>({ nullable: false });
  }

  primaryKey(): ColumnBuilder<T, true, HasDefault, true> {
    return this.copy<true, HasDefault, true>({ primaryKey: true, nullable: false });
  }

  unique(): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ unique: true });
  }

  default(expression: string): ColumnBuilder<T, NotNull, true, Primary> {
    return this.copy<NotNull, true, Primary>({ default: expression });
  }

  defaultNow(): ColumnBuilder<T, NotNull, true, Primary> {
    return this.default("CURRENT_TIMESTAMP");
  }

  defaultRandom(): ColumnBuilder<T, NotNull, true, Primary> {
    return this.default("gen_random_uuid()");
  }

  generatedAlwaysAs(expression: string): ColumnBuilder<T, NotNull, true, Primary> {
    return this.copy<NotNull, true, Primary>({ generated: expression });
  }

  references(target: () => AnyColumn): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ references: target });
  }

  mapWith<Application>(
    codec: Codec<T, Application>,
  ): ColumnBuilder<Application, NotNull, HasDefault, Primary> {
    return new ColumnBuilder<Application, NotNull, HasDefault, Primary>({
      ...this.ast,
      codec: codec as Codec<unknown, unknown>,
    });
  }

  renamedFrom(name: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ renamedFrom: name });
  }

  drop(): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ drop: true });
  }

  convertUsing(expression: string): ColumnBuilder<T, NotNull, HasDefault, Primary> {
    return this.copy({ convertUsing: expression });
  }
}

export type AnyColumn = ColumnBuilder<unknown, boolean, boolean, boolean>;
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

export interface CheckConstraint {
  readonly kind: "check";
  readonly name?: string;
  readonly expression: string;
}

export interface UniqueConstraint {
  readonly kind: "unique";
  readonly name?: string;
  readonly columns: readonly string[];
}

export interface IndexDefinition {
  readonly kind: "index";
  readonly name?: string;
  readonly expressions: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
  readonly method?: string;
}

export type TableConstraint = CheckConstraint | UniqueConstraint | IndexDefinition;

export interface TableOptions {
  readonly schema?: string;
  readonly renamedFrom?: string;
  readonly drop?: boolean;
  readonly constraints?: readonly TableConstraint[];
}

export type TableDefinition<C extends Record<string, AnyColumn>, Name extends string = string> = {
  readonly [K in keyof C]: C[K];
} & {
  readonly $kind: "table";
  readonly $name: Name;
  readonly $schema: string;
  readonly $columns: C;
  readonly $options: TableOptions;
};

export interface AnyTable {
  readonly $kind: "table";
  readonly $name: string;
  readonly $schema: string;
  readonly $columns: Record<string, AnyColumn>;
  readonly $options: TableOptions;
}
export type InferRow<T extends AnyTable> = Readonly<{
  [K in keyof T["$columns"]]: ColumnValue<T["$columns"][K]>;
}>;
export type InferInsert<T extends AnyTable> = Readonly<
  {
    [K in RequiredInsertKeys<T["$columns"]>]: ColumnValue<T["$columns"][K]>;
  } & {
    [K in OptionalInsertKeys<T["$columns"]>]?: Exclude<ColumnValue<T["$columns"][K]>, null> | null;
  }
>;
export type InferPatch<T extends AnyTable> = Readonly<
  Partial<{
    [K in keyof T["$columns"]]: ColumnValue<T["$columns"][K]>;
  }>
>;
export type InferKey<T extends AnyTable> = Readonly<{
  [K in keyof T["$columns"] as T["$columns"][K] extends ColumnBuilder<
    unknown,
    boolean,
    boolean,
    true
  >
    ? K
    : never]: ColumnValue<T["$columns"][K]>;
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

export const uuid = (): ColumnBuilder<string> => column<string>("uuid");
export const text = (): ColumnBuilder<string> => column<string>("text");
export const boolean = (): ColumnBuilder<boolean> => column<boolean>("boolean");
export const integer = (): ColumnBuilder<number> => column<number>("integer");
export const bigInt = (): ColumnBuilder<bigint> => column<bigint>("bigint");
export const real = (): ColumnBuilder<number> => column<number>("real");
export const doublePrecision = (): ColumnBuilder<number> => column<number>("double precision");
export const numeric = (precision?: number, scale?: number): ColumnBuilder<string> =>
  column<string>(
    precision === undefined
      ? "numeric"
      : `numeric(${precision}${scale === undefined ? "" : `,${scale}`})`,
  );
export const json = <T = unknown>(): ColumnBuilder<T> => column<T>("json");
export const jsonb = <T = unknown>(): ColumnBuilder<T> => column<T>("jsonb");
export const date = (): ColumnBuilder<string> => column<string>("date");
export const timestamp = (): ColumnBuilder<string> => column<string>("timestamp without time zone");
export const timestampTz = (): ColumnBuilder<string> => column<string>("timestamp with time zone");
export const bytea = (): ColumnBuilder<Uint8Array> => column<Uint8Array>("bytea");
export const postgresType = <T>(name: string): ColumnBuilder<T> => column<T>(name);

export interface EnumDefinition<V extends string> {
  readonly kind: "enum";
  readonly name: string;
  readonly schema: string;
  readonly values: readonly V[];
  column(): ColumnBuilder<V>;
}

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
    column: () => column<V[number]>(`${schema}.${name}`),
  };
}

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

export const check = (expression: string, name?: string): CheckConstraint => ({
  kind: "check",
  expression,
  ...(name === undefined ? {} : { name }),
});

export const unique = (columns: readonly string[], name?: string): UniqueConstraint => ({
  kind: "unique",
  columns,
  ...(name === undefined ? {} : { name }),
});

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

export interface ViewDefinition {
  readonly kind: "view";
  readonly name: string;
  readonly schema: string;
  readonly query: string;
}

export function view(
  name: string,
  query: string,
  options: { readonly schema?: string } = {},
): ViewDefinition {
  return { kind: "view", name, schema: options.schema ?? "public", query };
}
