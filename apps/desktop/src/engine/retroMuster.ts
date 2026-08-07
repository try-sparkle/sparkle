// DOES THIS AGENT'S REASON FOR HAVING NO RETRO PASS MUSTER?
//
// The founder's words: *"completing the step might be that they have a reason to not have provided
// a retro, which is fine but that reason needs to be valid. We need to make sure that we have a
// little bit of logic that decides whether or not that agent's reason is worth passing muster to
// allow for the agent to be retired."*
//
// ── BE HONEST ABOUT WHAT THIS CAN AND CANNOT CATCH ───────────────────────────────────────────────
// This checks the SHAPE OF A SENTENCE, not its truth. `no-changes` is measurable from git;
// `absorbed` and `other` are not measurable by anything. The founder's decision, put to him
// explicitly with all three options on the table, was that a WELL-FORMED reason passes on its own
// and he confirms the retirement himself — so this module deliberately consults no git state and
// makes no judgement about whether the agent is telling the truth. `RetroReceipt.branchEvidence`
// carries the one contradicting measurement to the confirm dialog for a human to read; it is
// display, and reading it here to change a verdict would quietly overturn that decision.
//
// So what IS worth refusing is narrow, and it is all shape: a reason outside the vocabulary (the
// agent invented a category nobody thought about), an empty or filler `reasonText` (the step was
// skipped with a shrug, which is precisely the silent skip this whole feature exists to close), and
// text carrying PII or a secret (the receipt is written to disk and rendered in a dialog).
//
// ── THE PII CHECK IS A CHEAP SHAPE TEST, NOT `sparkle-scrub.sh` ──────────────────────────────────
// The authoritative gate is `scripts/sparkle-scrub.sh`, and it stays authoritative on the path that
// FILES beads (scripts/lib/retro-beads.sh runs it before anything is written). It cannot run here:
// it is bash + grep behind a child process, and this module is pure so that every rule in it is
// unit-testable without I/O. What is implemented below is a small, deliberately conservative subset
// covering the three shapes that would actually appear in a one-line excuse — an email address, a
// home directory path, a key-shaped token. It is a backstop for a surface that never passes through
// the shell gate, NOT a second implementation of it, and it must not grow into one: if this needs
// real scrubbing, route the text through the script rather than widening these regexes.
import { isNoRetroReason, type NoRetroReason } from "./retroReceiptTypes";

/** What the check decided.
 *
 *  Two values, not three. An earlier design had a `claimed` middle tier for reasons no code can
 *  verify, which would have kept them out of the retirement recommendation and pushed every one to
 *  the confirm dialog. The founder chose otherwise, and a tier nothing acts on is a tier that rots. */
export type MusterVerdict = "excused" | "rejected";

export interface MusterResult {
  verdict: MusterVerdict;
  /** Why, in one short phrase.
   *
   *  SHOWN TO THE AGENT WHEN REJECTED, so the re-ping is actionable — `recordRetroExcused` returns
   *  it as `{ status: "rejected", why }` rather than collapsing to a boolean, precisely so a caller
   *  can tell "rephrase this" from "the write failed, retry it".
   *
   *  It is NOT persisted. An earlier version of this comment said it was "recorded on the receipt
   *  when excused"; `RetroReceipt` has no field for it and never did (roborev 59215). What the
   *  receipt stores is the agent's own `reasonCode` + `reasonText` — the claim, not the check. */
  why: string;
}

/** Shortest `reasonText` that can carry an actual reason.
 *
 *  Twenty characters, which is about four words. Not longer: legitimate short answers exist —
 *  "superseded by PR 1204" is 21 and complete. Not shorter: every entry on the filler list below is
 *  under twenty, and a threshold that admits "no changes" admits the shrug this exists to refuse. */
export const MIN_REASON_TEXT_CHARS = 20;

/** Text that is technically non-empty and says nothing.
 *
 *  Matched against the normalized text (lowercased, punctuation and whitespace collapsed), so
 *  "N/A.", "n / a" and "  N/A  " are all the same entry. Kept short on purpose — this is a filter
 *  for the reflexive non-answer, not an attempt to detect insincerity, which is not detectable. */
const FILLER = new Set([
  "na",
  "n a",
  "none",
  "nothing",
  "no",
  "nope",
  "done",
  "finished",
  "complete",
  "completed",
  "no retro",
  "no retro needed",
  "not applicable",
  "not needed",
  "nothing to report",
  "nothing to say",
  "no comment",
  "see above",
  "as above",
  "idk",
  "unknown",
  "tbd",
  "todo",
]);

