import { randomBytes } from "node:crypto";
import type { Connection, FieldDef, Pool, Submittable } from "pg";
import type { DatabaseToolingAdapter } from "./definition";
import { quoteIdentifier } from "./naming";
import { CheckedOutClient } from "./postgres-client";
import type { TableConstraint } from "./schema";
import type { SchemaSnapshot, SnapshotColumn, SnapshotTable } from "./tooling-impl";

const TOOLING_LOCK = "4707438161740730";
const userSchema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";

async function rows<T>(
  client: CheckedOutClient,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query({ text, values })).rows as T[];
}

/** A Describe/Sync exchange never binds or executes the prepared statement. */
class StatementMetadata implements Submittable {
  private fields: FieldDef[] = [];
  private resolve!: (fields: FieldDef[]) => void;
  private reject!: (error: unknown) => void;
  readonly result = new Promise<FieldDef[]>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  constructor(readonly sql?: string) {}
  submit(connection: Connection): void {
    if (this.sql === undefined) connection.describe({ type: "S", name: "askr_describe" }, false);
    else connection.parse({ name: "askr_describe", text: this.sql, types: [] }, false);
    connection.sync();
  }
  handleRowDescription(message: { fields: FieldDef[] }): void {
    this.fields = message.fields;
  }
  handleReadyForQuery(): void {
    this.resolve(this.fields);
  }
  handleError(error: unknown): void {
    this.reject(error);
  }
}

