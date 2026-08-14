import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Per-process reports directory: the external watcher runs `make all`
      // concurrently with manual runs, and two Vitests sharing one directory
      // race on coverage/.tmp (one wipes the other's files and the run dies).
      reportsDirectory: join("coverage", process.pid.toString()),
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "src/index.ts"],
      thresholds: {
        branches: 70,
        functions: 90,
        lines: 85,
        statements: 80,
      },
    },
  },
});
