import { parsePhoneNumberFromString } from "libphonenumber-js";

// The simulator only ever handles fictional numbers (D-102): +1 NPA 555-01XX, the range reserved
// for fiction. A real number can never reach the pipeline through /dev/chat.

/** POSIX-compatible, so the same pattern works in SQL (`phone_e164 ~ $pattern`). */
export const FICTIONAL_E164_PATTERN = "^\\+1[2-9][0-9]{2}55501[0-9]{2}$";
const FICTIONAL_E164 = new RegExp(FICTIONAL_E164_PATTERN);

export function isFictionalNumber(e164: string): boolean {
  return FICTIONAL_E164.test(e164);
}

/** Normalizes user input to E.164 and returns it only if it is a fictional simulator number. */
export function parseSimulatorPhone(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), "US");
  if (!parsed?.isPossible()) return null;
  return isFictionalNumber(parsed.number) ? parsed.number : null;
}
