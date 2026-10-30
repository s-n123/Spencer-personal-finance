import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";
import { resetEnvForTests } from "@/server/config/env";
import { AppError, logError, sanitizeError } from "@/server/errors";
import { filterFields, log, type LogFields } from "@/server/log";

// D-103 canary: errors from the DB layer embed bound parameters (DrizzleQueryError.message) and
// row contents (pg `detail`). None of it may reach a log line; only name, SQLSTATE, constraint and
// table survive. The logger itself drops any field that isn't allowlisted.

const CANARY = "canary-3f9a7c1e";
const PHONE = "+12015550177";

let lines: string[];

beforeEach(() => {
  vi.stubEnv("LOG_LEVEL", "debug");
  resetEnvForTests();
  lines = [];
  const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

/** Shaped like what node-postgres throws for a unique violation, wrapped the way drizzle does. */
function drizzleUniqueViolation(): DrizzleQueryError {
  const pgError = Object.assign(
    new Error(`duplicate key value violates unique constraint "users_phone_e164_key" ${CANARY}`),
    {
      name: "error",
      code: "23505",
      severity: "ERROR",
      constraint: "users_phone_e164_key",
      table: "users",
      schema: "public",
      detail: `Key (phone_e164)=(${PHONE}) already exists. Failing row contains (${PHONE}, ${CANARY}).`,
      where: `SQL statement "insert ... ${CANARY}"`,
    },
  );
  return new DrizzleQueryError(
    "insert into users (phone_e164, provider, text) values ($1, $2, $3)",
    [PHONE, "simulator", `I ate ${CANARY}`],
    pgError,
  );
}

function output(): string {
  return lines.join("\n");
}

describe("sanitizeError", () => {
  it("keeps only structured fields from a DrizzleQueryError and its pg cause", () => {
    const err = drizzleUniqueViolation();
    // Precondition: the raw error really does carry the content.
    expect(err.message).toContain(PHONE);

    const s = sanitizeError(err);
    expect(s).toMatchObject({ sqlState: "23505", constraint: "users_phone_e164_key", table: "users" });
    const json = JSON.stringify(s);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain(PHONE);
    expect(json).not.toContain("Failing row");
  });

  it("ignores a non-SQLSTATE code and non-Error values", () => {
    const err = Object.assign(new Error(CANARY), { code: CANARY });
    expect(JSON.stringify(sanitizeError(err))).not.toContain(CANARY);
    expect(sanitizeError(`thrown string ${CANARY} ${PHONE}`)).toEqual({ errorName: "string" });
    expect(sanitizeError({ message: CANARY })).toEqual({ errorName: "object" });
  });
});

describe("logError", () => {
  it("never writes the canary or the phone number", () => {
    logError("db.insert_failed", drizzleUniqueViolation(), { userId: "u-1" });
    logError("app.failed", new AppError("sim_media_not_found"), { route: "dev.sim.media" });
    logError("odd.failed", new TypeError(`bad ${CANARY} ${PHONE}`));
    const out = output();
    expect(out).toContain("23505");
    expect(out).toContain("sim_media_not_found");
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain(PHONE);
  });

  it("drops content fields passed alongside the error", () => {
    logError("x", new Error("e"), { text: CANARY, phone: PHONE, userId: "u-2" } as LogFields);
    expect(output()).not.toContain(CANARY);
    expect(output()).not.toContain(PHONE);
    expect(output()).toContain("u-2");
  });
});

describe("instrumentation onRequestError", () => {
  type Args = Parameters<typeof onRequestError>;
  const request: Args[1] = {
    path: `/api/dev/sim/thread?phone=${encodeURIComponent(PHONE)}&q=${CANARY}`,
    method: "GET",
    headers: { authorization: `Bearer ${CANARY}`, cookie: `s=${CANARY}`, "x-phone": PHONE },
  };
  const context = {
    routerKind: "App Router",
    routePath: "/api/dev/sim/thread",
    routeType: "route",
    revalidateReason: undefined,
  } as Args[2];

  it("logs the route pattern, kind and method only: never the path, query, headers or message", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await onRequestError(drizzleUniqueViolation(), request, context);
    await onRequestError(Object.assign(new Error(`boom ${CANARY} ${PHONE}`), { digest: CANARY }), request, context);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      level: "error",
      event: "request.error",
      route: "/api/dev/sim/thread",
      kind: "route",
      method: "GET",
      errorName: expect.any(String),
      sqlState: "23505",
      constraint: "users_phone_e164_key",
      table: "users",
    });
    const out = output();
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(encodeURIComponent(PHONE));
  });

  it("does nothing outside the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("x"), request, context);
    expect(lines).toEqual([]);
  });
});

describe("log allowlist", () => {
  it("drops fields that aren't allowlisted", () => {
    log.info("inbound.accepted", {
      userId: "u-3",
      count: 2,
      text: CANARY,
      body: CANARY,
      phone: PHONE,
      fromE164: PHONE,
      storageKey: `users/u-3/${CANARY}.jpg`,
      prompt: CANARY,
    });
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(line).toEqual({ level: "info", event: "inbound.accepted", userId: "u-3", count: 2 });
  });

  it("caps allowlisted strings so they can't smuggle a message body", () => {
    expect(filterFields({ reason: "x".repeat(500) }).reason).toHaveLength(120);
  });

  it("respects LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    resetEnvForTests();
    log.info("quiet", { count: 1 });
    log.warn("loud", { count: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("loud");
  });
});
