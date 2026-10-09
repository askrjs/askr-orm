import { it } from "vitest";
import { sqlite } from "./sqlite";
import { assertValueConformance } from "./value-conformance.fixture";

it("should preserve null, empty, binary and large values through SQLite binding and recover from constraints", async () => {
  const adapter = await sqlite({ filename: ":memory:" }).open();
  try {
    await assertValueConformance(adapter, "sqlite");
  } finally {
    await adapter.close?.();
  }
});
