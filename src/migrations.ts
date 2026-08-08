import type { DatabaseAdapter, QueryOptions } from "./adapter";
import { normalizeDatabaseError } from "./errors";

export interface BundledMigration {
  readonly id: string;
  readonly parent: string | null;
  readonly checksum: string;
  readonly sql: string;
  readonly transactional: boolean;
  readonly risk?: "safe" | "review" | "destructive";
}

export interface MigrationManifest {
  readonly migrations: readonly BundledMigration[];
}

export interface AppliedMigration {
  readonly id: string;
  readonly parent: string | null;
  readonly checksum: string;
  readonly state: "applying" | "applied" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export interface MigrationPlanEntry extends BundledMigration {
  readonly status: "pending";
}

export interface MigrationPlan {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationPlanEntry[];
}

export interface MigrationEvent {
  readonly type: "lock-acquired" | "started" | "applied" | "failed" | "complete";
  readonly migration?: string;
  readonly durationMs?: number;
}

export interface MigrationApplyOptions extends QueryOptions {
  readonly onEvent?: (event: MigrationEvent) => void;
}

export interface MigrationApplyResult {
  readonly applied: readonly string[];
}

export interface MigrationsApi {
  plan(options?: QueryOptions): Promise<MigrationPlan>;
  apply(options?: MigrationApplyOptions): Promise<MigrationApplyResult>;
  resolve(id: string, resolution: "applied" | "rolled-back", options?: QueryOptions): Promise<void>;
}

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS "_askr_migrations" (
  "id" text PRIMARY KEY,
  "parent" text,
  "checksum" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('applying', 'applied', 'failed')),
  "started_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" timestamptz,
  "duration_ms" double precision
)`.trim();

function validateManifest(manifest: MigrationManifest): void {
  const ids = new Set<string>();
  let parent: string | null = null;
  for (const migration of manifest.migrations) {
    if (ids.has(migration.id)) throw new Error(`Duplicate migration ${migration.id}.`);
    if (migration.parent !== parent) {
      throw new Error(
        `Forked or reordered migration chain at ${migration.id}: expected parent ${parent ?? "<root>"}.`,
      );
    }
    ids.add(migration.id);
    parent = migration.id;
  }
}

async function history(
  adapter: DatabaseAdapter,
  options: QueryOptions,
): Promise<readonly AppliedMigration[]> {
  await adapter.execute({ text: LEDGER_SQL, values: [] }, options);
  const result = await adapter.execute<Record<string, unknown>>(
    {
      text: `SELECT "id", "parent", "checksum", "state", "started_at" AS "startedAt", "finished_at" AS "finishedAt", "duration_ms" AS "durationMs" FROM "_askr_migrations" ORDER BY "started_at", "id"`,
      values: [],
    },
    options,
  );
  return result.rows as unknown as readonly AppliedMigration[];
}

function buildPlan(
  manifest: MigrationManifest,
  applied: readonly AppliedMigration[],
): MigrationPlan {
  validateManifest(manifest);
  if (applied.some((entry) => entry.state !== "applied")) {
    const failed = applied.find((entry) => entry.state !== "applied")!;
    throw new Error(
      `Migration ${failed.id} is ${failed.state}; inspect the database and run migration resolve.`,
    );
  }
  if (applied.length > manifest.migrations.length) {
    throw new Error("Target history contains migrations missing from the bundled manifest.");
  }
  applied.forEach((entry, index) => {
    const bundled = manifest.migrations[index];
    if (!bundled || bundled.id !== entry.id) {
      throw new Error(`Migration history is missing, reordered, or forked at ${entry.id}.`);
    }
    if (bundled.parent !== entry.parent) {
      throw new Error(`Migration ${entry.id} has a different parent than the bundled history.`);
    }
    if (bundled.checksum !== entry.checksum) {
      throw new Error(`Migration ${entry.id} checksum drift detected.`);
    }
  });
  return {
    applied,
    pending: manifest.migrations.slice(applied.length).map((entry) => ({
      ...entry,
      status: "pending" as const,
    })),
  };
}

async function recordState(
  adapter: DatabaseAdapter,
  migration: BundledMigration,
  state: AppliedMigration["state"],
  durationMs: number | null,
  options: QueryOptions,
): Promise<void> {
  await adapter.execute(
    {
      text: `INSERT INTO "_askr_migrations" ("id", "parent", "checksum", "state", "started_at", "finished_at", "duration_ms")
VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CASE WHEN $4 = 'applying' THEN NULL ELSE CURRENT_TIMESTAMP END, $5)
ON CONFLICT ("id") DO UPDATE SET "state" = EXCLUDED."state", "finished_at" = EXCLUDED."finished_at", "duration_ms" = EXCLUDED."duration_ms"`,
      values: [migration.id, migration.parent, migration.checksum, state, durationMs],
    },
    options,
  );
}

async function applyOne(
  adapter: DatabaseAdapter,
  migration: BundledMigration,
  options: MigrationApplyOptions,
): Promise<number> {
  const started = performance.now();
  options.onEvent?.({ type: "started", migration: migration.id });
  if (migration.transactional) {
    await adapter.transaction(
      async (transaction) => {
        await transaction.execute({ text: migration.sql, values: [] }, options);
        await recordState(transaction, migration, "applied", performance.now() - started, options);
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
  } else {
    await recordState(adapter, migration, "applying", null, options);
    try {
      await adapter.execute({ text: migration.sql, values: [] }, options);
      await recordState(adapter, migration, "applied", performance.now() - started, options);
    } catch (error) {
      await recordState(adapter, migration, "failed", performance.now() - started, options).catch(
        () => undefined,
      );
      throw error;
    }
  }
  const durationMs = performance.now() - started;
  options.onEvent?.({ type: "applied", migration: migration.id, durationMs });
  return durationMs;
}

export function createMigrationsApi(
  adapter: DatabaseAdapter,
  manifest: MigrationManifest,
): MigrationsApi {
  validateManifest(manifest);
  return {
    async plan(options = {}) {
      try {
        return buildPlan(manifest, await history(adapter, options));
      } catch (error) {
        throw normalizeDatabaseError(error);
      }
    },

    async apply(options = {}) {
      if (!adapter.migrationLock) {
        throw new Error(
          "Migration apply requires dialect migration locking support.",
        );
      }
      try {
        return await adapter.migrationLock(async (session) => {
          options.onEvent?.({ type: "lock-acquired" });
          const applied: string[] = [];
          const plan = buildPlan(manifest, await history(session, options));
          for (const migration of plan.pending) {
            try {
              await applyOne(session, migration, options);
              applied.push(migration.id);
            } catch (error) {
              options.onEvent?.({ type: "failed", migration: migration.id });
              throw error;
            }
          }
          options.onEvent?.({ type: "complete" });
          return { applied };
        });
      } catch (error) {
        throw normalizeDatabaseError(error);
      }
    },

    async resolve(id, resolution, options = {}) {
      const bundled = manifest.migrations.find((entry) => entry.id === id);
      if (!bundled) throw new Error(`Unknown bundled migration ${id}.`);
      const applied = await history(adapter, options);
      const entry = applied.find((candidate) => candidate.id === id);
      if (!entry || entry.state === "applied") {
        throw new Error(`Migration ${id} is not in a failed or applying state.`);
      }
      if (resolution === "rolled-back") {
        await adapter.execute(
          { text: `DELETE FROM "_askr_migrations" WHERE "id" = $1`, values: [id] },
          options,
        );
      } else {
        await recordState(adapter, bundled, "applied", entry.durationMs, options);
      }
    },
  };
}
