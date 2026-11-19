import type {
  DatabaseAdapter,
  DatabaseOpenOptions,
  ExecutionResult,
  QueryOptions,
  TelemetryOptions,
  TransactionOptions,
} from "./adapter";
import { normalizeDatabaseError } from "./errors";
import type { AnyTable, ColumnValue, InferInsert, InferKey, InferPatch, InferRow } from "./schema";
import { quoteIdentifier } from "./naming";
import { tableQuery, type References, type SelectQuery } from "./query";
import type { SqlQuery } from "./sql";
import { createMigrationsApi, type MigrationManifest, type MigrationsApi } from "./migrations";
import type { RegisteredQuery } from "./registered-query";

/** Outcome of a write operation that did not request rows back. */
export interface WriteResult {
  readonly rowsAffected: number;
}

/** Option marker requesting that a write operation return the single affected row. */
export interface ReturningRow {
  readonly returning: "row";
}

/** Option marker requesting that a write operation return all affected rows. */
export interface ReturningRows {
  readonly returning: "rows";
}

/** Option marker requesting only a {@link WriteResult} status, without returned rows (the default). */
export interface ReturningStatus {
  readonly returning?: "status";
}

const POSTGRES_PARAMETER_LIMIT = 65_535;

function batchProperties(inputs: readonly Record<string, unknown>[]): string[] {
  return [...new Set(inputs.flatMap((input) => Object.keys(input)))];
}

async function writeChunk<Row extends object>(
  adapter: DatabaseAdapter,
  chunk: readonly Row[],
  properties: string[],
  write: (connection: DatabaseAdapter, rows: readonly Row[], columns: string[]) => Promise<void>,
): Promise<void> {
  if (adapter.dialect !== "sqlite") return write(adapter, chunk, properties);
  const groups: { rows: Row[]; columns: string[] }[] = [];
  for (const row of chunk) {
    const columns = properties.filter((key) => Object.hasOwn(row, key));
    const last = groups.at(-1);
    if (
      last &&
      columns.length === last.columns.length &&
      columns.every((key, i) => key === last.columns[i])
    ) {
      last.rows.push(row);
    } else {
      groups.push({ rows: [row], columns });
    }
  }
  const run = async (connection: DatabaseAdapter) => {
    for (const group of groups) await write(connection, group.rows, group.columns);
  };
  if (groups.length > 1) await adapter.transaction(run);
  else await run(adapter);
}

function effectiveBatchChunkSize(
  configuredChunkSize: number,
  propertyCount: number,
  operation: "insertMany" | "upsertMany",
): number {
  if (propertyCount === 0) throw new Error(`${operation} rows require at least one value.`);
  const parameterBound = Math.floor(POSTGRES_PARAMETER_LIMIT / propertyCount);
  if (parameterBound < 1) {
    throw new Error(
      `${operation} rows contain ${propertyCount} values, exceeding PostgreSQL's ${POSTGRES_PARAMETER_LIMIT}-parameter statement limit.`,
    );
  }
  return Math.min(configuredChunkSize, parameterBound);
}

type PrimaryKeyName<T extends AnyTable> = {
  [K in keyof T["$columns"]]: K extends keyof InferKey<T> ? K : never;
}[keyof T["$columns"]];
type PrimaryKeyInput<T extends AnyTable> =
  | ColumnValue<T["$columns"][PrimaryKeyName<T>]>
  | Readonly<Pick<InferRow<T>, PrimaryKeyName<T>>>;

function qualifiedTable(table: AnyTable): string {
  return `${quoteIdentifier(table.$schema)}.${quoteIdentifier(table.$name)}`;
}

function encode(column: AnyTable["$columns"][string], value: unknown): unknown {
  return column.ast.codec ? column.ast.codec.encode(value) : value;
}

function decodeRow<T extends AnyTable>(table: T, row: Record<string, unknown>): InferRow<T> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(table.$columns).map(([property, column]) => [
        property,
        column.ast.codec ? column.ast.codec.decode(row[column.ast.name]) : row[column.ast.name],
      ]),
    ),
  ) as InferRow<T>;
}

