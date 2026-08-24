import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  DatabaseAdapter,
  DatabaseDriver,
  ExecutionResult,
  QueryOptions,
  TransactionOptions,
} from "./adapter";
import type { DatabaseToolingAdapter } from "./definition";
import type { SqlQuery } from "./sql";
import { rewritePlaceholders, sqliteSql } from "./placeholders";

/** Options accepted by {@link sqlite}. */
export interface SqliteOptions {
  readonly filename?: string | (() => string);
}

interface QueueContext {
  readonly adapter: SqliteAdapter;
  readonly nestedQueue: SqliteQueue;
}
const context = new AsyncLocalStorage<QueueContext>();

const sharedQueues = new Map<string, { queue: SqliteQueue; users: number }>();

function sqliteQuery(query: SqlQuery): SqlQuery {
  return rewritePlaceholders(query.text, query.values, { sqlite: true });
}

class SqliteQueue {
  tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class SqliteAdapter implements DatabaseAdapter {
  readonly identity: string;
  private readonly queue: SqliteQueue;
  private savepoint = 0;
  private closed = false;

  constructor(
    private readonly database: DatabaseSync,
    identity: string,
    queue = new SqliteQueue(),
    private readonly releaseQueue = () => undefined,
  ) {
    this.identity = identity;
    this.queue = queue;
    database.exec("PRAGMA foreign_keys = ON");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite database is closed.");
  }

  private bestEffortExec(sql: string): void {
    try {
      this.database.exec(sql);
    } catch {
      // Preserve the operation error that triggered transaction cleanup.
    }
  }

  private perform<Row>(query: SqlQuery): ExecutionResult<Row> {
    this.assertOpen();
    const compiled = sqliteQuery(query);
    const statement = this.database.prepare(compiled.text);
    if (statement.columns().length > 0) {
      const rows = statement.all(...(compiled.values as never[])) as Row[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...(compiled.values as never[]));
    return { rows: [], rowCount: Number(result.changes) };
  }

  execute<Row>(query: SqlQuery, options: QueryOptions = {}): Promise<ExecutionResult<Row>> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (context.getStore()?.adapter === this) return Promise.resolve(this.perform<Row>(query));
    return this.queue.run(async () => {
      if (options.signal?.aborted) throw options.signal.reason;
      return this.perform<Row>(query);
    });
  }

  async *stream<Row>(query: SqlQuery, options: QueryOptions = {}): AsyncIterable<Row> {
    const release =
      context.getStore()?.adapter === this ? () => undefined : await this.queue.acquire();
    try {
      this.assertOpen();
      const compiled = sqliteQuery(query);
      const statement = this.database.prepare(compiled.text);
      for (const row of statement.iterate(...(compiled.values as never[]))) {
        if (options.signal?.aborted) throw options.signal.reason;
        yield row as Row;
      }
    } finally {
      release();
    }
  }

  transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    _options?: TransactionOptions,
  ): Promise<T> {
    const current = context.getStore();
    if (current?.adapter === this) {
      return current.nestedQueue.run(() =>
        context.run({ adapter: this, nestedQueue: new SqliteQueue() }, () => this.nested(callback)),
      );
    }
    return this.queue.run(() =>
      context.run({ adapter: this, nestedQueue: new SqliteQueue() }, async () => {
        this.database.exec("BEGIN");
        try {
          const result = await callback(this);
          this.database.exec("COMMIT");
          return result;
        } catch (error) {
          this.bestEffortExec("ROLLBACK");
          throw error;
        }
      }),
    );
  }

