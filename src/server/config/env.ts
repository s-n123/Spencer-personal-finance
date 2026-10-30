import { z } from "zod";

// Environment holds secrets and deployment wiring only. Product tunables live in policy.ts.
// Validation is lazy (getEnv) so `next build`, tests and scripts don't fail on import when a
// production-only secret is absent; instrumentation.ts validates eagerly at server start.

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url().optional());

// Empty counts as unset; when set, a shared secret must be long enough to resist guessing.
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().min(32).optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  // Set by Vercel when Protection Bypass for Automation is on; lets self-handoff reach a
  // protected preview deployment.
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_MAIN: z.string().min(1).default("claude-sonnet-5-5"),
  MODEL_FAST: z.string().min(1).default("claude-haiku-5-5"),
  MODEL_MAIN_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  // "anthropic" calls the API; "fake" is a deterministic offline model for demos without a key.
  LLM_PROVIDER: z.enum(["anthropic", "fake"]).default("anthropic"),
  // Server-side refusal fallback (beta). Covers only some refusal categories; see DECISIONS D-038.
  ANTHROPIC_FALLBACKS: z.enum(["default", "off"]).default("default"),

  // Database
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@127.0.0.1:54330/postgres"),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),

  // Simulator (hard-off in production regardless of this flag)
  ENABLE_SIMULATOR: bool,

  // Media storage
  MEDIA_STORAGE: z.enum(["local", "vercel-blob"]).default("local"),
  MEDIA_LOCAL_DIR: z.string().default(".data/media"),

  // App wiring
  DEFAULT_TIMEZONE: z.string().default("America/New_York"),
  APP_BASE_URL: optionalUrl,
  // The only authentication on /api/internal/kick: at least 32 characters when set.
  INTERNAL_KICK_SECRET: optionalSecret,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      // Report key names only, never values.
      const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${keys}`);
    }
    cached = parsed.data;
    assertProductionInvariants(cached);
  }
  return cached;
}

/** For tests: forget the memoized env so process.env changes take effect. */
export function resetEnvForTests(): void {
  cached = undefined;
}

/** The simulator is never available on a production deployment, whatever the flag says. */
export function simulatorEnabled(env: Env = getEnv()): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.ENABLE_SIMULATOR;
}

function assertProductionInvariants(env: Env): void {
  if (env.VERCEL_ENV === "production") {
    if (env.ENABLE_SIMULATOR) {
      throw new Error("ENABLE_SIMULATOR must not be set on a production deployment");
    }
    if (env.LOG_LEVEL === "debug") {
      throw new Error("LOG_LEVEL=debug is not allowed in production");
    }
    if (env.LLM_PROVIDER === "fake") {
      throw new Error("LLM_PROVIDER=fake is not allowed in production");
    }
    if (process.env.ANTHROPIC_LOG === "debug") {
      throw new Error("ANTHROPIC_LOG=debug is not allowed in production");
    }
  }
}