function keyEntries<T extends AnyTable>(
  table: T,
  key: PrimaryKeyInput<T>,
): readonly [string, unknown][] {
  const primary = Object.entries(table.$columns).filter(([, column]) => column.ast.primaryKey);
  if (primary.length === 0) throw new Error(`${table.$name} has no primary key.`);
  if (primary.length === 1 && (key === null || typeof key !== "object" || key instanceof Date)) {
    return [[primary[0]?.[0] as string, key]];
  }
  if (!key || typeof key !== "object") {
    throw new Error(`${table.$name} has a composite primary key; pass a key object.`);
  }
  return primary.map(([property]) => {
    if (!(property in key)) throw new Error(`Missing primary key property ${property}.`);
    return [property, (key as Record<string, unknown>)[property]];
  });
}

function whereKey<T extends AnyTable>(
  table: T,
  key: PrimaryKeyInput<T>,
  start: number,
): { readonly text: string; readonly values: readonly unknown[] } {
  const entries = keyEntries(table, key);
  return {
    text: entries
      .map(([property], index) => {
        const column = table.$columns[property];
        return `${quoteIdentifier(column?.ast.name ?? property)} = $${start + index}`;
      })
      .join(" AND "),
    values: entries.map(([property, value]) => encode(table.$columns[property]!, value)),
  };
}

async function execute(
  adapter: DatabaseAdapter,
  query: SqlQuery,
  options: QueryOptions,
  telemetry: TelemetryOptions | undefined,
  operation: string,
): Promise<ExecutionResult<Record<string, unknown>>> {
  const started = performance.now();
  let result: ExecutionResult<Record<string, unknown>>;
  try {
    result = await adapter.execute(query, options);
  } catch (error) {
    const normalized = normalizeDatabaseError(error);
    try {
      telemetry?.onEvent({
        operation,
        durationMs: performance.now() - started,
        error: normalized,
        ...(telemetry.includeSql ? { sql: query.text } : {}),
      });
    } catch {
      // Telemetry is observational and must never replace a database failure.
    }
    throw normalized;
  }
  try {
    telemetry?.onEvent({
      operation,
      durationMs: performance.now() - started,
      rowCount: result.rowCount,
      ...(telemetry.includeSql ? { sql: query.text } : {}),
    });
  } catch {
    // A telemetry sink cannot turn a committed operation into an application failure.
  }
  return result;
}

/**
 * Typed CRUD and query surface for a single table, backed by a {@link DatabaseAdapter}.
 * Instances are created internally by {@link createDatabaseClient}; the select-query
 * methods delegate to a fresh {@link SelectQuery} for that table.
 */
export class TableClient<T extends AnyTable> {
  readonly definition: T;

  constructor(
    definition: T,
    private readonly adapter: DatabaseAdapter,
    private readonly telemetry?: TelemetryOptions,
  ) {
    this.definition = definition;
  }

  private query(): SelectQuery<InferRow<T>, References<T, T["$name"]>> {
    return tableQuery(this.adapter, this.definition);
  }

  select: SelectQuery<InferRow<T>, References<T, T["$name"]>>["select"] = (projection) =>
    this.query().select(projection);
  where: SelectQuery<InferRow<T>, References<T, T["$name"]>>["where"] = (predicate) =>
    this.query().where(predicate);
  join: SelectQuery<InferRow<T>, References<T, T["$name"]>>["join"] = (target, options) =>
    this.query().join(target, options);
  leftJoin: SelectQuery<InferRow<T>, References<T, T["$name"]>>["leftJoin"] = (target, options) =>
    this.query().leftJoin(target, options);
  rightJoin: SelectQuery<InferRow<T>, References<T, T["$name"]>>["rightJoin"] = (target, options) =>
    this.query().rightJoin(target, options);
  fullJoin: SelectQuery<InferRow<T>, References<T, T["$name"]>>["fullJoin"] = (target, options) =>
    this.query().fullJoin(target, options);
  orderBy: SelectQuery<InferRow<T>, References<T, T["$name"]>>["orderBy"] = (
    expression,
    direction,
  ) => this.query().orderBy(expression, direction);
  groupBy: SelectQuery<InferRow<T>, References<T, T["$name"]>>["groupBy"] = (...groups) =>
    this.query().groupBy(...groups);
  having: SelectQuery<InferRow<T>, References<T, T["$name"]>>["having"] = (predicate) =>
    this.query().having(predicate);
  limit: SelectQuery<InferRow<T>, References<T, T["$name"]>>["limit"] = (value) =>
    this.query().limit(value);
  offset: SelectQuery<InferRow<T>, References<T, T["$name"]>>["offset"] = (value) =>
    this.query().offset(value);
  distinct: SelectQuery<InferRow<T>, References<T, T["$name"]>>["distinct"] = () =>
    this.query().distinct();
  with: SelectQuery<InferRow<T>, References<T, T["$name"]>>["with"] = (name, query) =>
    this.query().with(name, query);
  prepare: SelectQuery<InferRow<T>, References<T, T["$name"]>>["prepare"] = (name) =>
    this.query().prepare(name);
  stream: SelectQuery<InferRow<T>, References<T, T["$name"]>>["stream"] = (options) =>
    this.query().stream(options);

