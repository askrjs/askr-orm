import { describe, expect, it } from "vitest";
import { DatabaseError, normalizeDatabaseError } from "./index";

describe("database errors", () => {
  it.each([
    ["23505", "constraint"],
    ["40001", "serialization"],
    ["40P01", "deadlock"],
    ["57014", "cancellation"],
    ["08006", "connection"],
  ] as const)("maps PostgreSQL %s to %s", (code, category) => {
    const cause = { code, message: "driver error", constraint: "users_email_key" };
    const error = normalizeDatabaseError(cause);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.category).toBe(category);
    expect(error.cause).toBe(cause);
  });

  it.each([
    [
      { code: "ERR_SQLITE_ERROR", errcode: 2067, message: "UNIQUE constraint failed" },
      "constraint",
    ],
    [{ code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is busy" }, "timeout"],
    [
      { code: "ERR_SQLITE_ERROR", errcode: 14, message: "unable to open database file" },
      "connection",
    ],
  ] as const)("maps SQLite driver errors to %s", (cause, category) => {
    expect(normalizeDatabaseError(cause).category).toBe(category);
  });
});
