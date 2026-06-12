import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.mjs", "test/*.ts", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "**/*.test.ts",
      "*.test.js",
      "test/**",
      "*.config.mjs",
      "build",
      "admin",
      "coverage",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
