// How a status band is WRITTEN and PAINTED, in one place.
//
// The band vocabulary itself (the ids, the ordered metadata, which status falls where) lives in
// engine/buildSections — this module only answers "what words does the user read" and "what color
// does the chip take", for every surface that shows a band: the sidebar's filter chips, the project
// tab badges, the concierge's vitals line and nudge cards, and the snapshot handed to the brain.
//
// WHY IT IS SHARED. The count label has to AGREE IN NUMBER — "1 Needs you" but "3 Need you" — and a
// per-surface copy of that rule is a rule that drifts: the first surface someone adds gets it wrong,
// and nothing goes red. One helper, one boundary case (n === 1), one test.
//
// Colors are derived from AGENT_STATUS via each band's `colorFrom` status rather than written as
// hex, for the same reason buildSections spells `colorFrom` as a status: a hardcoded palette copy is
// how a badge and the dots it counts fall out of sync.
import { AGENT_STATUS } from "@sparkle/ui";
import { STATUS_BANDS, type StatusBand } from "./buildSections";

function meta(band: StatusBand) {
  // Every StatusBand is in STATUS_BANDS, so the fallback is unreachable; it exists so callers never
  // juggle `undefined`.
  return STATUS_BANDS.find((b) => b.id === band) ?? STATUS_BANDS[0]!;
}

/** The band's own label, as the chips render it: "Needs you" · "Running" · "Done". */
export function bandLabel(band: StatusBand): string {
  return meta(band).label;
}

/** The band's paint, taken from the status its dot shares (AGENT_STATUS[colorFrom].color). */
export function bandColor(band: StatusBand): string {
  return AGENT_STATUS[meta(band).colorFrom].color;
}

/**
 * A band label carrying a COUNT, agreeing in number: "1 Needs you" · "3 Need you" · "1 Question" ·
 * "2 Questions" · "2 Running".
 *
 * TWO bands inflect, and they inflect DIFFERENT PARTS OF SPEECH — which is the whole reason this
 * is one helper and not a per-surface `${n} ${label}`:
 *   • `needs_you` is a SENTENCE ("this one needs you"), so a plural subject takes the plural VERB:
 *     1 Needs you → 3 Need you. The count grows, the verb loses its -s.
 *   • `questions` is a NOUN, so it inflects the opposite way: 1 Question → 3 Questions. The count
 *     grows, the noun GAINS its -s. Reusing the needs_you rule here would produce "1 Questions".
 * "Running" and "Done" are adjectives and never change.
 */
export function bandCountLabel(band: StatusBand, n: number): string {
  if (band === "needs_you") return `${n} ${n === 1 ? "Needs you" : "Need you"}`;
  if (band === "questions") return `${n} ${n === 1 ? "Question" : "Questions"}`;
  return `${n} ${bandLabel(band)}`;
}
