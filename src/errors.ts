export type DatabaseErrorCategory =
  | "constraint"
  | "serialization"
  | "deadlock"
  | "timeout"
  | "cancellation"
  | "connection"
  | "unknown";

export class DatabaseError extends Error {
  readonly category: DatabaseErrorCategory;
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;

  constructor(
    message: string,
    options: {
      readonly category: DatabaseErrorCategory;
      readonly cause: unknown;
      readonly code?: string;
      readonly constraint?: string;
      readonly table?: string;
      readonly column?: string;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "DatabaseError";
    this.category = options.category;
    if (options.code !== undefined) this.code = options.code;
    if (options.constraint !== undefined) this.constraint = options.constraint;
    if (options.table !== undefined) this.table = options.table;
    if (options.column !== undefined) this.column = options.column;
  }
}

interface DriverErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly constraint?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
  readonly name?: unknown;
}

const CONSTRAINT_CODES = new Set(["23000", "23502", "23503", "23505", "23514", "23P01"]);
const CONNECTION_PREFIXES = ["08", "53", "57P0"];

export function normalizeDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const value = (error && typeof error === "object" ? error : {}) as DriverErrorLike;
  const code = typeof value.code === "string" ? value.code : undefined;
  const message = typeof value.message === "string" ? value.message : "Database operation failed.";
  let category: DatabaseErrorCategory = "unknown";
  if (code && CONSTRAINT_CODES.has(code)) category = "constraint";
  else if (code === "40001") category = "serialization";
  else if (code === "40P01") category = "deadlock";
  else if (code === "57014" || value.name === "AbortError") category = "cancellation";
  else if (code === "55P03" || code === "57000") category = "timeout";
  else if (code && CONNECTION_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    category = "connection";
  }
  return new DatabaseError(message, {
    category,
    cause: error,
    ...(code === undefined ? {} : { code }),
    ...(typeof value.constraint === "string" ? { constraint: value.constraint } : {}),
    ...(typeof value.table === "string" ? { table: value.table } : {}),
    ...(typeof value.column === "string" ? { column: value.column } : {}),
  });
}
