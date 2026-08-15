import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  statements: [] as string[],
  ends: 0,
  releases: 0,
  clientErrorListeners: new Set<(error: Error) => void>(),
}));

vi.mock("pg", () => {
  class Pool {
    async query(config: string | { text?: string }) {
      state.statements.push(typeof config === "string" ? config : (config.text ?? ""));
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
        release: () => {
          state.releases += 1;
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
    state.clientErrorListeners.clear();
  });

  it("should deallocate described statements and support repeated description", async () => {
    const shadow = await postgres({
      url: "postgres://target",
      shadowUrl: "postgres://shadow",
    }).shadow();
    await shadow.describe("SELECT $1::text AS value", ["value"]);
    await shadow.describe("SELECT $1::text AS value", ["value"]);
    expect(state.statements.filter((sql) => sql.startsWith("PREPARE"))).toHaveLength(2);
    expect(state.statements.filter((sql) => sql === "DEALLOCATE askr_describe")).toHaveLength(2);
    expect(state.releases).toBe(2);
    await shadow.close?.();
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
  });
});
