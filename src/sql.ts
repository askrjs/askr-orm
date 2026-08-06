import { quoteIdentifier } from "./naming";
import type { DatabaseAdapter, QueryOptions } from "./adapter";
import { normalizeDatabaseError } from "./errors";
import type { AnyTable } from "./schema";

const SQL_FRAGMENT = Symbol("askr.sql.fragment");

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface SqlFragment<T = unknown> {
  readonly [SQL_FRAGMENT]: true;
  readonly chunks: readonly SqlChunk[];
  readonly resultType?: T;
}

type SqlChunk =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "parameter"; readonly value: unknown }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "fragment"; readonly value: SqlFragment };

export interface KeyedSql<TParameters extends Record<string, unknown>, TResult> {
  readonly kind: "keyed-sql";
  readonly key: string;
  readonly source: string;
  readonly parameters: TParameters;
  readonly result?: TResult;
}

export interface UnsafeSql {
  readonly kind: "unsafe-sql";
  readonly text: string;
}

function fragment<T = unknown>(chunks: readonly SqlChunk[]): SqlFragment<T> {
  return { [SQL_FRAGMENT]: true, chunks };
}

function isFragment(value: unknown): value is SqlFragment {
  return Boolean(
    value &&
    typeof value === "object" &&
    SQL_FRAGMENT in value &&
    (value as SqlFragment)[SQL_FRAGMENT],
  );
}

export function identifier(name: string): SqlFragment {
  return fragment([{ kind: "identifier", value: name }]);
}

export function literal(value: string | number | boolean | null): SqlFragment {
  if (typeof value === "string") {
    return fragment([{ kind: "text", value: `'${value.replaceAll("'", "''")}'` }]);
  }
  if (value === null) return fragment([{ kind: "text", value: "NULL" }]);
  return fragment([{ kind: "text", value: String(value) }]);
}

export function unsafeSql(text: string): UnsafeSql {
  return { kind: "unsafe-sql", text };
}

function sqlTag<T = unknown>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): SqlFragment<T> {
  const chunks: SqlChunk[] = [];
  strings.forEach((text, index) => {
    if (text) chunks.push({ kind: "text", value: text });
    if (index >= values.length) return;
    const value = values[index];
    if (isFragment(value)) chunks.push({ kind: "fragment", value });
    else if (value && typeof value === "object" && (value as UnsafeSql).kind === "unsafe-sql") {
      chunks.push({ kind: "text", value: (value as UnsafeSql).text });
    } else {
      chunks.push({ kind: "parameter", value });
    }
  });
  return fragment<T>(chunks);
}

interface SqlTag {
  <T = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment<T>;
  readonly identifier: (name: string) => SqlFragment;
  readonly literal: (value: string | number | boolean | null) => SqlFragment;
  readonly unsafe: (text: string) => UnsafeSql;
  readonly key: <TParameters extends Record<string, unknown>, TResult = unknown>(
    keyValue: string,
    parameters: TParameters,
  ) => (strings: TemplateStringsArray) => KeyedSql<TParameters, TResult>;
}

function keyedSql<TParameters extends Record<string, unknown>, TResult = unknown>(
  keyValue: string,
  parameters: TParameters,
): (strings: TemplateStringsArray) => KeyedSql<TParameters, TResult> {
  if (!/^[a-z][a-z0-9_.-]*$/i.test(keyValue)) {
    throw new Error(`Invalid keyed SQL key: ${keyValue}`);
  }
  return (strings: TemplateStringsArray): KeyedSql<TParameters, TResult> => {
    if (strings.length !== 1) {
      throw new Error(
        "Keyed SQL has a static shape: interpolate named :parameters in the SQL text.",
      );
    }
    return {
      kind: "keyed-sql",
      key: keyValue,
      source: strings[0] ?? "",
      parameters,
    };
  };
}

export const sql: SqlTag = Object.assign(sqlTag, {
  identifier,
  literal,
  unsafe: unsafeSql,
  key: keyedSql,
});

export function compileSql(value: SqlFragment): SqlQuery {
  const values: unknown[] = [];
  let text = "";
  const append = (input: SqlFragment): void => {
    for (const chunk of input.chunks) {
      if (chunk.kind === "text") text += chunk.value;
      else if (chunk.kind === "identifier") text += quoteIdentifier(chunk.value);
      else if (chunk.kind === "parameter") {
        values.push(chunk.value);
        text += `$${values.length}`;
      } else append(chunk.value);
    }
  };
  append(value);
  return { text, values };
}

export interface ColumnRef<T = unknown> {
  readonly kind: "column-ref";
  readonly tableAlias: string;
  readonly columnName: string;
  readonly value?: T;
}

export type Expression<T = unknown> = SqlFragment<T> | ColumnRef<T>;

