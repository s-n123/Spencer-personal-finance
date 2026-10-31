// A photo the router ignores while the kick's own prefetch is downloading it (photo, then STOP
// within the debounce). finishTurn takes the live claim over (D-141): whatever the download does
// next, the row ends failed with no provider URL, no blob is kept and the staged original is released.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/server/channels/types";
import { inboundMessages, media, turns } from "@/server/db/schema";
import { ensureMedia, prefetchMedia } from "@/server/media/download";
import { closeHeicWorker } from "@/server/media/heic";
import type { Runner } from "@/server/pipeline/runner";
import { createTestDb, resetTestDb, type TestDb } from "@/test/db";
import { makeTestDeps, stubHandlers, type TestDeps } from "@/test/deps";
import { solidJpeg } from "@/test/fixtures/images";
import { handleInboundEvents } from "./inbound";

const PHONE = "+12015550101";
const URL_ = "https://media.simulator.invalid/ignored-1";

class DeferredRunner implements Runner {
  tasks: (() => Promise<void>)[] = [];
  readonly errors: unknown[] = [];
  run(_name: string, task: () => Promise<void>): void {
    this.tasks.push(task);
  }
  async flush(): Promise<void> {
    while (this.tasks.length > 0) {
      const batch = this.tasks.splice(0);
      await Promise.all(batch.map((t) => t().catch((err: unknown) => void this.errors.push(err))));
    }
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let t: TestDb;
let deps: TestDeps;
let runner: DeferredRunner;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await closeHeicWorker();
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t.db);
  runner = new DeferredRunner();
  deps = makeTestDeps(t.db, { runner, pipeline: stubHandlers({ prefetchMedia, ensureMedia }) });
});

function message(text: string | null, mediaUrls: string[] = []): NormalizedEvent {
  seq += 1;
  return {
    kind: "message",
    message: {
      provider: "simulator",
      providerMessageId: `ignored-media-${seq}`,
      fromE164: PHONE,
      toLine: "+12015550199",
      text,
      media: mediaUrls.map((url) => ({ url })),
      sentAt: deps.clock.now(),
    },
  };
}

async function until(cond: () => Promise<boolean>) {
  for (let i = 0; i < 10_000; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("condition never became true");
}

describe("a photo ignored while its prefetch is in flight", () => {
  it.each(["fails", "succeeds"] as const)("is discarded when the download then %s", async (outcome) => {
    deps.adapter.media.set(URL_, { bytes: await solidJpeg(64, 48), contentType: "image/jpeg" });
    const putStarted = deferred();
    const putGate = deferred();
    const put = deps.storage.put.bind(deps.storage);
    deps.storage.put = async (key, bytes, ct) => {
      if (key.startsWith("users/")) {
        putStarted.resolve();
        await putGate.promise;
        if (outcome === "fails") throw new Error("transient storage error");
      }
      return put(key, bytes, ct);
    };
    // Hold the holder's debounce sleep until the STOP is ingested (as it would be ~1 s later).
    const debounceGate = deferred();
    const sleep = deps.sleeper.sleep.bind(deps.sleeper);
    let first = true;
    deps.sleeper.sleep = async (ms, sig) => {
      if (first) {
        first = false;
        await debounceGate.promise;
      }
      return sleep(ms, sig);
    };

    await handleInboundEvents(deps, [message(null, [URL_])]);
    const flushing = runner.flush();
    await putStarted.promise; // the photo's kick prefetch holds a live claim
    await handleInboundEvents(deps, [message("STOP")]);
    debounceGate.resolve();
    await until(async () => (await deps.db.select().from(turns)).some((x) => x.status === "done"));
    const [atFinish] = await deps.db.select().from(media);
    expect([atFinish.status, atFinish.errorCode, atFinish.providerUrl]).toEqual(["failed", "media_unused", null]);
    putGate.resolve();
    await flushing;
    expect(runner.errors).toEqual([]);

    const rows = await deps.db.select().from(inboundMessages);
    expect(rows.map((r) => [r.text === null ? "photo" : "STOP", r.status]).sort()).toEqual([
      ["STOP", "done"],
      ["photo", "ignored"],
    ]);
    const [after] = await deps.db.select().from(media).where(eq(media.id, atFinish.id));
    expect([after.status, after.errorCode, after.providerUrl, after.storageKey]).toEqual([
      "failed",
      "media_unused",
      null,
      null,
    ]);
    expect([...deps.storage.objects.keys()].filter((k) => k.startsWith("users/"))).toEqual([]);
    expect(deps.adapter.released).toEqual([URL_]);
  });
});
