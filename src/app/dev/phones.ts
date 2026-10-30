// The /dev/chat phone switcher's range: +1 201 555-0100 to -0199, all fictional (D-102). Shared by
// the page and the client component; the API re-validates every number server-side.

export const SIM_PHONES: readonly string[] = Array.from(
  { length: 100 },
  (_, i) => `+120155501${String(i).padStart(2, "0")}`,
);

const IN_RANGE = /^\+120155501\d{2}$/;

/** Accepts "+12015550142", "201-555-0142", "(201) 555 0142" or just "0142"/"42"; null if outside the range. */
export function normalizeSimPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let e164: string;
  if (digits.length <= 2) e164 = `+120155501${digits.padStart(2, "0")}`;
  else if (digits.length === 4) e164 = `+1201555${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return digits.length > 0 && IN_RANGE.test(e164) ? e164 : null;
}
