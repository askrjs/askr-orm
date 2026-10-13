import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statements: [] as string[],
  ends: 0,
  releases: 0,
  failRollback: false,
  failUnlock: false,
  failDeallocate: false,
  releaseErrors: [] as unknown[],
  clientErrorListeners: new Set<(error: Error) => void>(),
}));

vi.mock("pg", () => {
  class Pool {
    async query(
      config:
        | string
        | { text?: string; sql?: string; submit?: unknown; handleReadyForQuery?: () => void },
    ) {
      if (typeof config !== "string" && typeof config.submit === "function") {
        state.statements.push(config.sql === undefined ? "DESCRIBE" : `PARSE ${config.sql}`);
        config.handleReadyForQuery?.();
        return { rows: [], rowCount: 0 };
      }
      const statement = typeof config === "string" ? config : (config.text ?? "");
      state.statements.push(statement);
      if (state.failRollback && statement === "ROLLBACK") throw new Error("rollback failed");
      if (state.failUnlock && statement.startsWith("SELECT pg_advisory_unlock"))
        throw new Error("unlock failed");
      if (state.failDeallocate && statement === "DEALLOCATE askr_describe")
        throw new Error("deallocate failed");
      return { rows: [], rowCount: 0 };
    }

    async connect() {
      return {
        query: (config: string | { text?: string }) => this.query(config),
        on: (event: string, listener: (error: Error) => void) => {
          if (event === "error") state.clientErrorListeners.add(listener);
        },
        off: (event: string, listener: (error: Error) => void) => {
          if (event === "error") state.clientErrorListeners.delete(listener);
        },
        release: (error?: unknown) => {
          state.releases += 1;
          state.releaseErrors.push(error);
        },
      };
    }

    async end() {
      state.ends += 1;
    }
  }
  return { Pool };
});

vi.mock("pg-query-stream", () => ({
  default: class QueryStream {
    destroy() {}
    async *[Symbol.asyncIterator]() {}
  },
}));

import { postgres } from "./postgres";

describe("PostgreSQL adapter", () => {
  beforeEach(() => {
    state.statements.length = 0;
    state.ends = 0;
    state.releases = 0;
    state.failRollback = false;
    state.failUnlock = false;
    state.failDeallocate = false;
    state.releaseErrors.length = 0;
    state.clientErrorListeners.clear();
  });

  it("should deallocate described statements and support repeated description", async () => {
    const shadow = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).shadow();
    await shadow.describe("SELECT $1::text AS value", ["value"]);
    await shadow.describe("SELECT $1::text AS value", ["value"]);
    expect(state.statements.filter((sql) => sql.startsWith("PARSE"))).toHaveLength(2);
    expect(state.statements.filter((sql) => sql === "DEALLOCATE askr_describe")).toHaveLength(2);
    expect(state.releases).toBe(0);
    await shadow.close?.();
    expect(state.releases).toBe(1);
  });

  it("should make runtime close idempotent", async () => {
    const adapter = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).open();
    await adapter.close?.();
    await adapter.close?.();
    expect(state.ends).toBe(1);
  });

  it("should normalize a checked-out client error and remove its listener on release", async () => {
    const adapter = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).open();

    await expect(
      adapter.transaction(async (transaction) => {
        const error = Object.assign(new Error("connection terminated"), { code: "57P01" });
        for (const listener of state.clientErrorListeners) listener(error);
        await transaction.execute({ text: "SELECT 1", values: [] });
      }),
    ).rejects.toMatchObject({ category: "connection", code: "57P01" });
    expect(state.clientErrorListeners).toHaveLength(0);
    expect(state.releases).toBe(1);
    expect(state.releaseErrors[0]).toMatchObject({ category: "connection", code: "57P01" });
    await adapter.close?.();
  });

  it("should discard a session after advisory unlock fails without replacing the callback error", async () => {
    const adapter = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).open();
    const primary = new Error("migration failed");
    state.failUnlock = true;
    await expect(
      adapter.migrationLock!(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(state.releases).toBe(1);
    expect(state.releaseErrors[0]).toMatchObject({ message: "unlock failed" });
    expect(state.clientErrorListeners).toHaveLength(0);
    await adapter.close?.();
  });

  it("should release and discard a client even if statement deallocation fails", async () => {
    const shadow = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).shadow();
    state.failDeallocate = true;
    await expect(shadow.describe("SELECT $1::text", ["value"])).rejects.toThrow(
      "deallocate failed",
    );
    expect(state.releases).toBe(1);
    expect(state.releaseErrors[0]).toMatchObject({ message: "deallocate failed" });
    expect(state.clientErrorListeners).toHaveLength(0);
    state.failDeallocate = false;
    await expect(shadow.describe("SELECT $1::text", ["value"])).resolves.toMatchObject({
      parameters: ["value"],
    });
    expect(state.releases).toBe(1);
    await shadow.close?.();
    expect(state.releases).toBe(2);
  });

  it("should preserve the callback error when rollback fails", async () => {
    const adapter = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).open();
    const callbackError = new Error("callback failed");
    state.failRollback = true;

    await expect(
      adapter.transaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    expect(state.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(state.releases).toBe(1);
    expect(state.releaseErrors[0]).toMatchObject({ message: "rollback failed" });
    await adapter.close?.();
  });
});
