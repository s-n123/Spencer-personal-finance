// Crisis and eating-disorder resources shared in fixed copy (DECISIONS D-093). Held in config, not
// in any prompt, so a correction is one reviewed diff. Sources: docs/research/compliance.md
// (retrieved 2026-10-29, [search] only).

export interface Helpline {
  name: string;
  phone: string;
  hours: string;
  url: string;
  /**
   * ISO date this entry was checked against the organization's live site, or null if never.
   * MUST be re-verified on the live site before M4 ships: sources conflict on the number
   * (1-866-662-1235 vs 1-866-622-1235), and a wrong digit is a safety defect.
   */
  verifiedAt: string | null;
}

/** Not a 24/7 crisis line; always shared alongside 988 and the text line. */
export const edHelpline: Helpline = {
  name: "National Alliance for Eating Disorders",
  phone: "1-866-662-1235",
  hours: "Mon–Fri 9am–7pm ET",
  url: "https://www.allianceforeatingdisorders.com/",
  verifiedAt: null,
};

/** 988 Suicide & Crisis Lifeline: call or text, 24/7. */
export const crisisLifeline = {
  name: "988 Suicide & Crisis Lifeline",
  number: "988",
  verifiedAt: null as string | null,
};

/** The Alliance's recommended 24/7 text option. */
export const crisisTextLine = {
  keyword: "ALLIANCE",
  number: "741741",
  verifiedAt: null as string | null,
};

export const emergencyNumber = "911";
