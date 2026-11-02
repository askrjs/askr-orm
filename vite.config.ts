import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
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
