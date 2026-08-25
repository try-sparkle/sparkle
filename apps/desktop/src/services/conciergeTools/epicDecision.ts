// THE EPIC DECISION — the adversarial gate the concierge cannot file a task without answering.
// Bead `sparkle-xelans.3`.
//
// WHY A PARSER AND NOT A PROMPT. The founder asked the concierge to use epics better; it agreed and
// did not. His ruling was explicit: an ENFORCEMENT MECHANISM, not a promise — "a prompt instruction
// can be ignored, a required argument cannot". So `board.create_item` takes an epic decision as an
// argument, this module is the only thing that reads it, and a create whose decision does not parse
// files nothing at all.
//
// THE THREE ANSWERS ARE PEERS. `none` is FIRST-CLASS AND UNSHAMED — the founder's words, and not
// every bead needs an epic. What makes the gate adversarial is not that `none` is discouraged; it is
// that the REASON IS RECORDED on the bead, so choosing `none` is a decision somebody made rather
// than a default nobody noticed. The reason is what the sweep, the triage pass, and the founder read
// three weeks later; the decision alone would tell them nothing.
//
// THIS FILE IS PURE. It parses and formats; it does not read the store, does not decide whether an
// id names a real epic (that is `isEpic` in services/beads.ts — the ONE resolver), and does not
// create anything. `board.ts` composes it with the store.

/** What the model answered, once parsed. */
export type EpicDecision =
  /** No epic, deliberately. First-class — see the header. */
  | { kind: "none" }
  /** File this task under an epic that already exists. The id is NOT validated here. */
  | { kind: "existing"; epicId: string }
  /** Mint a new epic with this title and file the task under it. */
  | { kind: "new"; title: string };

/** The syntax, in one string, so the refusal, the schema description and the docs cannot drift. */
export const EPIC_DECISION_SYNTAX =
  "`<existing-epic-id>` (e.g. `sparkle-xelans`) | `new:<title>` | `none`";

/**
 * bd's id shape: a project prefix, a hyphen, a suffix, then any number of dotted segments
 * (`sparkle-xelans`, `sparkle-xelans.3`, `sparkle-131ms.2.1`). Deliberately anchored and
 * whitespace-free: an answer like "no epic needed" or "the concierge one" is UNPARSEABLE rather
 * than quietly read as an id, because a wrong parent is worse than a refusal that teaches.
 */
const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/;

/**
 * Parse the raw argument. Returns `null` for MISSING, BLANK or UNPARSEABLE — one null for all three
 * because the caller's response to each is identical (refuse, and show the candidate epics), and
 * splitting them would invite a branch that treats "blank" as "none".
 *
 * `none` and the `new:` prefix are matched case-insensitively; the epic id is NOT lowercased,
 * because bd ids are matched literally by `bd` and folding case would invent an id.
 */
export function parseEpicDecision(raw: string | null | undefined): EpicDecision | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;

  if (/^none$/i.test(value)) return { kind: "none" };

  const minted = /^new\s*:\s*(.+)$/i.exec(value);
  if (minted) {
    const title = minted[1]!.trim();
    return title === "" ? null : { kind: "new", title };
  }

  if (BEAD_ID_RE.test(value)) return { kind: "existing", epicId: value };

  return null;
}

/** The marker every recorded decision starts with, so one grep finds them all — in the store, in a
 *  later sweep, and in a human's `bd comments` read. Changing it orphans every decision already
 *  written, so it is a constant rather than a literal at the call site. */
export const EPIC_DECISION_MARKER = "EPIC DECISION";

/**
 * The comment recorded on the created bead. THIS IS THE DURABLE HALF OF THE GATE.
 *
 * It goes on as a COMMENT and never into the body: the body is the original ask and is not edited
 * (AGENTS.md, bead `sparkle-ddhk5x`), and a comment is also the only shape that survives a store
 * many agents write to at once.
 */
export function formatEpicDecisionComment(input: {
  decision: EpicDecision;
  /** The epic the task actually landed under, once resolved. Null for `none`. */
  epicId: string | null;
  /** True when this create minted the epic named above. */
  epicCreated: boolean;
  reason: string;
}): string {
  const { decision, epicId, epicCreated, reason } = input;
  const what =
    decision.kind === "none"
      ? "no epic"
      : epicCreated
        ? `new epic ${epicId} ("${decision.kind === "new" ? decision.title : ""}")`
        : `existing epic ${epicId}`;
  return `${EPIC_DECISION_MARKER}: ${what} — ${reason.trim()}`;
}
