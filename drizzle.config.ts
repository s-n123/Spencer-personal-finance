import { defineConfig } from "drizzle-kit";

// drizzle-kit 0.31 (pinned). Migrations always go to the unpooled URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:54330/postgres",
  },
  strict: true,
  verbose: true,
});
