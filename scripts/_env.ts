// Import first in every script: loads .env.local / .env the same way `next dev` does.
// (Plain tsx loads neither.)
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
