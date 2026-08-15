import { quoteIdentifier } from "./naming";
import type { DatabaseAdapter, QueryOptions } from "./adapter";
import { normalizeDatabaseError } from "./errors";
import type { AnyTable } from "./schema";

const SQL_FRAGMENT = Symbol("askr.sql.fragment");

/** Compiled, ready-to-execute SQL: parameterized text plus the ordered bind values. */
export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** An uncompiled piece of SQL built with {@link sql}, compiled via {@link compileSql}. */
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

/** A named SQL template with `:named` parameters, built with `sql.key(...)`. See {@link compileKeyedSql}. */
export interface KeyedSql<TParameters extends Record<string, unknown>, TResult> {
  readonly kind: "keyed-sql";
  readonly key: string;
  readonly source: string;
  readonly parameters: TParameters;
  readonly result?: TResult;
}

/** Raw SQL text inserted verbatim (not as a bound parameter) by {@link unsafeSql}. */
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

/** Embeds `name` as a quoted SQL identifier (not a bound parameter). Also available as `sql.identifier`. */
export function identifier(name: string): SqlFragment {
  return fragment([{ kind: "identifier", value: name }]);
}

/** Embeds a value as a SQL literal (not a bound parameter). Also available as `sql.literal`. */
export function literal(value: string | number | boolean | null): SqlFragment {
  if (typeof value === "string") {
    return fragment([{ kind: "text", value: `'${value.replaceAll("'", "''")}'` }]);
  }
  if (value === null) return fragment([{ kind: "text", value: "NULL" }]);
  return fragment([{ kind: "text", value: String(value) }]);
}

/** Wraps raw SQL text to be inserted verbatim into a query. Also available as `sql.unsafe`. */
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

/**
 * Tagged template for building a {@link SqlFragment}: interpolated fragments splice in, other
 * values become bound parameters. Also exposes `sql.identifier`, `sql.literal`, `sql.unsafe`,
 * and `sql.key` for keyed/named-parameter queries.
 */
export const sql: SqlTag = Object.assign(sqlTag, {
  identifier,
  literal,
  unsafe: unsafeSql,
  key: keyedSql,
});

/** Compiles a {@link SqlFragment} tree into parameterized SQL text and an ordered values array. */
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

/** A reference to `tableAlias.columnName`, as produced by {@link tableRefs} for query builders. */
export interface ColumnRef<T = unknown> {
  readonly kind: "column-ref";
  readonly tableAlias: string;
  readonly columnName: string;
  readonly value?: T;
}

/** Anything usable as a query expression: a {@link SqlFragment} or a {@link ColumnRef}. */
export type Expression<T = unknown> = SqlFragment<T> | ColumnRef<T>;

/** Builds a {@link ColumnRef} to `tableAlias.columnName`. */
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

/** Builds an `=` comparison predicate. */
export const eq = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "=", right);
/** Builds a `<>` comparison predicate. */
export const ne = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<>", right);
/** Builds a `>` comparison predicate. */
export const gt = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, ">", right);
/** Builds a `>=` comparison predicate. */
export const gte = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, ">=", right);
/** Builds a `<` comparison predicate. */
export const lt = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<", right);
/** Builds a `<=` comparison predicate. */
export const lte = <T>(left: Expression<T>, right: Expression<T> | T): SqlFragment<boolean> =>
  binary(left, "<=", right);
/** Builds a `LIKE` predicate. */
export const like = (left: Expression<string>, pattern: string): SqlFragment<boolean> =>
  binary(left, "LIKE", pattern);
/** Builds an `ILIKE` predicate. PostgreSQL only. */
export const ilike = (left: Expression<string>, pattern: string): SqlFragment<boolean> =>
  binary(left, "ILIKE", pattern);
/** Builds an `IS NULL` predicate. */
export const isNull = (value: Expression): SqlFragment<boolean> =>
  sql<boolean>`${expressionSql(value)} IS NULL`;
/** Builds an `IS NOT NULL` predicate. */
export const isNotNull = (value: Expression): SqlFragment<boolean> =>
  sql<boolean>`${expressionSql(value)} IS NOT NULL`;

/** Combines predicates with `AND`, parenthesized as a single expression. */
export function and(...predicates: readonly SqlFragment<boolean>[]): SqlFragment<boolean> {
  return joinFragments(predicates, " AND ", true) as SqlFragment<boolean>;
}

/** Combines predicates with `OR`, parenthesized as a single expression. */
export function or(...predicates: readonly SqlFragment<boolean>[]): SqlFragment<boolean> {
  return joinFragments(predicates, " OR ", true) as SqlFragment<boolean>;
}

/** Negates a predicate with `NOT (...)`. */
export function not(predicate: SqlFragment<boolean>): SqlFragment<boolean> {
  return sql<boolean>`NOT (${predicate})`;
}

/** Builds an `IN (...)` predicate; returns a `FALSE` predicate for an empty array. */
export function inArray<T>(value: Expression<T>, values: readonly T[]): SqlFragment<boolean> {
  if (values.length === 0) return sql<boolean>`FALSE`;
  return sql<boolean>`${expressionSql(value)} IN (${joinFragments(
    values.map((entry) => expressionSql(entry)),
    ", ",
  )})`;
}

/** Joins fragments with `separator`, optionally wrapping the result in parentheses. */
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

/** A {@link ColumnRef} for every column of a table, keyed by property name. */
export type TableRefs<T extends AnyTable> = {
  readonly [K in keyof T["$columns"]]: ColumnRef<
    T["$columns"][K] extends { readonly value?: infer V } ? V : unknown
  >;
};

/** Builds {@link ColumnRef}s for every column of `table`, aliased to `alias` (default: the table name). */
export function tableRefs<T extends AnyTable>(table: T, alias = table.$name): TableRefs<T> {
  return Object.fromEntries(
    Object.entries(table.$columns).map(([property, value]) => [
      property,
      columnRef(alias, value.ast.name),
    ]),
  ) as TableRefs<T>;
}

/**
 * Compiles a {@link KeyedSql} template by substituting its `:named` parameters with `values`,
 * producing positional `$n` placeholders.
 *
 * @throws If a `:name` in the SQL text is not declared, or a declared parameter has no value.
 */
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

/** Compiles and executes a {@link KeyedSql} query, using its key as the prepared statement name. */
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