  /** Compiles the default `SELECT * FROM <table>` query to SQL without executing it. */
  toSQL(): SqlQuery {
    return this.query().toSQL();
  }

  /** Fetches every row in the table. */
  all(options?: QueryOptions): Promise<readonly InferRow<T>[]> {
    return this.query().execute(options);
  }

  /** Fetches a single row by primary key, or `null` if no row matches. */
  async get(key: PrimaryKeyInput<T>, options: QueryOptions = {}): Promise<InferRow<T> | null> {
    const where = whereKey(this.definition, key, 1);
    const query = {
      text: `SELECT * FROM ${qualifiedTable(this.definition)} WHERE ${where.text} LIMIT 1`,
      values: where.values,
    };
    const result = await execute(
      this.adapter,
      query,
      options,
      this.telemetry,
      `${this.definition.$name}.get`,
    );
    const row = result.rows[0];
    return row ? decodeRow(this.definition, row) : null;
  }

  /** Inserts a single row. Pass `{ returning: "row" }` to get the inserted row back. */
  async insert(
    input: InferInsert<T>,
    options?: ReturningStatus & QueryOptions,
  ): Promise<WriteResult>;
  async insert(input: InferInsert<T>, options: ReturningRow & QueryOptions): Promise<InferRow<T>>;
  async insert(
    input: InferInsert<T>,
    options: (ReturningStatus | ReturningRow) & QueryOptions = {},
  ): Promise<WriteResult | InferRow<T>> {
    if (
      options.returning !== undefined &&
      options.returning !== "status" &&
      options.returning !== "row"
    ) {
      throw new Error('insert returning must be "status" or "row".');
    }
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) throw new Error("insert requires at least one value.");
    const columns = entries.map(([property]) => {
      const column = this.definition.$columns[property];
      if (!column) throw new Error(`Unknown ${this.definition.$name} property ${property}.`);
      return quoteIdentifier(column.ast.name);
    });
    const values = entries.map(([property, value]) =>
      encode(this.definition.$columns[property]!, value),
    );
    const returning = options.returning === "row";
    const query = {
      text: `INSERT INTO ${qualifiedTable(this.definition)} (${columns.join(", ")}) VALUES (${values
        .map((_, index) => `$${index + 1}`)
        .join(", ")})${returning ? " RETURNING *" : ""}`,
      values,
    };
    const result = await execute(
      this.adapter,
      query,
      options,
      this.telemetry,
      `${this.definition.$name}.insert`,
    );
    if (!returning) return { rowsAffected: result.rowCount };
    const row = result.rows[0];
    if (!row) throw new Error("INSERT RETURNING did not return a row.");
    return decodeRow(this.definition, row);
  }

  /**
   * Inserts many rows in chunks (default 1000 per statement, via `options.chunkSize`), capped by
   * row width so no statement exceeds PostgreSQL's 65,535 bind-parameter limit. Pass
   * `{ returning: "rows" }` to get all inserted rows back.
   */
  async insertMany(
    inputs: readonly InferInsert<T>[],
    options: (ReturningStatus | ReturningRows) &
      QueryOptions & { readonly chunkSize?: number } = {},
  ): Promise<WriteResult | readonly InferRow<T>[]> {
    return this.writeMany(inputs, options, "insertMany");
  }

  /** Updates the row matching the primary key with the given patch. */
  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options?: ReturningStatus & QueryOptions,
  ): Promise<WriteResult>;
  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options: ReturningRow & QueryOptions,
  ): Promise<InferRow<T> | null>;
  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options: (ReturningStatus | ReturningRow) & QueryOptions = {},
  ): Promise<WriteResult | InferRow<T> | null> {
    if (
      options.returning !== undefined &&
      options.returning !== "status" &&
      options.returning !== "row"
    ) {
      throw new Error('update returning must be "status" or "row".');
    }
    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length === 0) throw new Error("update requires a non-empty patch.");
    const values = entries.map(([property, value]) => {
      const column = this.definition.$columns[property];
      if (!column) throw new Error(`Unknown ${this.definition.$name} property ${property}.`);
      return encode(column, value);
    });
    const assignments = entries.map(([property], index) => {
      const column = this.definition.$columns[property]!;
      return `${quoteIdentifier(column.ast.name)} = $${index + 1}`;
    });
    const where = whereKey(this.definition, key, values.length + 1);
    values.push(...where.values);
    const returning = options.returning === "row";
    const query = {
      text: `UPDATE ${qualifiedTable(this.definition)} SET ${assignments.join(", ")} WHERE ${where.text}${returning ? " RETURNING *" : ""}`,
      values,
    };
    const result = await execute(
      this.adapter,
      query,
      options,
      this.telemetry,
      `${this.definition.$name}.update`,
    );
    if (!returning) return { rowsAffected: result.rowCount };
    const row = result.rows[0];
    return row ? decodeRow(this.definition, row) : null;
  }

  /** Deletes the row matching the primary key. */
  async delete(key: PrimaryKeyInput<T>, options: QueryOptions = {}): Promise<WriteResult> {
    const where = whereKey(this.definition, key, 1);
    const result = await execute(
      this.adapter,
      {
        text: `DELETE FROM ${qualifiedTable(this.definition)} WHERE ${where.text}`,
        values: where.values,
      },
      options,
      this.telemetry,
      `${this.definition.$name}.delete`,
    );
    return { rowsAffected: result.rowCount };
  }

  /**
   * Inserts many rows, updating non-primary-key columns on conflict (`ON CONFLICT ... DO UPDATE`),
   * in chunks (default 1000 per statement, via `options.chunkSize`) capped by row width so no
   * statement exceeds PostgreSQL's 65,535 bind-parameter limit. Requires the table to have a
   * primary key.
   */
  async upsertMany(
    inputs: readonly InferInsert<T>[],
    options: QueryOptions & {
      readonly chunkSize?: number;
      readonly returning?: "status" | "rows";
    } = {},
  ): Promise<WriteResult | readonly InferRow<T>[]> {
    return this.writeMany(inputs, options, "upsertMany");
  }

  private async writeMany(
    inputs: readonly InferInsert<T>[],
    options: QueryOptions & { readonly chunkSize?: number; readonly returning?: "status" | "rows" },
    operation: "insertMany" | "upsertMany",
  ): Promise<WriteResult | readonly InferRow<T>[]> {
    if (
      options.returning !== undefined &&
      options.returning !== "status" &&
      options.returning !== "rows"
    ) {
      throw new Error(`${operation} returning must be "status" or "rows".`);
    }
    if (inputs.length === 0) return options.returning === "rows" ? [] : { rowsAffected: 0 };
    let conflict = "";
    const allProperties = batchProperties(inputs as readonly Record<string, unknown>[]);
    const columnsByProperty = this.definition.$columns;
    for (const property of allProperties) {
      if (!Object.hasOwn(columnsByProperty, property))
        throw new Error(`Unknown ${this.definition.$name} property ${property}.`);
    }
    if (operation === "upsertMany") {
      const keys = Object.values(columnsByProperty).filter((column) => column.ast.primaryKey);
      if (!keys.length) throw new Error("upsertMany requires a primary key.");
      const updates = allProperties
        .filter((property) => !columnsByProperty[property]!.ast.primaryKey)
        .map((property) => {
          const name = quoteIdentifier(columnsByProperty[property]!.ast.name);
          return `${name} = EXCLUDED.${name}`;
        });
      const target = keys.map((column) => quoteIdentifier(column.ast.name)).join(", ");
      conflict = ` ON CONFLICT (${target}) DO ${updates.length ? "UPDATE SET " + updates.join(", ") : "NOTHING"}`;
    }
    const chunkSize = options.chunkSize ?? 1000;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid chunkSize.");
    const effectiveChunkSize = effectiveBatchChunkSize(chunkSize, allProperties.length, operation);
    let rowsAffected = 0;
    const rows: InferRow<T>[] = [];
    for (let index = 0; index < inputs.length; index += effectiveChunkSize) {
      const chunk = inputs.slice(index, index + effectiveChunkSize);
      await writeChunk(
        this.adapter,
        chunk,
        allProperties,
        async (connection, group, properties) => {
          const columns = properties.map((property) =>
            quoteIdentifier(columnsByProperty[property]!.ast.name),
          );
          const values: unknown[] = [];
          // SQLite has no DEFAULT tuple or UPSERT after DEFAULT VALUES. For an
          // entirely omitted row, use the database's declared default for one
          // writable column and leave every other column out of the statement.
          let defaultTuple: string | undefined;
          if (columns.length === 0) {
            const name = columnsByProperty[allProperties[0]!]!.ast.name;
            const result = await connection.execute<{ dflt_value: string | null }>(
              {
                text: "SELECT dflt_value FROM pragma_table_info($1) WHERE name = $2",
                values: [this.definition.$name, name],
              },
              options,
            );
            columns.push(quoteIdentifier(name));
            defaultTuple = `(${result.rows[0]?.dflt_value ?? "NULL"})`;
          }
          const tuples = group.map((input) => {
            if (defaultTuple) return defaultTuple;
            const record = input as Record<string, unknown>;
            return `(${properties
              .map((property) => {
                if (!(property in record)) return "DEFAULT";
                values.push(encode(this.definition.$columns[property]!, record[property]));
                return `$${values.length}`;
              })
              .join(", ")})`;
          });
          const returning = options.returning === "rows";
          const result = await execute(
            connection,
            {
              text: `INSERT INTO ${qualifiedTable(this.definition)} (${columns.join(", ")}) VALUES ${tuples.join(", ")}${conflict}${returning ? " RETURNING *" : ""}`,
              values,
            },
            options,
            this.telemetry,
            `${this.definition.$name}.${operation}`,
          );
          rowsAffected += result.rowCount;
          if (returning) {
            rows.push(...result.rows.map((row) => decodeRow(this.definition, row)));
          }
        },
      );
    }
    return options.returning === "rows" ? rows : { rowsAffected };
  }

  /** Inserts a single row, updating non-primary-key columns on conflict. See {@link upsertMany}. */
  async upsert(
    input: InferInsert<T>,
    options: QueryOptions & { readonly returning?: "status" | "row" } = {},
  ): Promise<WriteResult | InferRow<T>> {
    if (
      options.returning !== undefined &&
      options.returning !== "status" &&
      options.returning !== "row"
    ) {
      throw new Error('upsert returning must be "status" or "row".');
    }
    const result = await this.upsertMany([input], {
      ...options,
      returning: options.returning === "row" ? "rows" : "status",
    });
    if (options.returning !== "row") return result as WriteResult;
    const row = (result as readonly InferRow<T>[])[0];
    if (!row) throw new Error("UPSERT RETURNING did not return a row.");
    return row;
  }
}

