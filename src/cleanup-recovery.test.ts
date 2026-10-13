import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { sqlite } from "./sqlite";

describe("SQLite cleanup failure and persisted recovery", () => {
  it.each(["root", "nested", "root-close"] as const)(
    "should discard the connection after %s rollback failure and release its shared-file lock",
    async (phase) => {
      const root = await mkdtemp(path.join(tmpdir(), "askr-orm-cleanup-"));
      const filename = path.join(root, "probe.sqlite");
      const first = await sqlite({ filename }).open();
      const second = await sqlite({ filename }).open();
      const primary = new Error("callback failed");
      const originalExec = DatabaseSync.prototype.exec;
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        if (
          (phase !== "nested" && sql === "ROLLBACK") ||
          (phase === "nested" && sql.startsWith("ROLLBACK TO SAVEPOINT"))
        )
          throw new Error("rollback transport failed");
        return originalExec.call(this, sql);
      });
      const close =
        phase === "root-close"
          ? vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
              throw new Error("close temporarily failed");
            })
          : undefined;
      try {
        await first.execute({
          text: 'CREATE TABLE "items" ("id" integer PRIMARY KEY)',
          values: [],
        });
        const pending = first.transaction(async (outer) => {
          if (phase !== "nested") {
            await outer.execute({ text: 'INSERT INTO "items" VALUES ($1)', values: [1] });
            throw primary;
          }
          await expect(
            outer.transaction(async (inner) => {
              await inner.execute({ text: 'INSERT INTO "items" VALUES ($1)', values: [1] });
              throw primary;
            }),
          ).rejects.toBe(primary);
          // Handling the nested error cannot make its unrolled-back writes safe.
        });
        if (phase !== "nested") await expect(pending).rejects.toBe(primary);
        else await expect(pending).rejects.toThrow(/closed|not open/);
        await expect(first.execute({ text: 'SELECT * FROM "items"', values: [] })).rejects.toThrow(
          /closed/,
        );
        // An explicit close must retry a failed quarantine close before recovery.
        if (close) {
          await first.close?.();
          expect(close).toHaveBeenCalledTimes(2);
          close.mockRestore();
        }
        exec.mockRestore();
        await expect(
          second.execute({ text: 'SELECT * FROM "items"', values: [] }),
        ).resolves.toMatchObject({ rows: [] });
        await second.execute({ text: 'INSERT INTO "items" VALUES ($1)', values: [2] });
        await first.close?.();
        await second.close?.();
        const reopened = await sqlite({ filename }).open();
        try {
          expect(
            (await reopened.execute({ text: 'SELECT * FROM "items"', values: [] })).rows,
          ).toEqual([{ id: 2 }]);
        } finally {
          await reopened.close?.();
        }
      } finally {
        close?.mockRestore();
        exec.mockRestore();
        await first.close?.();
        await second.close?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
