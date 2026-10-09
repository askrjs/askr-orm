import { expect, it, vi } from "vitest";
import { defineDatabase, type MigrationsApi } from "./index";
import { sqlite } from "./sqlite";

it.each(["plan", "apply", "resolve"] as const)(
  "should reject escaped transaction migration %s before any SQL and leave the root usable",
  async (operation) => {
    const adapter = await sqlite({ filename: ":memory:" }).open();
    const db = await defineDatabase({
      tables: {},
      driver: {
        dialect: "sqlite",
        open: async () => adapter,
        shadow: async () => {
          throw new Error("No shadow in lifetime probe.");
        },
      },
    }).open();
    let escaped!: MigrationsApi;
    try {
      await db.transaction(async (transaction) => {
        escaped = transaction.migrations;
      });
      const execute = vi.spyOn(adapter, "execute");
      const calls = {
        plan: () => escaped.plan(),
        apply: () => escaped.apply(),
        resolve: () => escaped.resolve("01EXPIRED", "applied"),
      };
      await expect(calls[operation]()).rejects.toThrow("Transaction client is no longer active.");
      expect(execute).not.toHaveBeenCalled();
      execute.mockRestore();
      await expect(db.migrations.plan()).resolves.toEqual({ applied: [], pending: [] });
    } finally {
      await db.close();
    }
  },
);