/** Lowercase, strip punctuation, collapse whitespace. The normalizer the filler set is keyed on. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The three PII/secret shapes worth refusing in a one-line excuse. See the header: conservative by
 *  design, and NOT a reimplementation of sparkle-scrub.sh. */
const PII_SHAPES: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "an email address", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  // A home directory, on either platform. `/Users/<name>` and `/home/<name>` both name a person.
  { name: "a home directory path", re: /(?:\/Users\/|\/home\/|C:\\Users\\)[\w.-]+/i },
  // Key-shaped tokens: the common vendor prefixes plus a long opaque run. Split-safe — this matches
  // a SHAPE, and never contains a real secret itself. Case-insensitive because a shouted variant is
  // the same leak; the prefixes are distinctive enough that the false-positive cost is prose nobody
  // writes, and the failure direction here is a rejection the agent can rephrase.
  { name: "a key-shaped token", re: /\b(?:sk|pk|ghp|gho|ghs|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]{12,}/i },
  // AWS IDs get their OWN alternative, with NO separator (roborev 58742). They are `AKIA`/`ASIA`
  // run straight into 16 uppercase alphanumerics — folding them into the prefixed pattern above
  // required a `-`/`_` that a real key never has, so that arm could not match anything while the
  // module advertised AWS as one of the shapes it refuses. A gap that reads as covered is worse
  // than one that reads as missing.
  { name: "a key-shaped token", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
];

/**
 * Does this agent's stated reason for having no retro pass muster?
 *
 * PURE — no git, no clock, no I/O, no judgement about truth. See the header for why that last one
 * is deliberate rather than a shortcut.
 *
 * `reasonCode` is checked against the closed vocabulary in retroReceiptTypes (one membership test,
 * shared with the lifecycle tool, so the two cannot drift). `reasonText` is always required, for
 * every code including the self-explanatory ones: a code alone is a checkbox, and a checkbox is
 * what an agent ticks on the way past. The words are the thing the human reads at confirm time.
 */
export function assessNoRetroReason(reasonCode: unknown, reasonText: unknown): MusterResult {
  if (!isNoRetroReason(reasonCode)) {
    return {
      verdict: "rejected",
      why: "the reason is not one of the recognized kinds",
    };
  }
  if (typeof reasonText !== "string") {
    return { verdict: "rejected", why: "no explanation was given" };
  }

  const trimmed = reasonText.trim();
  if (trimmed.length === 0) {
    return { verdict: "rejected", why: "no explanation was given" };
  }

  // PII is checked against the RAW text, before normalization strips the punctuation that the
  // shapes are built out of. Checked ahead of the length and filler rules so a short leak is still
  // reported as a leak rather than as "too brief" — the remedy for the two is different, and a
  // misleading remedy is worse than none (AGENTS.md: a remedy string is an instruction the reader
  // will follow).
  for (const shape of PII_SHAPES) {
    if (shape.re.test(trimmed)) {
      return {
        verdict: "rejected",
        why: `the explanation contains ${shape.name} — restate it anonymized`,
      };
    }
  }

  if (trimmed.length < MIN_REASON_TEXT_CHARS) {
    return {
      verdict: "rejected",
      why: `the explanation is too brief to be a reason (under ${MIN_REASON_TEXT_CHARS} characters)`,
    };
  }
  if (FILLER.has(normalize(trimmed))) {
    return { verdict: "rejected", why: "the explanation says nothing" };
  }

  return { verdict: "excused", why: whyExcused(reasonCode) };
}

/** What was ACTUALLY established, per code — phrased so it can never be misread as verification.
 *
 *  This string is stored on the receipt and survives the agent, so it is the only thing a later
 *  reader has to tell "we checked this" from "the agent said this". Every branch says "stated". */
function whyExcused(code: NoRetroReason): string {
  switch (code) {
    case "no-changes":
      return "stated that it produced no changes";
    case "absorbed":
      return "stated that its work was absorbed elsewhere and reported there";
    case "superseded":
      return "stated that it was superseded before producing anything reportable";
    case "nothing-to-report":
      return "stated that it had nothing to report";
    case "other":
      return "gave a reason outside the common kinds";
  }
}
