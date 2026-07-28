import { performance } from "node:perf_hooks";
import {
  createDatabaseClient,
  eq,
  table,
  text,
  uuid,
} from "../dist/index.js";

const gate = process.argv.includes("--gate");
const iterations = 20_000;

class BenchmarkAdapter {
  calls = 0;
  rows = [];

  async execute() {
    this.calls += 1;
    return { rows: this.rows, rowCount: this.rows.length || 1 };
  }

  async transaction(callback) {
    return callback(this);
  }
}

const users = table("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull(),
});
const adapter = new BenchmarkAdapter();
const db = createDatabaseClient({ users }, adapter);

async function measure(callback) {
  const started = performance.now();
  await callback();
  return performance.now() - started;
}

for (let index = 0; index < 500; index += 1) {
  await adapter.execute({ text: "SELECT 1", values: [] });
  await db.users.insert({ email: "warmup@example.com" });
}

adapter.calls = 0;
const rawMs = await measure(async () => {
  for (let index = 0; index < iterations; index += 1) {
    await adapter.execute({ text: "INSERT", values: ["bench@example.com"] });
  }
});
const rawCalls = adapter.calls;

adapter.calls = 0;
const crudMs = await measure(async () => {
  for (let index = 0; index < iterations; index += 1) {
    await db.users.insert({ email: "bench@example.com" });
  }
});
const crudCalls = adapter.calls;

const prepared = db.users
  .where(({ users: columns }) => eq(columns.email, "bench@example.com"))
  .prepare("users-by-email");
adapter.calls = 0;
const preparedMs = await measure(async () => {
  for (let index = 0; index < iterations; index += 1) await prepared.execute();
});
const preparedCalls = adapter.calls;

adapter.calls = 0;
const inputs = Array.from({ length: 10_000 }, (_, index) => ({
  email: `bulk-${index}@example.com`,
}));
const bulkMs = await measure(() => db.users.insertMany(inputs, { chunkSize: 1000 }));
const bulkCalls = adapter.calls;

const result = {
  schemaVersion: 1,
  iterations,
  raw: { milliseconds: Number(rawMs.toFixed(3)), calls: rawCalls },
  generatedCrud: {
    milliseconds: Number(crudMs.toFixed(3)),
    calls: crudCalls,
    overheadRatio: Number((crudMs / rawMs).toFixed(3)),
  },
  preparedBuilder: {
    milliseconds: Number(preparedMs.toFixed(3)),
    calls: preparedCalls,
  },
  bulk10k: {
    milliseconds: Number(bulkMs.toFixed(3)),
    calls: bulkCalls,
    chunkSize: 1000,
  },
};

console.log(JSON.stringify(result));

if (
  gate &&
  (crudCalls !== rawCalls ||
    preparedCalls !== iterations ||
    bulkCalls !== 10 ||
    result.generatedCrud.overheadRatio > 60)
) {
  console.error("Runtime performance contract exceeded its regression gate.");
  process.exitCode = 1;
}
