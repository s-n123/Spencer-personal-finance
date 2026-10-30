import { describe, expect, it } from "vitest";
import { policy } from "@/server/config/policy";
import * as copy from "@/server/safety/copy";
import { crisisLifeline, crisisTextLine, edHelpline } from "@/server/safety/resources";
import { priorityKey } from "./priority";

// The fixed copy sent on the priority path and for commands.

const all: [string, string][] = [
  ...Object.entries(copy.crisisCopy),
  ["STOP_CONFIRMATION", copy.STOP_CONFIRMATION],
  ["START_CONFIRMATION", copy.START_CONFIRMATION],
  ["TURN_FAILED_REPLY", copy.TURN_FAILED_REPLY],
];

describe("safety copy", () => {
  it.each(all)("%s is one plain-text bubble within the length limit", (_name, text) => {
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(policy.format.maxBubbleChars);
    expect(text).not.toMatch(/[*_#`[\]]|\n/);
  });

  it("uses the exact STOP confirmation", () => {
    expect(copy.STOP_CONFIRMATION).toBe(
      "You're unsubscribed and won't get more messages from us. Text START to resume.",
    );
  });

  it("emergency copy says to call 911; self-harm copy gives 988 and 911", () => {
    expect(copy.crisisCopy.emergency).toContain("911");
    expect(copy.crisisCopy.self_harm).toContain("988");
    expect(copy.crisisCopy.self_harm).toContain("911");
  });

  it("ED care copy carries the helpline from config, 988 and the text line", () => {
    expect(copy.crisisCopy.ed).toContain(edHelpline.phone);
    expect(copy.crisisCopy.ed).toContain(edHelpline.hours);
    expect(copy.crisisCopy.ed).toContain(crisisLifeline.number);
    expect(copy.crisisCopy.ed).toContain(`text ${crisisTextLine.keyword} to ${crisisTextLine.number}`);
  });

  it("the helpline is not marked verified until someone checks the live site (D-093)", () => {
    expect(edHelpline.verifiedAt).toBeNull();
  });
});

describe("priorityKey", () => {
  it("keys priority intents per inbound row", () => {
    expect(priorityKey("abc", "crisis")).toBe("priority:abc:crisis");
    expect(priorityKey("abc", "stop")).toBe("priority:abc:stop");
  });
});
