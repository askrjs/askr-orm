import type { Pool as PoolType, PoolClient, PoolConfig, QueryResult } from "pg";
import type {
  DatabaseAdapter,
  DatabaseDriver,
  ExecutionResult,
  QueryOptions,
  TransactionOptions,
} from "./adapter";
import type { DatabaseToolingAdapter } from "./definition";
import type { SqlQuery } from "./sql";
export { jsonb, postgresEnum, postgresType, timestampTz, bytea } from "./schema";

const MIGRATION_LOCK_KEY = "4707438161740729";

export interface PostgresOptions {
  readonly url?: string | (() => string);
  readonly shadowUrl?: string | (() => string);
  readonly pool?: Omit<PoolConfig, "connectionString">;
}

function lazy(value: string | (() => string) | undefined, environment: string): string {
  const result = typeof value === "function" ? value() : (value ?? process.env[environment]);
  if (!result) throw new Error(`PostgreSQL requires ${environment} or an explicit lazy URL.`);
  return result;
}

class PgAdapter implements DatabaseAdapter {
  readonly identity: string;
  constructor(
    private readonly executor: { query(config: unknown): Promise<QueryResult> },
    identity: string,
    private readonly pool?: PoolType,
    private readonly client?: PoolClient,
  ) {
    this.identity = identity;
  }

  async execute<Row>(query: SqlQuery, options: QueryOptions = {}): Promise<ExecutionResult<Row>> {
    if (options.signal?.aborted) throw options.signal.reason;
    const result = await this.executor.query({
      text: query.text,
      values: query.values,
      ...(options.preparedName ? { name: options.preparedName } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { query_timeout: options.timeoutMs } : {}),
    });
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
  }

  async *stream<Row>(query: SqlQuery, options: QueryOptions = {}): AsyncIterable<Row> {
    if (options.signal?.aborted) throw options.signal.reason;
    const owned = this.client ? undefined : await this.pool?.connect();
    const client = this.client ?? owned;
    if (!client) throw new Error("PostgreSQL streaming requires a pinned client.");
    try {
      const { default: QueryStream } = await import("pg-query-stream");
      const stream = client.query(new QueryStream(query.text, [...query.values]));
      const abort = () => stream.destroy(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        for await (const row of stream) yield row as Row;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        stream.destroy();
      }
    } finally {
      owned?.release();
    }
  }

  async transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    if (this.client) {
      const savepoint = `askr_${Math.random().toString(36).slice(2)}`;
      await this.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const value = await callback(this);
        await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    if (!this.pool) throw new Error("PostgreSQL transactions require a pool.");
    const client = await this.pool.connect();
    try {
      const clauses = [
        options.isolation && `ISOLATION LEVEL ${options.isolation.toUpperCase()}`,
        options.readOnly && "READ ONLY",
      ]
        .filter(Boolean)
        .join(" ");
      await client.query(`BEGIN${clauses ? ` ${clauses}` : ""}`);
      const value = await callback(
        new PgAdapter(client as never, this.identity, undefined, client),
      );
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async session<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.client) return callback(this);
    if (!this.pool) throw new Error("PostgreSQL sessions require a pool.");
    const client = await this.pool.connect();
    try {
      return await callback(new PgAdapter(client as never, this.identity, undefined, client));
    } finally {
      client.release();
    }
  }

  async migrationLock<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.session(async (session) => {
      await session.execute({ text: `SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`, values: [] });
      try {
        return await callback(session);
      } finally {
        await session
          .execute({ text: `SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`, values: [] })
          .catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

async function createPool(
  url: string,
  options?: Omit<PoolConfig, "connectionString">,
): Promise<PoolType> {
  let module: typeof import("pg");
  try {
    module = await import("pg");
  } catch (error) {
    throw new Error("PostgreSQL support requires optional peers `pg` and `pg-query-stream`.", {
      cause: error,
    });
  }
  try {
    await import("pg-query-stream");
  } catch (error) {
    throw new Error("PostgreSQL support requires optional peer `pg-query-stream`.", {
      cause: error,
    });
  }
  return new module.Pool({ ...options, connectionString: url });
}

async function pgTooling(
  url: string,
  options?: Omit<PoolConfig, "connectionString">,
): Promise<DatabaseToolingAdapter> {
  const pool = await createPool(url, options);
  return {
    identity: url,
    async reset() {
      throw new Error("PostgreSQL shadow reset must be performed by migration tooling.");
    },
    async execute(sql) {
      await pool.query(sql);
    },
    async introspect() {
      return (await pool.query("SELECT current_database() AS database, current_schema() AS schema"))
        .rows;
    },
    async describe(sql, parameterNames) {
      await pool.query("BEGIN");
      try {
        await pool.query(`PREPARE askr_describe AS ${sql}`);
        return { parameters: [...parameterNames], columns: [] };
      } finally {
        await pool.query("ROLLBACK");
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export function postgres(options: PostgresOptions = {}): DatabaseDriver {
  return {
    dialect: "postgres",
    get targetIdentity() {
      return lazy(options.url, "DATABASE_URL");
    },
    get shadowIdentity() {
      return lazy(options.shadowUrl, "DATABASE_SHADOW_URL");
    },
    async open() {
      const url = lazy(options.url, "DATABASE_URL");
      const pool = await createPool(url, options.pool);
      return new PgAdapter(pool as never, url, pool);
    },
    async shadow() {
      const target = lazy(options.url, "DATABASE_URL");
      const shadow = lazy(options.shadowUrl, "DATABASE_SHADOW_URL");
      if (target === shadow)
        throw new Error("PostgreSQL target and shadow database identities must differ.");
      return pgTooling(shadow, options.pool);
    },
  };
}
