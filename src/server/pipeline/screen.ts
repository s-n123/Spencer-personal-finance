// Per-message screen (PLAN §2.1 step 4). Runs at ingest on the in-memory text of ONE message,
// never on a merged burst, and only tags are stored. Everything here is deterministic and
// high-precision: keywords match the whole message; crisis patterns are phrase-level, never bare
// words like "starving".

export type Keyword =
  | "STOP"
  | "START"
  | "HELP"
  | "DELETE"
  | "YES_DELETE"
  | "YES"
  | "MY_DATA"
  | "SUBSCRIBE"
  | "BILLING";

export type CrisisKind = "emergency" | "self_harm" | "ed";

export interface ScreenResult {
  keyword: Keyword | null;
  crisisKind: CrisisKind | null;
}

export function screenMessage(text: string | null): ScreenResult {
  if (!text) return { keyword: null, crisisKind: null };
  return { keyword: matchKeyword(text), crisisKind: screenCrisis(text) };
}

const KEYWORDS = new Map<string, Keyword>([
  ["stop", "STOP"],
  ["stopall", "STOP"],
  ["stop all", "STOP"],
  ["unsubscribe", "STOP"],
  ["cancel", "STOP"],
  ["end", "STOP"],
  ["quit", "STOP"],
  ["revoke", "STOP"],
  ["opt out", "STOP"],
  ["optout", "STOP"],
  ["start", "START"],
  ["unstop", "START"],
  ["help", "HELP"],
  ["info", "HELP"],
  ["delete", "DELETE"],
  ["yes delete", "YES_DELETE"],
  ["yes", "YES"],
  ["y", "YES"],
  ["agree", "YES"],
  ["i agree", "YES"],
  ["my data", "MY_DATA"],
  ["subscribe", "SUBSCRIBE"],
  ["billing", "BILLING"],
]);