async function introspect(client: CheckedOutClient): Promise<SchemaSnapshot> {
  const relations = await rows<{
    oid: string;
    schema: string;
    name: string;
    kind: string;
    inherited: boolean;
    persistence: string;
  }>(
    client,
    `
    SELECT c.oid::text, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
      EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid) AS inherited, c.relpersistence AS persistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userSchema} AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  `,
  );
  const tables: SnapshotTable[] = [];
  const views: SchemaSnapshot["views"][number][] = [];
  for (const relation of relations) {
    if (relation.kind === "v") {
      const [view] = await rows<{ query: string }>(
        client,
        "SELECT pg_get_viewdef($1::oid, false) AS query",
        [relation.oid],
      );
      views.push({
        kind: "view",
        schema: relation.schema,
        name: relation.name,
        query: view!.query,
      });
      continue;
    }
    if (relation.kind !== "r")
      throw new Error(
        `PostgreSQL tooling cannot diff relation ${relation.schema}.${relation.name} of kind ${relation.kind}; use a supported ordinary table/view.`,
      );
    if (relation.inherited || relation.persistence !== "p")
      throw new Error(
        `Table ${relation.schema}.${relation.name} inheritance or persistence cannot be represented by the declaration.`,
      );
    const columns = await rows<{
      name: string;
      dataType: string;
      nullable: boolean;
      primaryKey: boolean;
      default: string | null;
      generated: string | null;
      identity: string;
      generatedMode: string;
      customCollation: boolean;
    }>(
      client,
      `
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS "dataType",
        NOT a.attnotnull AS nullable,
        EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'p' AND a.attnum = ANY(k.conkey)) AS "primaryKey",
        CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid, false) END AS "default",
        CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid, false) END AS generated,
        a.attidentity AS identity, a.attgenerated AS "generatedMode", a.attcollation <> t.typcollation AS "customCollation"
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
    `,
      [relation.oid],
    );
    const constraints = await rows<{
      kind: string;
      name: string;
      columns: string[];
      expression: string | null;
      referenceSchema: string | null;
      referenceTable: string | null;
      referenceColumns: string[];
      deleteAction: string;
      updateAction: string;
      match: string;
      deferred: boolean;
      validated: boolean;
      enforced: boolean;
      nullsNotDistinct: boolean;
    }>(
      client,
      `
      SELECT k.contype AS kind, k.conname AS name,
        ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(num, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num ORDER BY u.ord) AS columns,
        pg_get_expr(k.conbin, k.conrelid, false) AS expression,
        rn.nspname AS "referenceSchema", r.relname AS "referenceTable",
        ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(num, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num ORDER BY u.ord) AS "referenceColumns",
        k.confdeltype AS "deleteAction", k.confupdtype AS "updateAction", k.confmatchtype AS match,
        k.condeferrable AS deferred, k.convalidated AS validated,
        COALESCE((to_jsonb(k)->>'conenforced')::boolean, true) AS enforced,
        COALESCE(ci.indnullsnotdistinct, false) AS "nullsNotDistinct"
      FROM pg_constraint k LEFT JOIN pg_class r ON r.oid = k.confrelid LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace
      LEFT JOIN pg_index ci ON ci.indexrelid = k.conindid
      WHERE k.conrelid = $1::oid
    `,
      [relation.oid],
    );
    const snapshotColumns: SnapshotColumn[] = columns.map((column) => {
      if (column.customCollation || (column.generatedMode !== "" && column.generatedMode !== "s"))
        throw new Error(
          `Column ${relation.name}.${column.name} collation or generation mode cannot be represented by the declaration.`,
        );
      if (column.identity)
        throw new Error(
          `Identity column ${relation.name}.${column.name} requires explicit manual tooling support.`,
        );
      const foreign = constraints.filter(
        (constraint) => constraint.kind === "f" && constraint.columns.includes(column.name),
      );
      if (foreign.length > 1)
        throw new Error(
          `Multiple foreign keys on ${relation.name}.${column.name} cannot be represented by the declaration.`,
        );
      const reference = foreign[0];
      return {
        property: column.name,
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        unique: false,
        ...(column.default === null ? {} : { default: column.default }),
        ...(column.generated === null ? {} : { generated: column.generated }),
        ...(reference
          ? {
              reference: {
                schema: reference.referenceSchema!,
                table: reference.referenceTable!,
                column: reference.referenceColumns[0]!,
              },
            }
          : {}),
      };
    });
    const snapshotConstraints: TableConstraint[] = [];
    for (const constraint of constraints) {
      if (!constraint.enforced || constraint.nullsNotDistinct)
        throw new Error(
          `Unenforced or NULLS NOT DISTINCT constraint ${constraint.name} cannot be represented by the declaration.`,
        );
      if (constraint.deferred || !constraint.validated)
        throw new Error(
          `Deferred or unvalidated constraint ${constraint.name} cannot be represented by the declaration.`,
        );
      if (constraint.kind === "p" || constraint.kind === "n") continue;
      if (constraint.kind === "u")
        snapshotConstraints.push({
          kind: "unique",
          name: constraint.name,
          columns: constraint.columns,
        });
      else if (constraint.kind === "c")
        snapshotConstraints.push({
          kind: "check",
          name: constraint.name,
          expression: constraint.expression!,
        });
      else if (constraint.kind === "f") {
        if (
          constraint.columns.length !== 1 ||
          constraint.referenceColumns.length !== 1 ||
          constraint.deleteAction !== "a" ||
          constraint.updateAction !== "a" ||
          constraint.match !== "s"
        )
          throw new Error(
            `Foreign key ${constraint.name} cannot be represented by the declaration.`,
          );
      } else
        throw new Error(
          `Constraint ${constraint.name} of kind ${constraint.kind} cannot be represented by the declaration.`,
        );
    }
    const indexes = await rows<{
      name: string;
      expressions: string[];
      unique: boolean;
      method: string;
      where: string | null;
      valid: boolean;
      keyCount: number;
      totalCount: number;
      nullsNotDistinct: boolean;
    }>(
      client,
      `
      SELECT c.relname AS name, i.indisunique AS unique, m.amname AS method,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid, s, false) FROM generate_series(1, i.indnkeyatts) s) AS expressions,
        pg_get_expr(i.indpred, i.indrelid, false) AS "where", i.indisvalid AS valid,
        i.indnkeyatts AS "keyCount", i.indnatts AS "totalCount", i.indnullsnotdistinct AS "nullsNotDistinct"
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am m ON m.oid = c.relam
      WHERE i.indrelid = $1::oid AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
    `,
      [relation.oid],
    );
    for (const index of indexes) {
      if (!index.valid || index.keyCount !== index.totalCount || index.nullsNotDistinct)
        throw new Error(
          `Invalid or covering index ${index.name} cannot be represented by the declaration.`,
        );
      snapshotConstraints.push({
        kind: "index",
        name: index.name,
        expressions: index.expressions,
        unique: index.unique,
        method: index.method,
        ...(index.where === null ? {} : { where: index.where }),
      });
    }
    const primary = constraints.find((constraint) => constraint.kind === "p");
    tables.push({
      schema: relation.schema,
      name: relation.name,
      columns: snapshotColumns.sort((a, b) => a.name.localeCompare(b.name)),
      constraints: snapshotConstraints.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
      ...(primary && primary.columns.length > 1 ? { primaryKeyColumns: primary.columns } : {}),
    });
  }
  const enums = await rows<SchemaSnapshot["enums"][number]>(
    client,
    `
    SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE ${userSchema} AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    GROUP BY n.nspname, t.typname
  `,
  );
  const order = (a: { schema: string; name: string }, b: { schema: string; name: string }) =>
    `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  return {
    version: 1,
    enums: enums.sort(order),
    tables: tables.sort(order),
    views: views.sort(order),
  };
}

/** Proves actual database separation using database-local, session-owned locks. */
async function assertSeparate(shadow: CheckedOutClient, targetPool: Pool): Promise<void> {
  const target = new CheckedOutClient(await targetPool.connect());
  const bytes = randomBytes(8);
  const key = [bytes.readInt32BE(0), bytes.readInt32BE(4)];
  let targetLocked = false;
  let shadowLocked = false;
  try {
    // Keep the target lock's backend pinned even behind transaction pooling.
    await target.query("BEGIN READ ONLY");
    targetLocked =
      (
        await rows<{ locked: boolean }>(
          target,
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
          key,
        )
      )[0]?.locked === true;
    if (!targetLocked)
      throw new Error("Cannot establish target database separation; refusing scratch reset.");
    shadowLocked =
      (
        await rows<{ locked: boolean }>(
          shadow,
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
          key,
        )
      )[0]?.locked === true;
    const held =
      (
        await rows<{ unlocked: boolean }>(
          target,
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
          key,
        )
      )[0]?.unlocked === true;
    targetLocked = !held;
    if (!held || !shadowLocked)
      throw new Error(
        "PostgreSQL scratch must be a distinct actual database from target; refusing reset.",
      );
  } finally {
    if (shadowLocked) await shadow.cleanup(`SELECT pg_advisory_unlock(${key[0]}, ${key[1]})`);
    if (targetLocked) await target.cleanup(`SELECT pg_advisory_unlock(${key[0]}, ${key[1]})`);
    await target.cleanup("ROLLBACK");
    target.release();
  }
  shadow.assertHealthy();
}

export async function createPostgresTooling(
  shadowUrl: string,
  shadowPool: () => Promise<Pool>,
  targetPool: () => Promise<Pool>,
): Promise<DatabaseToolingAdapter> {
  const pool = await shadowPool();
  let client: CheckedOutClient | undefined;
  let closed = false;
  let queue = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = queue.then(async () => {
      try {
        return await operation();
      } catch (error) {
        if (client) {
          try {
            client.assertHealthy();
          } catch (failure) {
            client.release(failure);
            client = undefined;
          }
        }
        throw error;
      }
    });
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const connection = async () => {
    if (closed) throw new Error("PostgreSQL scratch adapter is closed.");
    if (!client) {
      const acquired = new CheckedOutClient(await pool.connect());
      try {
        await acquired.query(`SELECT pg_advisory_lock(${TOOLING_LOCK})`);
      } catch (error) {
        acquired.release(error);
        throw error;
      }
      client = acquired;
    }
    client.assertHealthy();
    return client;
  };
  const adapter: DatabaseToolingAdapter = {
    identity: shadowUrl,
    async reset() {
      const current = await connection();
      const target = await targetPool();
      try {
        await assertSeparate(current, target);
      } finally {
        await target.end();
      }
      await current.query("BEGIN");
      try {
        const schemas = await rows<{ name: string }>(
          current,
          `SELECT n.nspname AS name FROM pg_namespace n WHERE ${userSchema}`,
        );
        for (const schema of schemas)
          await current.query(`DROP SCHEMA ${quoteIdentifier(schema.name)} CASCADE`);
        await current.query('CREATE SCHEMA "public"');
        await current.query("COMMIT");
      } catch (error) {
        await current.cleanup("ROLLBACK");
        throw error;
      }
    },
    async execute(sql) {
      await (await connection()).query(sql);
    },
    async introspect() {
      return introspect(await connection());
    },
    async describe(sql, parameterNames) {
      const current = await connection();
      let prepared = false;
      let failed = false;
      let primaryError: unknown;
      let result: Awaited<ReturnType<DatabaseToolingAdapter["describe"]>> | undefined;
      try {
        const prepare = new StatementMetadata(sql);
        current.startStream(prepare);
        await prepare.result;
        prepared = true;
        const description = new StatementMetadata();
        current.startStream(description);
        const fields = await description.result;
        const columns = [];
        for (const field of fields) {
          const [metadata] = await rows<{ dataType: string }>(
            current,
            'SELECT format_type($1::oid, $2::integer) AS "dataType"',
            [field.dataTypeID, field.dataTypeModifier],
          );
          // RowDescription does not encode outer-join/expression nullability.
          columns.push({ name: field.name, dataType: metadata!.dataType, nullable: true });
        }
        result = { parameters: [...parameterNames], columns };
      } catch (error) {
        failed = true;
        primaryError = error;
      }
      if (prepared) {
        try {
          await current.query("DEALLOCATE askr_describe");
        } catch (error) {
          current.release(error);
          client = undefined;
          if (!failed) {
            failed = true;
            primaryError = error;
          }
        }
      }
      if (failed) throw primaryError;
      return result!;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (client) {
        await client.cleanup("ROLLBACK");
        await client.cleanup(`SELECT pg_advisory_unlock(${TOOLING_LOCK})`);
        client.release();
        client = undefined;
      }
      await pool.end();
    },
  };
  return {
    identity: shadowUrl,
    reset: () => serialized(() => adapter.reset()),
    execute: (sql) => serialized(() => adapter.execute(sql)),
    introspect: () => serialized(() => adapter.introspect()),
    describe: (sql, parameters) => serialized(() => adapter.describe(sql, parameters)),
    close: () => serialized(() => adapter.close!()),
  };
}