  session<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (context.getStore()?.adapter === this) return callback(this);
    return this.queue.run(() =>
      context.run({ adapter: this, nestedQueue: new SqliteQueue() }, () => callback(this)),
    );
  }

  migrationLock<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.session(callback);
  }

  private async nested<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const name = `askr_${++this.savepoint}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = await callback(this);
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.bestEffortExec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.bestEffortExec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.queue.run(async () => {
      if (this.closed) return;
      this.closed = true;
      try {
        this.database.close();
      } finally {
        this.releaseQueue();
      }
    });
  }
}

function tooling(filename: string): DatabaseToolingAdapter {
  let database = new DatabaseSync(filename);
  let closed = false;
  return {
    identity: filename,
    async reset() {
      if (!closed) database.close();
      database = new DatabaseSync(filename);
      closed = false;
    },
    async execute(sql) {
      database.exec(sqliteSql(sql));
    },
    async introspect() {
      const objects = database
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ type: string; name: string; sql: string | null }>;
      const tables = objects
        .filter((entry) => entry.type === "table")
        .map((entry) => {
          const safeName = entry.name.replaceAll('"', '""');
          const columns = database.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
          }>;
          const indexes = database.prepare(`PRAGMA index_list("${safeName}")`).all() as Array<{
            name: string;
            unique: number;
            origin: string;
          }>;
          const uniqueColumns = new Set<string>();
          for (const index of indexes.filter((value) => value.unique && value.origin === "u")) {
            const safeIndex = index.name.replaceAll('"', '""');
            const indexed = database.prepare(`PRAGMA index_info("${safeIndex}")`).all() as Array<{
              name: string;
            }>;
            if (indexed.length === 1) uniqueColumns.add(indexed[0]!.name);
          }
          return {
            schema: "public",
            name: entry.name,
            columns: columns
              .map((column) => ({
                property: column.name,
                name: column.name,
                dataType: column.type.toLowerCase(),
                nullable: !column.notnull && !column.pk,
                primaryKey: Boolean(column.pk),
                unique: uniqueColumns.has(column.name),
                ...(column.dflt_value === null ? {} : { default: column.dflt_value }),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            constraints: [],
          };
        });
      const views = objects
        .filter((entry) => entry.type === "view")
        .map((entry) => ({
          kind: "view" as const,
          schema: "public",
          name: entry.name,
          query: entry.sql?.replace(/^CREATE\s+VIEW\s+[^\s]+\s+AS\s+/i, "") ?? "",
        }));
      return { version: 1, enums: [], tables, views };
    },
    async describe(sql, parameterNames) {
      const statement = database.prepare(
        rewritePlaceholders(sql, parameterNames, { sqlite: true }).text,
      );
      return {
        parameters: [...parameterNames],
        columns: statement.columns().map((column) => ({
          name: column.name,
          dataType: column.type ?? "unknown",
          nullable: true,
        })),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

/**
 * Creates a SQLite {@link DatabaseDriver} backed by `node:sqlite`. The filename defaults to
 * `DATABASE_PATH`; its in-memory shadow database is used for migration tooling.
 *
 * @throws If no filename is configured and `DATABASE_PATH` is unset.
 */
export function sqlite(options: SqliteOptions = {}): DatabaseDriver {
  const configured = options.filename ?? (() => process.env.DATABASE_PATH ?? "");
  const filename = typeof configured === "function" ? configured() : configured;
  if (!filename) throw new Error("SQLite requires DATABASE_PATH or an explicit filename.");
  const identity = filename === ":memory:" ? filename : path.resolve(filename);
  return {
    dialect: "sqlite",
    targetIdentity: identity,
    shadowIdentity: ":memory:",
    async open() {
      const database = new DatabaseSync(filename);
      if (identity === ":memory:") return new SqliteAdapter(database, identity);
      const shared = sharedQueues.get(identity) ?? { queue: new SqliteQueue(), users: 0 };
      shared.users += 1;
      sharedQueues.set(identity, shared);
      let released = false;
      return new SqliteAdapter(database, identity, shared.queue, () => {
        if (released) return;
        released = true;
        shared.users -= 1;
        if (shared.users === 0 && sharedQueues.get(identity) === shared)
          sharedQueues.delete(identity);
      });
    },
    async shadow() {
      return tooling(":memory:");
    },
  };
}
