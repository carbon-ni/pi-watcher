import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
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
