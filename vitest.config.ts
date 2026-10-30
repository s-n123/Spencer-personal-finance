import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: serverOnlyStub },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    // An odd timezone so any reliance on the host timezone fails loudly.
    env: { TZ: "Pacific/Chatham", NODE_ENV: "test" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["src/**/*.pg.test.ts", "node_modules/**"],
          globalSetup: ["src/test/global-setup.ts"],
          pool: "forks",
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "pg",
          include: ["src/**/*.pg.test.ts"],
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
