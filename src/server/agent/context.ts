import { localDate } from "@/server/time";

// The per-turn context block: the first content block of the final user message. Everything
// time-related comes from the turn clock (max sent_at of the burst) in the effective timezone,
// never from wall time, so a late-processed message is still answered for the moment it was sent.

/** First line of every context block; the system prompt tells the model what it means. */
export const CONTEXT_HEADER = "[Context from the system, not written by the user]";

export type TimezoneSource = "user" | "simulator" | "default";

export interface ContextInput {
  turnClock: Date;
  timezone: string;
  timezoneSource: TimezoneSource;
  userStatus: string;
  /** Labels of the photos attached to this turn, in order (img1, img2, ...). */
  imageRefs: string[];
  failedImageCount: number;
}

const SOURCE_NOTE: Record<TimezoneSource, string> = {
  user: "set by the user",
  simulator: "from the simulator's browser, not confirmed by the user",
  default: "a default, not confirmed by the user",
};

export function renderContext(input: ContextInput): string {
  const lines = [
    CONTEXT_HEADER,
    `Local time: ${formatLocalDateTime(input.turnClock, input.timezone)} (${localDate(input.turnClock, input.timezone)})`,
    `Timezone: ${input.timezone} (${SOURCE_NOTE[input.timezoneSource]})`,
    `Account status: ${input.userStatus}`,
    input.imageRefs.length > 0
      ? `Photos attached: ${input.imageRefs.length} (${input.imageRefs.join(", ")})`
      : "Photos attached: none",
  ];
  const failed = input.failedImageCount;
  if (failed > 0) {
    lines.push(
      failed === 1
        ? "1 photo couldn't be loaded — ask the user to resend it."
        : `${failed} photos couldn't be loaded — ask the user to resend them.`,
    );
  }
  return lines.join("\n");
}

/** "Monday, November 2, 2026, 12:30 PM", built from parts so ICU punctuation changes can't drift it. */
export function formatLocalDateTime(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

/** 24-hour "HH:MM" in `tz`, used in code-written photo notes ("[photo 13:05]"). */
export function formatLocalHourMinute(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}