/** Maps each table in a schema record to its corresponding {@link TableClient}. */
export type DatabaseTables<T extends Record<string, AnyTable>> = {
  readonly [K in keyof T]: TableClient<T[K]>;
};

type QueryFunctions<Q extends Record<string, RegisteredQuery<Record<string, unknown>>>> = {
  readonly [K in keyof Q]: Q[K] extends RegisteredQuery<infer P, infer Row>
    ? (params: P, options?: QueryOptions) => Promise<readonly Row[]>
    : never;
};

/**
 * Full client returned by {@link createDatabaseClient}: a {@link TableClient} per table, callable
 * registered queries, a migrations API, transaction support, and connection close.
 */
export type DatabaseClient<
  T extends Record<string, AnyTable>,
  Q extends Record<string, RegisteredQuery<Record<string, unknown>>> = Record<never, never>,
> = DatabaseTables<T> & {
  readonly queries: QueryFunctions<Q>;
  readonly migrations: MigrationsApi;
  transaction<R>(
    callback: (database: DatabaseClient<T, Q>) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R>;
  close(): Promise<void>;
};

/**
 * Builds a {@link DatabaseClient} exposing one {@link TableClient} per table, the given
 * registered queries as callable functions, a migrations API, and transaction support.
 *
 * @param tables Table definitions, keyed by the name used on the resulting client.
 * @param adapter Low-level connection to run queries against.
 * @param manifest Bundled migrations exposed through `client.migrations`.
 * @param options Open options (e.g. telemetry).
 * @param registeredQueries Precompiled queries (see {@link defineQuery}) exposed as `client.queries`.
 */
export function createDatabaseClient<
  T extends Record<string, AnyTable>,
  Q extends Record<string, RegisteredQuery<Record<string, unknown>>> = Record<never, never>,
>(
  tables: T,
  adapter: DatabaseAdapter,
  manifest: MigrationManifest = { migrations: [] },
  options: DatabaseOpenOptions = {},
  registeredQueries: Q = {} as Q,
): DatabaseClient<T, Q> {
  const create = (
    currentAdapter: DatabaseAdapter,
    expires?: { active: boolean },
  ): DatabaseClient<T, Q> => {
    const assertActive = () => {
      if (expires && !expires.active) throw new Error("Transaction client is no longer active.");
    };
    const effectiveAdapter: DatabaseAdapter = expires
      ? {
          ...(currentAdapter.dialect && { dialect: currentAdapter.dialect }),
          execute(query, queryOptions) {
            assertActive();
            return currentAdapter.execute(query, queryOptions);
          },
          stream<Row>(query: SqlQuery, queryOptions?: QueryOptions) {
            assertActive();
            if (!currentAdapter.stream)
              throw new Error("Streaming is not supported by this adapter.");
            const source = currentAdapter.stream<Row>(query, queryOptions);
            return {
              async *[Symbol.asyncIterator]() {
                assertActive();
                const iterator = source[Symbol.asyncIterator]();
                try {
                  while (true) {
                    assertActive();
                    const part = await iterator.next();
                    if (part.done) return;
                    assertActive();
                    yield part.value;
                  }
                } finally {
                  await iterator.return?.();
                }
              },
            };
          },
          transaction(callback, transactionOptions) {
            assertActive();
            return currentAdapter.transaction(callback, transactionOptions);
          },
        }
      : currentAdapter;
    const clients = Object.fromEntries(
      Object.entries(tables).map(([name, definition]) => [
        name,
        new TableClient(definition, effectiveAdapter, options.telemetry),
      ]),
    ) as DatabaseTables<T>;
    const migrations = createMigrationsApi(currentAdapter, manifest);
    return Object.assign(clients, {
      queries: Object.fromEntries(
        Object.entries(registeredQueries).map(([name, query]) => [
          name,
          async (params: Record<string, unknown>, queryOptions?: QueryOptions) => {
            assertActive();
            return (await effectiveAdapter.execute(query.compile(params), queryOptions)).rows;
          },
        ]),
      ) as QueryFunctions<Q>,
      migrations: {
        async plan(queryOptions) {
          assertActive();
          return migrations.plan(queryOptions);
        },
        async apply(applyOptions) {
          assertActive();
          return migrations.apply(applyOptions);
        },
        async resolve(id, resolution, queryOptions) {
          assertActive();
          return migrations.resolve(id, resolution, queryOptions);
        },
      } satisfies MigrationsApi,
      transaction: <R>(
        callback: (database: DatabaseClient<T, Q>) => Promise<R>,
        transactionOptions?: TransactionOptions,
      ) =>
        effectiveAdapter.transaction(async (transactionAdapter) => {
          const lifetime = { active: true };
          try {
            return await callback(create(transactionAdapter, lifetime));
          } finally {
            lifetime.active = false;
          }
        }, transactionOptions),
      close: () => {
        assertActive();
        return expires ? Promise.resolve() : (currentAdapter.close?.() ?? Promise.resolve());
      },
    });
  };
  return create(adapter);
}
