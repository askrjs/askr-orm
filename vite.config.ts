import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      tooling: "src/tooling.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    dts: true,
    unbundle: true,
    outExtensions: () => ({ js: ".js" }),
    deps: {
      neverBundle: ["tsx/esm/api", "typescript"],
    },
  },
});
