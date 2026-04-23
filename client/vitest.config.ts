import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/features/zap/**/*.ts",
        "src/utils/errorDecoder.ts",
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/features/zap/types.ts",
        "src/features/zap/index.ts",
        "src/features/zap/ZapDepositPanel.tsx",
        // vestingService contains Soroban RPC + Freighter integration code that
        // requires a live node — covered by integration tests, not unit coverage.
        "src/pages/vesting/vestingService.ts",
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
