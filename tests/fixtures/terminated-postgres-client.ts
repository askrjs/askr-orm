import { Pool } from "pg";
import { DatabaseError } from "../../src/errors";
import { postgres } from "../../src/postgres";

const databaseUrl = process.env.ASKR_ORM_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("ASKR_ORM_TEST_DATABASE_URL is required.");

const adapter = await postgres({ url: databaseUrl }).open();
const killer = new Pool({ connectionString: databaseUrl });

try {
  await adapter.transaction(async (transaction) => {
    const result = await transaction.execute<{ pid: number }>({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    });
    await killer.query("SELECT pg_terminate_backend($1)", [result.rows[0]!.pid]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await transaction.execute({ text: "SELECT 1", values: [] });
  });
  throw new Error("Terminated transaction unexpectedly succeeded.");
} catch (error) {
  if (!(error instanceof DatabaseError) || error.category !== "connection") throw error;
  process.stdout.write(`caught:${error.category}:${error.code ?? "unknown"}\n`);
} finally {
  await killer.end();
  await adapter.close?.();
}
