import type { CrisisKind } from "@/server/pipeline/screen";
import { crisisLifeline, crisisTextLine, edHelpline, emergencyNumber } from "./resources";

// Fixed, code-owned copy for the deterministic paths (priority replies and commands). Never passed
// through the LLM. Plain text, no markdown; each string is one bubble of at most 300 characters
// (a unit test enforces this). Emergency copy is conditional on purpose: the screen is
// phrase-level and can fire on hyperbole, and the reply must still be right in that case.

const emergency =
  `If this is a medical emergency, please call ${emergencyNumber} now. ` +
  `I'm an AI coach, not a doctor, so I can't help in an emergency.`;

const selfHarm =
  `I'm really glad you told me, and I'm sorry you're hurting. ` +
  `You can call or text ${crisisLifeline.number} anytime to talk with someone right now. ` +
  `If you're in immediate danger, call ${emergencyNumber}. ` +
  `I'm an AI coach, not a crisis service, but you don't have to go through this alone.`;

const edCare =
  `I care about how you're doing. If you'd like to talk with someone who specializes in ` +
  `eating concerns, the ${edHelpline.name} helpline is ${edHelpline.phone} (${edHelpline.hours}). ` +
  `Anytime, call or text ${crisisLifeline.number}, or text ${crisisTextLine.keyword} to ` +
  `${crisisTextLine.number}. If you're in danger, call ${emergencyNumber}.`;

export const crisisCopy: Record<CrisisKind, string> = {
  emergency,
  self_harm: selfHarm,
  ed: edCare,
};

export const STOP_CONFIRMATION =
  "You're unsubscribed and won't get more messages from us. Text START to resume.";

export const START_CONFIRMATION =
  "You're resubscribed, so I'll reply to your messages again. Text STOP anytime to opt out.";

/** Sent when a turn fails after it was claimed, so the user isn't left without a reply. */
export const TURN_FAILED_REPLY =
  "Sorry, something went wrong on my end and I couldn't handle that. Could you send it again?";
