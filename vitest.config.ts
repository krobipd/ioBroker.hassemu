import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    watch: false,
    pool: "forks",
    forks: { singleFork: false },
    coverage: {
      // Honest coverage: count ALL source files, not only the ones imported
      // by tests (v8 default would silently hide untested files like main.ts).
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
