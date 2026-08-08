import { describe, expect, it } from "vitest";
import type { DatabaseAdapter, ExecutionResult, QueryOptions, TransactionOptions } from "./adapter";
import { createMigrationsApi, type AppliedMigration, type MigrationManifest } from "./migrations";
import type { SqlQuery } from "./sql";

class MigrationAdapter implements DatabaseAdapter {
  readonly identity = "target";
  readonly statements: string[] = [];
  readonly ledger: AppliedMigration[] = [];
  transactions = 0;
  sessions = 0;
  failSql = false;

  async execute<Row = Record<string, unknown>>(
    query: SqlQuery,
    _options?: QueryOptions,
  ): Promise<ExecutionResult<Row>> {
    this.statements.push(query.text);
    if (query.text.includes('SELECT "id", "parent"')) {
      return { rows: this.ledger as unknown as Row[], rowCount: this.ledger.length };
    }
    if (query.text.startsWith('INSERT INTO "_askr_migrations"')) {
      const [id, parent, checksum, state, durationMs] = query.values;
      const next: AppliedMigration = {
        id: String(id),
        parent: parent === null ? null : String(parent),
        checksum: String(checksum),
        state: state as AppliedMigration["state"],
        startedAt: new Date().toISOString(),
        finishedAt: state === "applying" ? null : new Date().toISOString(),
        durationMs: durationMs as number | null,
      };
      const index = this.ledger.findIndex((entry) => entry.id === next.id);
      if (index < 0) this.ledger.push(next);
      else this.ledger[index] = next;
    }
    if (query.text.startsWith('DELETE FROM "_askr_migrations"')) {
      const index = this.ledger.findIndex((entry) => entry.id === query.values[0]);
      if (index >= 0) this.ledger.splice(index, 1);
    }
    if (query.text === "SELECT 1" && this.failSql) {
      throw Object.assign(new Error("migration failed"), { code: "XX000" });
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(
    callback: (adapter: DatabaseAdapter) => Promise<T>,
    _options?: TransactionOptions,
  ): Promise<T> {
    this.transactions += 1;
    const before = [...this.ledger];
    try {
      return await callback(this);
    } catch (error) {
      this.ledger.splice(0, this.ledger.length, ...before);
      throw error;
    }
  }

  async session<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    this.sessions += 1;
    return callback(this);
  }

  async migrationLock<T>(callback: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.session(callback);
  }
}

const manifest: MigrationManifest = {
  migrations: [
    {
      id: "01",
      parent: null,
      checksum: "one",
      sql: "SELECT 1",
      transactional: true,
      risk: "safe",
    },
    {
      id: "02",
      parent: "01",
      checksum: "two",
      sql: "SELECT 2",
      transactional: false,
      risk: "review",
    },
  ],
};

describe("migrations", () => {
  it("should plan and apply under a pinned advisory-locked session", async () => {
    const adapter = new MigrationAdapter();
    const events: string[] = [];
    const api = createMigrationsApi(adapter, manifest);
    expect((await api.plan()).pending.map((entry) => entry.id)).toEqual(["01", "02"]);
    await expect(api.apply({ onEvent: (event) => events.push(event.type) })).resolves.toEqual({
      applied: ["01", "02"],
    });
    expect(adapter.sessions).toBe(1);
    expect(adapter.transactions).toBe(1);
    expect(events).toEqual([
      "lock-acquired",
      "started",
      "applied",
      "started",
      "applied",
      "complete",
    ]);
  });

  it("should reject checksum drift and failed history", async () => {
    const adapter = new MigrationAdapter();
    adapter.ledger.push({
      id: "01",
      parent: null,
      checksum: "edited",
      state: "applied",
      startedAt: "",
      finishedAt: "",
      durationMs: 1,
    });
    await expect(createMigrationsApi(adapter, manifest).plan()).rejects.toThrow(/checksum drift/);
    adapter.ledger[0] = { ...adapter.ledger[0]!, checksum: "one", state: "failed" };
    await expect(createMigrationsApi(adapter, manifest).plan()).rejects.toThrow(
      /inspect the database and run migration resolve/,
    );
  });

  it("should fail closed for interrupted non-transactional migrations", async () => {
    const adapter = new MigrationAdapter();
    adapter.ledger.push({
      id: "01",
      parent: null,
      checksum: "one",
      state: "applied",
      startedAt: "",
      finishedAt: "",
      durationMs: 1,
    });
    const api = createMigrationsApi(adapter, manifest);
    adapter.failSql = false;
    const originalExecute = adapter.execute.bind(adapter);
    adapter.execute = async <Row>(query: SqlQuery, options?: QueryOptions) => {
      if (query.text === "SELECT 2") throw new Error("connection lost");
      return originalExecute<Row>(query, options);
    };
    await expect(api.apply()).rejects.toThrow(/connection lost/);
    expect(adapter.ledger.find((entry) => entry.id === "02")?.state).toBe("failed");
    await expect(api.plan()).rejects.toThrow(/migration resolve/);
    await api.resolve("02", "rolled-back");
    expect(adapter.ledger.some((entry) => entry.id === "02")).toBe(false);
  });
});
