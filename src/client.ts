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

export interface WriteResult {
  readonly rowsAffected: number;
}

export interface ReturningRows {
  readonly returning: "row" | "rows";
}

export interface ReturningStatus {
  readonly returning?: "status";
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
  try {
    const result = await adapter.execute(query, options);
    telemetry?.onEvent({
      operation,
      durationMs: performance.now() - started,
      rowCount: result.rowCount,
      ...(telemetry.includeSql ? { sql: query.text } : {}),
    });
    return result;
  } catch (error) {
    const normalized = normalizeDatabaseError(error);
    telemetry?.onEvent({
      operation,
      durationMs: performance.now() - started,
      error: normalized,
      ...(telemetry.includeSql ? { sql: query.text } : {}),
    });
    throw normalized;
  }
}

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

  toSQL(): SqlQuery {
    return this.query().toSQL();
  }

  all(options?: QueryOptions): Promise<readonly InferRow<T>[]> {
    return this.query().execute(options);
  }

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

  async insert(
    input: InferInsert<T>,
    options?: ReturningStatus & QueryOptions,
  ): Promise<WriteResult>;
  async insert(input: InferInsert<T>, options: ReturningRows & QueryOptions): Promise<InferRow<T>>;
  async insert(
    input: InferInsert<T>,
    options: (ReturningStatus | ReturningRows) & QueryOptions = {},
  ): Promise<WriteResult | InferRow<T>> {
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

  async insertMany(
    inputs: readonly InferInsert<T>[],
    options: (ReturningStatus | ReturningRows) &
      QueryOptions & { readonly chunkSize?: number } = {},
  ): Promise<WriteResult | readonly InferRow<T>[]> {
    if (inputs.length === 0) return options.returning === "row" ? [] : { rowsAffected: 0 };
    const chunkSize = options.chunkSize ?? 1000;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid chunkSize.");
    let rowsAffected = 0;
    const rows: InferRow<T>[] = [];
    for (let index = 0; index < inputs.length; index += chunkSize) {
      const chunk = inputs.slice(index, index + chunkSize);
      const properties = [
        ...new Set(chunk.flatMap((input) => Object.keys(input as Record<string, unknown>))),
      ];
      if (properties.length === 0) throw new Error("insertMany rows require at least one value.");
      const columns = properties.map((property) => {
        const column = this.definition.$columns[property];
        if (!column) throw new Error(`Unknown ${this.definition.$name} property ${property}.`);
        return column;
      });
      const values: unknown[] = [];
      const tuples = chunk.map((input) => {
        const record = input as Record<string, unknown>;
        return `(${properties
          .map((property) => {
            if (!(property in record)) return "DEFAULT";
            values.push(encode(this.definition.$columns[property]!, record[property]));
            return `$${values.length}`;
          })
          .join(", ")})`;
      });
      const returning = options.returning === "row";
      const result = await execute(
        this.adapter,
        {
          text: `INSERT INTO ${qualifiedTable(this.definition)} (${columns
            .map((column) => quoteIdentifier(column.ast.name))
            .join(", ")}) VALUES ${tuples.join(", ")}${returning ? " RETURNING *" : ""}`,
          values,
        },
        options,
        this.telemetry,
        `${this.definition.$name}.insertMany`,
      );
      rowsAffected += result.rowCount;
      if (returning) {
        rows.push(...result.rows.map((row) => decodeRow(this.definition, row)));
      }
    }
    return options.returning === "row" ? rows : { rowsAffected };
  }

  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options?: ReturningStatus & QueryOptions,
  ): Promise<WriteResult>;
  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options: ReturningRows & QueryOptions,
  ): Promise<InferRow<T> | null>;
  async update(
    key: PrimaryKeyInput<T>,
    patch: InferPatch<T>,
    options: (ReturningStatus | ReturningRows) & QueryOptions = {},
  ): Promise<WriteResult | InferRow<T> | null> {
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

  async upsertMany(
    inputs: readonly InferInsert<T>[],
    options: QueryOptions & {
      readonly chunkSize?: number;
      readonly returning?: "status" | "rows";
    } = {},
  ): Promise<WriteResult | readonly InferRow<T>[]> {
    if (inputs.length === 0) return options.returning === "rows" ? [] : { rowsAffected: 0 };
    const primary = Object.entries(this.definition.$columns).filter(
      ([, column]) => column.ast.primaryKey,
    );
    if (primary.length === 0) throw new Error("upsertMany requires a primary key.");
    let rowsAffected = 0;
    const returned: InferRow<T>[] = [];
    const chunkSize = options.chunkSize ?? 1000;
    for (let index = 0; index < inputs.length; index += chunkSize) {
      const chunk = inputs.slice(index, index + chunkSize);
      const properties = [
        ...new Set(chunk.flatMap((input) => Object.keys(input as Record<string, unknown>))),
      ];
      const columns = properties.map((property) => {
        const column = this.definition.$columns[property];
        if (!column) throw new Error(`Unknown ${this.definition.$name} property ${property}.`);
        return column;
      });
      const values: unknown[] = [];
      const tuples = chunk.map((input) => {
        const record = input as Record<string, unknown>;
        return `(${properties
          .map((property) => {
            if (!(property in record)) return "DEFAULT";
            values.push(encode(this.definition.$columns[property]!, record[property]));
            return `$${values.length}`;
          })
          .join(", ")})`;
      });
      const updates = properties.filter(
        (property) => !this.definition.$columns[property]!.ast.primaryKey,
      );
      const query = {
        text: `INSERT INTO ${qualifiedTable(this.definition)} (${columns.map((column) => quoteIdentifier(column.ast.name)).join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (${primary.map(([, column]) => quoteIdentifier(column.ast.name)).join(", ")}) DO ${
          updates.length === 0
            ? "NOTHING"
            : `UPDATE SET ${updates
                .map((property) => {
                  const name = quoteIdentifier(this.definition.$columns[property]!.ast.name);
                  return `${name} = EXCLUDED.${name}`;
                })
                .join(", ")}`
        }${options.returning === "rows" ? " RETURNING *" : ""}`,
        values,
      };
      const result = await execute(
        this.adapter,
        query,
        options,
        this.telemetry,
        `${this.definition.$name}.upsertMany`,
      );
      rowsAffected += result.rowCount;
      if (options.returning === "rows") {
        returned.push(...result.rows.map((row) => decodeRow(this.definition, row)));
      }
    }
    return options.returning === "rows" ? returned : { rowsAffected };
  }

  async upsert(
    input: InferInsert<T>,
    options: QueryOptions & { readonly returning?: "status" | "row" } = {},
  ): Promise<WriteResult | InferRow<T>> {
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

export type DatabaseTables<T extends Record<string, AnyTable>> = {
  readonly [K in keyof T]: TableClient<T[K]>;
};

type QueryFunctions<Q extends Record<string, RegisteredQuery<Record<string, unknown>>>> = {
  readonly [K in keyof Q]: Q[K] extends RegisteredQuery<infer P, infer Row>
    ? (params: P, options?: QueryOptions) => Promise<readonly Row[]>
    : never;
};

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
          execute(query, queryOptions) {
            assertActive();
            return currentAdapter.execute(query, queryOptions);
          },
          stream(query, queryOptions) {
            assertActive();
            if (!currentAdapter.stream)
              throw new Error("Streaming is not supported by this adapter.");
            return currentAdapter.stream(query, queryOptions);
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
      migrations: createMigrationsApi(currentAdapter, manifest),
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
