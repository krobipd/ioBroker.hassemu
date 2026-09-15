import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The vitest config is the only linted file outside tsconfig's include
          // (`*.config.mjs` is ignored below, `test/**` is .js and ignored too).
          allowDefaultProject: ["vitest.config.mts"],
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
      // Session files of the note-taking hook: its cooldown marker
      // tmp/last-ndc.ts is a timestamp, not TypeScript — never lint them.
      ".remember/**",
      ".dev-server/",
      ".vscode/",
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
