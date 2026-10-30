import { after } from "next/server";
import { logError } from "@/server/errors";

// Background work after the response. On Vercel `after()` is backed by waitUntil and bounded by
// the route's maxDuration; it is not durable, so the DB state machine plus sweeps provide
// recovery. Tests and scripts use InlineRunner because after() throws outside a request scope.

export interface Runner {
  run(name: string, task: () => Promise<void>): void;
}

export const afterRunner: Runner = {
  run(name, task) {
    after(async () => {
      try {
        await task();
      } catch (err) {
        logError(`runner.${name}.failed`, err);
      }
    });
  },
};

/** Collects tasks so a test (or script) can await them deterministically. */
export class InlineRunner implements Runner {
  private readonly pending: Promise<void>[] = [];
  readonly errors: unknown[] = [];

  run(name: string, task: () => Promise<void>): void {
    this.pending.push(
      task().catch((err: unknown) => {
        this.errors.push(err);
        logError(`runner.${name}.failed`, err);
      }),
    );
  }

  /** Awaits all tasks, including ones scheduled while draining. */
  async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      await Promise.all(batch);
    }
  }
}
