import { defineConfig } from 'vitest/config';

/**
 * Vitest replaces mocha+ts-node for `src/**\/*.test.ts` (v1.32.0 onwards).
 *
 * `test/package.js` + `test/integration.js` keep using mocha because
 * `@iobroker/testing` is mocha-only.
 *
 * Pattern aus govee-smart v2.6.4 übernommen — kein chai-`should()`-Setup nötig,
 * Tests nutzen `import { expect } from 'chai'` mit Jest/chai-kompatibler API
 * der vitest-expect.
 */
export default defineConfig({
    test: {
        globals: true,
        include: ['src/**/*.test.ts'],
        watch: false,
        pool: 'forks',
        forks: { singleFork: true },
    },
});