/** Case-folded, curly quotes straightened, whitespace collapsed; punctuation kept. */
function lightNormalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** For whole-message keywords: punctuation, symbols and emoji become spaces ("opt-out" = "opt out"). */
export function normalizeKeywordText(text: string): string {
  return lightNormalize(text)
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Plain-language opt-outs (FCC: revocation by any reasonable means). They must open the message
// and be followed only by punctuation or the end, so "my ex won't stop texting me" and scoped asks
// like "stop texting me before 8" (M4 triage territory, D-084) don't pause the user.
const OPT_OUT_PHRASE = new RegExp(
  [
    String.raw`^(?:(?:please|pls|plz|just|ok|okay)[\s,]+)*`,
    String.raw`(?:stop\s+(?:texting|messaging)(?:\s+me)?|leave\s+me\s+alone|(?:don'?t|do\s+not)\s+(?:text|message)\s+me|unsubscribe\s+me)`,
    String.raw`(?:\s+(?:anymore|any\s+more|ever\s+again|again))?`,
    String.raw`(?:[\s,]+(?:please|pls|plz))?`,
    String.raw`(?=$|\s*[^\p{L}\p{N}\s])`,
  ].join(""),
  "u",
);

/** A keyword that is the whole message (not an opt-out phrase inside a longer one). */
export function matchExactKeyword(text: string): Keyword | null {
  return KEYWORDS.get(normalizeKeywordText(text)) ?? null;
}

export function matchKeyword(text: string): Keyword | null {
  const exact = matchExactKeyword(text);
  if (exact) return exact;
  if (OPT_OUT_PHRASE.test(lightNormalize(text))) return "STOP";
  return null;
}

const CANT = String.raw`(?:can'?t|cannot|can\s+not|unable\s+to)`;

const EMERGENCY: RegExp[] = [
  new RegExp(String.raw`\b${CANT}\s+(?:breathe|breath|catch\s+my\s+breath)\b`),
  /\b(?:trouble|difficulty|struggling)\s+breathing\b/,
  /\bchest\s+pains?\b/,
  /\bpain\s+in\s+my\s+chest\b/,
  /\bmy\s+chest\s+(?:hurts|is\s+hurting)\b/,
  /\bthroat\s+(?:is\s+|feels\s+like\s+it'?s\s+)?(?:closing|swelling)\b/,
  /\btongue\s+(?:is\s+)?swelling\b/,
  /\bmy\s+(?:lips?|face|mouth)\s+(?:is\s+|are\s+)?swelling\b/,
  /\bi\s+(?:just\s+|think\s+i\s+|might\s+have\s+|may\s+have\s+)?overdosed\b/,
  /\bi'?ve\s+overdosed\b/,
  /\b(?:i'?m|i\s+am)\s+overdosing\b/,
  /\btook\s+an\s+overdose\b/,
  /\btook\s+(?:way\s+)?too\s+many\s+(?:pills|tablets|capsules)\b/,
  /\bi\s+(?:just\s+)?(?:passed\s+out|fainted|blacked\s+out)\b/,
  /\bi\s+keep\s+(?:passing\s+out|fainting|blacking\s+out)\b/,
  /\b(?:severe|serious|bad|major)\s+allergic\s+reaction\b/,
  /\bhaving\s+an?\s+(?!mild\b)(?:\w+\s+)?allergic\s+reaction\b/,
  /\b(?:in|going\s+into)\s+anaphyla(?:xis|ctic\s+shock)\b/,
  /\b(?:used|need|needed|using)\s+my\s+epi-?\s?pen\b/,
  /\b(?:i'?m|i\s+am|i\s+think\s+i'?m)\s+having\s+a\s+(?:heart\s+attack|stroke|seizure)\b/,
];

const SELF_HARM: RegExp[] = [
  /\bkill(?:ing)?\s+myself\b/,
  /(?<!\b(?:don'?t|do\s+not|didn'?t|never)\s+)\b(?:want|wanna|wanted)\s+(?:to\s+)?die\b/,
  /\bwish\s+i\s+(?:was|were)\s+dead\b/,
  /(?<!\b(?:don'?t|do\s+not|didn'?t|never)\s+)\b(?:want|wanna)\s+(?:to\s+)?be\s+dead\b(?!\s+(?:tired|asleep|serious|set|on|last|wrong|sure)\b)/,
  /\b(?:want|wanna|going|gonna|ready)\s+(?:to\s+)?end\s+it\s+all\b/,
  /\bend(?:ing)?\s+my\s+life\b/,
  /\btake\s+my\s+(?:own\s+)?life\b/,
  /\bsuicid(?:e|al)\b/,
  /\b(?:want|wanna|going|gonna|plan(?:ning)?|urges?|thinking\s+(?:about|of)|thought\s+about)\s+(?:to\s+)?(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?)\s+myself\b/,
  /\b(?:been|keep|started)\s+(?:hurting|harming|cutting)\s+myself\b/,
  /\bfeel(?:s|ing)?\s+like\s+(?:hurting|harming|cutting|killing)\s+myself\b/,
  /\b(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?)\s+myself\s+on\s+purpose\b/,
  /\bself[\s-]?harm(?:ing)?\b/,
  /\bbetter\s+off\s+dead\b/,
  /\bno\s+reason\s+to\s+live\b/,
  /\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:live|be\s+alive)\b/,
];

const ED: RegExp[] = [
  /\bstarv(?:e|ed|ing)\s+myself\b/,
  /\b(?:make|making|made|force|forcing|forced)\s+myself\s+(?:throw\s+up|vomit|puke|purge|be\s+sick)\b/,
  /\bpurg(?:e|ed|ing)\s+after\b/,
  /\bbing(?:e|ed|ing)\s+and\s+purg(?:e|ed|ing)\b/,
  /\b(?:take|taking|took|use|using|used)\s+(?:a\s+(?:lot|bunch|ton)\s+of\s+|so\s+many\s+)?laxatives\s+to\b(?!\s+(?:help|treat|relieve|deal)\b)/,
  /\b(?:i'?m|i\s+am|been|i'?ve\s+been|started)\s+(?:taking|using)\s+diet\s+pills\b/,
];

// "haven't eaten in 3 days", "not eaten for a couple of days", "haven't eaten in days", "in 48 hours".
const NOT_EATEN = new RegExp(
  [
    String.raw`\b(?:haven'?t|have\s+not|hadn'?t|had\s+not|didn'?t|did\s+not|not)\s+`,
    String.raw`(?:eaten|eat|had\s+(?:any\s+)?food|had\s+anything(?:\s+to\s+eat)?)\s+`,
    String.raw`(?:anything\s+|any\s+food\s+)?(?:in|for)\s+`,
    String.raw`(?:(?:like|about|over|almost|nearly|around|at\s+least)\s+)?`,
    String.raw`(?:(\d+|a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few|several|many|multiple|two|three|four|five|six|seven|eight|nine|ten|an?)\s*\+?\s*)?`,
    String.raw`(days?|weeks?|hours?|hrs?)\b`,
  ].join(""),
  "g",
);

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function notEatenForDays(text: string): boolean {
  for (const m of text.matchAll(NOT_EATEN)) {
    const qty = m[1]?.replace(/\s+/g, " ");
    const unit = m[2];
    const hours = unit.startsWith("h");
    let n: number;
    if (qty === undefined) {
      // "in days" / "in weeks" (plural, no count) means at least two; "in hours" means less than one.
      n = hours ? 0 : unit.endsWith("s") ? 2 : 1;
    } else if (/^\d+$/.test(qty)) {
      n = Number(qty);
    } else {
      n = NUMBER_WORDS[qty] ?? 2;
    }
    if (unit.startsWith("week")) n *= 7;
    // In days from here on.
    if (hours) n /= 24;
    if (n >= 2) return true;
  }
  return false;
}

/**
 * Returns the crisis kind for one message, or null. When several match, self-harm wins (its copy
 * also says to call 911), then emergency, then ED.
 */
export function screenCrisis(text: string): CrisisKind | null {
  const t = lightNormalize(text);
  if (!t) return null;
  if (SELF_HARM.some((re) => re.test(t))) return "self_harm";
  if (EMERGENCY.some((re) => re.test(t))) return "emergency";
  if (ED.some((re) => re.test(t)) || notEatenForDays(t)) return "ed";
  return null;
}
