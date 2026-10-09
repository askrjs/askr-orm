import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.fixture.ts"],
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      postgres: "src/postgres.ts",
      sqlite: "src/sqlite.ts",
      tooling: "src/tooling.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    dts: true,
    unbundle: true,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      neverBundle: ["pg", "pg-query-stream", "tsx/esm/api", "typescript"],
    },
  },
});