export function columnRef<T>(tableAlias: string, columnName: string): ColumnRef<T> {
  return { kind: "column-ref", tableAlias, columnName };
}

function expressionSql(value: Expression | unknown): SqlFragment {
  if (isFragment(value)) return value;
  if (value && typeof value === "object" && (value as ColumnRef).kind === "column-ref") {
    const ref = value as ColumnRef;
    return fragment([
      { kind: "identifier", value: ref.tableAlias },
      { kind: "text", value: "." },
      { kind: "identifier", value: ref.columnName },
    ]);
  }
  return fragment([{ kind: "parameter", value }]);
}

function binary<T>(
  left: Expression<T>,
  operator: string,
  right: Expression<T> | T,
): SqlFragment<boolean> {
  return sql<boolean>`${expressionSql(left)} ${sql.unsafe(operator)} ${expressionSql(right)}`;
}

export const eq = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "=", right);
export const ne = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<>", right);
export const gt = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, ">", right);
export const gte = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, ">=", right);
export const lt = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<", right);
export const lte = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<=", right);
export const like = (left: Expression<string>, pattern: string): SqlFragment<boolean> =>
  binary(left, "LIKE", pattern);
export const ilike = (left: Expression<string>, pattern: string): SqlFragment<boolean> =>
  binary(left, "ILIKE", pattern);
export const isNull = (value: Expression): SqlFragment<boolean> =>
  sql<boolean>`${expressionSql(value)} IS NULL`;
export const isNotNull = (value: Expression): SqlFragment<boolean> =>
  sql<boolean>`${expressionSql(value)} IS NOT NULL`;

export function and(...predicates: readonly SqlFragment<boolean>[]): SqlFragment<boolean> {
  return joinFragments(predicates, " AND ", true) as SqlFragment<boolean>;
}

export function or(...predicates: readonly SqlFragment<boolean>[]): SqlFragment<boolean> {
  return joinFragments(predicates, " OR ", true) as SqlFragment<boolean>;
}

export function not(predicate: SqlFragment<boolean>): SqlFragment<boolean> {
  return sql<boolean>`NOT (${predicate})`;
}

export function inArray<T>(value: Expression<T>, values: readonly T[]): SqlFragment<boolean> {
  if (values.length === 0) return sql<boolean>`FALSE`;
  return sql<boolean>`${expressionSql(value)} IN (${joinFragments(
    values.map((entry) => expressionSql(entry)),
    ", ",
  )})`;
}

export function joinFragments(
  fragments: readonly SqlFragment[],
  separator: string,
  parentheses = false,
): SqlFragment {
  const chunks: SqlChunk[] = [];
  fragments.forEach((entry, index) => {
    if (index > 0) chunks.push({ kind: "text", value: separator });
    chunks.push({ kind: "fragment", value: entry });
  });
  const joined = fragment(chunks);
  return parentheses ? sql`(${joined})` : joined;
}

export type TableRefs<T extends AnyTable> = {
  readonly [K in keyof T["$columns"]]: ColumnRef<
    T["$columns"][K] extends { readonly value?: infer V } ? V : unknown
  >;
};

export function tableRefs<T extends AnyTable>(table: T, alias = table.$name): TableRefs<T> {
  return Object.fromEntries(
    Object.entries(table.$columns).map(([property, value]) => [
      property,
      columnRef(alias, value.ast.name),
    ]),
  ) as TableRefs<T>;
}

export function compileKeyedSql(
  query: KeyedSql<Record<string, unknown>, unknown>,
  values: Record<string, unknown>,
): SqlQuery {
  const ordered: unknown[] = [];
  const positions = new Map<string, number>();
  const text = query.source.replace(/(?<!:):([a-z_][a-z0-9_]*)/gi, (_match, name: string) => {
    if (!(name in query.parameters)) {
      throw new Error(`Keyed SQL ${query.key} uses undeclared parameter :${name}.`);
    }
    if (!(name in values)) {
      throw new Error(`Keyed SQL ${query.key} is missing parameter ${name}.`);
    }
    let position = positions.get(name);
    if (position === undefined) {
      ordered.push(values[name]);
      position = ordered.length;
      positions.set(name, position);
    }
    return `$${position}`;
  });
  return { text, values: ordered };
}

export async function executeKeyedSql<TParameters extends Record<string, unknown>, TResult>(
  adapter: DatabaseAdapter,
  query: KeyedSql<TParameters, TResult>,
  values: TParameters,
  options: QueryOptions = {},
): Promise<readonly TResult[]> {
  try {
    const result = await adapter.execute<TResult>(
      compileKeyedSql(query as KeyedSql<Record<string, unknown>, unknown>, values),
      { ...options, preparedName: query.key },
    );
    return result.rows;
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}
