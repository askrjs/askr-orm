import type { SqlQuery } from "./sql";

/** Per-query execution options accepted by {@link DatabaseAdapter.execute} and `stream`. */
export interface QueryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly preparedName?: string;
}

/** Result of executing a query: the returned rows plus the affected/returned row count. */
export interface ExecutionResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

/** Low-level connection contract that dialect drivers implement and query/client code runs against. */
export interface DatabaseAdapter {
  readonly identity?: string;
  execute<Row = Record<string, unknown>>(
    query: SqlQuery,
    options?: QueryOptions,
  ): Promise<ExecutionResult<Row>>;
  stream?<Row = Record<string, unknown>>(
    query: SqlQuery,
    options?: QueryOptions,
  ): AsyncIterable<Row>;
  transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  session?<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
  migrationLock?<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** SQL dialect targeted by a database connection or driver. */
export type DialectName = "postgres" | "sqlite";

/** Internal contract implemented by dialect entrypoints. */
export interface DatabaseDriver {
  readonly dialect: DialectName;
  readonly targetIdentity?: string;
  readonly shadowIdentity?: string;
  open(): Promise<DatabaseAdapter>;
  shadow(): Promise<import("./definition").DatabaseToolingAdapter>;
}

/** Options controlling isolation level, read-only mode, and cancellation of a transaction. */
export interface TransactionOptions {
  readonly isolation?: "read committed" | "repeatable read" | "serializable";
  readonly readOnly?: boolean;
  readonly signal?: AbortSignal;
}

/** Details reported for a single executed operation when telemetry is enabled. */
export interface TelemetryEvent {
  readonly operation: string;
  readonly durationMs: number;
  readonly rowCount?: number;
  readonly error?: unknown;
  readonly sql?: string;
}

/** Telemetry configuration passed to {@link DatabaseOpenOptions}. */
export interface TelemetryOptions {
  readonly includeSql?: boolean;
  readonly onEvent: (event: TelemetryEvent) => void;
}

/** Options accepted when opening a database connection. */
export interface DatabaseOpenOptions {
  readonly telemetry?: TelemetryOptions;
}
