import type { Clock, Sleeper } from "@/server/time";

/** A controllable clock. Starts at a fixed instant so tests are deterministic. */
export class FakeClock implements Clock {
  private t: number;

  constructor(start: Date | string = "2026-11-02T17:30:00.000Z") {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
}

/** Sleeping advances the fake clock instead of waiting, so debounce logic runs instantly. */
export class FakeSleeper implements Sleeper {
  readonly calls: number[] = [];

  constructor(private readonly clock: FakeClock) {}

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    this.calls.push(ms);
    this.clock.advance(Math.max(0, ms));
    // Yield so concurrently scheduled work can interleave like real timers would.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
