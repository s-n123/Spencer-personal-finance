import { describe, expect, it } from "vitest";
import { CONTEXT_HEADER, formatLocalDateTime, formatLocalHourMinute, renderContext } from "./context";

// Vitest runs with TZ=Pacific/Chatham, so any reliance on the host zone would show up here.
const MONDAY_1230_NY = new Date("2026-11-02T17:30:00.000Z");

describe("renderContext", () => {
  it("renders local date, time and weekday from the turn clock in the given timezone", () => {
    const text = renderContext({
      turnClock: MONDAY_1230_NY,
      timezone: "America/New_York",
      timezoneSource: "simulator",
      userStatus: "active",
      imageRefs: ["img1", "img2"],
      failedImageCount: 0,
    });
    expect(text.split("\n")).toEqual([
      CONTEXT_HEADER,
      "Local time: Monday, November 2, 2026, 12:30 PM (2026-11-02)",
      "Timezone: America/New_York (from the simulator's browser, not confirmed by the user)",
      "Account status: active",
      "Photos attached: 2 (img1, img2)",
    ]);
  });

  it("uses the local calendar date, not the UTC one", () => {
    const text = renderContext({
      turnClock: new Date("2026-11-03T03:30:00.000Z"),
      timezone: "America/Los_Angeles",
      timezoneSource: "user",
      userStatus: "active",
      imageRefs: [],
      failedImageCount: 0,
    });
    expect(text).toContain("Local time: Monday, November 2, 2026, 7:30 PM (2026-11-02)");
    expect(text).toContain("(set by the user)");
    expect(text).toContain("Photos attached: none");
  });

  it("tells the model about photos that failed to load", () => {
    const one = renderContext({
      turnClock: MONDAY_1230_NY,
      timezone: "America/New_York",
      timezoneSource: "default",
      userStatus: "active",
      imageRefs: [],
      failedImageCount: 1,
    });
    expect(one).toContain("1 photo couldn't be loaded — ask the user to resend it.");
    expect(one).toContain("(a default, not confirmed by the user)");
    const two = renderContext({
      turnClock: MONDAY_1230_NY,
      timezone: "America/New_York",
      timezoneSource: "default",
      userStatus: "active",
      imageRefs: ["img1"],
      failedImageCount: 2,
    });
    expect(two).toContain("2 photos couldn't be loaded — ask the user to resend them.");
  });
});

describe("local time helpers", () => {
  it("formats 12-hour and 24-hour times in the target zone", () => {
    expect(formatLocalDateTime(new Date("2026-11-02T05:05:00.000Z"), "America/New_York")).toBe(
      "Monday, November 2, 2026, 12:05 AM",
    );
    expect(formatLocalHourMinute(new Date("2026-11-02T05:05:00.000Z"), "America/New_York")).toBe("00:05");
    expect(formatLocalHourMinute(MONDAY_1230_NY, "America/New_York")).toBe("12:30");
    expect(formatLocalHourMinute(new Date("2026-11-02T22:45:00.000Z"), "America/New_York")).toBe("17:45");
  });
});
