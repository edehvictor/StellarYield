import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/features/zap/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/features/zap/types.ts",
        "src/features/zap/index.ts",
        "src/features/zap/ZapDepositPanel.tsx",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 75,
        statements: 90,
      },
    },
  },
});
