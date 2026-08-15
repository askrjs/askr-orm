const RESERVED = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "authorization",
  "binary",
  "both",
  "case",
  "cast",
  "check",
  "collation",
  "column",
  "concurrently",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "freeze",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "lateral",
  "leading",
  "left",
  "like",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "notnull",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "right",
  "select",
  "session_user",
  "similar",
  "some",
  "symmetric",
  "table",
  "tablesample",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
]);

/** Converts camelCase/kebab-case/space-separated text to snake_case, e.g. for default column names. */
export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/**
 * Wraps a SQL identifier in double quotes, escaping any embedded quotes.
 *
 * @throws If `value` is empty or contains a NUL byte.
 */
export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw new Error("SQL identifiers must be non-empty.");
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Validates that an identifier is safe to embed unquoted in SQL: alphanumeric/underscore,
 * not starting with a digit, and not a reserved word.
 *
 * @throws If the identifier fails validation.
 */
export function assertSafeIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value) || RESERVED.has(value.toLowerCase())) {
    throw new Error(`Unsafe or reserved unquoted SQL identifier: ${value}`);
  }
}
