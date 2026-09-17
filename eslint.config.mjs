import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Linted files outside every tsconfig include: the vitest config and the
          // CommonJS require-hook the inventory harness loads into the adapter process
          // (`*.config.mjs` is ignored below, the ioBroker template files under `test/`
          // are .js and ignored, the standards suite is covered by tsconfig.json).
          allowDefaultProject: ["vitest.config.mts", "test/inventory-dns-hook.cjs"],
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
      // Only the ioBroker template files stay out — the synchronised standards suite
      // test/standards/repo-standards.test.ts is linted like every test file.
      "test/*.js",
      "*.config.mjs",
      "build",
      "admin",
      "coverage",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
