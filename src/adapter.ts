import type { SqlQuery } from "./sql";

export interface QueryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly preparedName?: string;
}

export interface ExecutionResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

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
  close?(): Promise<void>;
}

export interface TransactionOptions {
  readonly isolation?:
    | "read committed"
    | "repeatable read"
    | "serializable";
  readonly readOnly?: boolean;
  readonly signal?: AbortSignal;
}

export interface TelemetryEvent {
  readonly operation: string;
  readonly durationMs: number;
  readonly rowCount?: number;
  readonly error?: unknown;
  readonly sql?: string;
}

export interface TelemetryOptions {
  readonly includeSql?: boolean;
  readonly onEvent: (event: TelemetryEvent) => void;
}

export interface DatabaseOpenOptions {
  readonly telemetry?: TelemetryOptions;
}
