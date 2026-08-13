// THE RETIREMENT RECEIPT — the one durable answer to "did this agent complete the retro step?"
//
// ── WHY THIS TYPE EXISTS AT ALL ──────────────────────────────────────────────────────────────────
// Retro capture was real and well built, and none of it was READABLE. `scripts/capture-merge-retro.sh`
// files one `agent-feedback` bead per pain point and discards its own return value ("a PostToolUse
// hook has no reader"), and it exits early when `painPoints|length == 0`. So a FRICTIONLESS retro —
// a complete, correct one with nothing to complain about — left exactly as much trace on disk as no
// retro at all: none. So did one filed under an unresolved PR owner, and one filed while
// `[improvement].consent != "always"`.
//
// That is why nothing could gate retirement on a retro: the fact was not written down anywhere. The
// receipt is that fact, written down. It is deliberately NOT the retro — the retro's content still
// lives in beads, where the Improvement Agent reads it. This records only that the step happened,
// which is the single bit the retirement gate needs.
//
// ── IT MUST OUTLIVE THE AGENT ROW ────────────────────────────────────────────────────────────────
// `AgentTab` (types.ts) has no `retired`, `archived` or `closedAt` field: a close is a HARD DELETE
// from a localStorage blob plus a 30-day tombstone. So a receipt cannot live on the row it describes
// — by the time anyone asks "was that agent's retro captured?", the row is gone. It lives in
// `<app_data>/retro-receipts.json`, written by Rust, exactly like the PR→owner mapping in
// `src-tauri/src/pr_owner.rs` that it is modelled on.
//
// ── THE SHAPE IS FROZEN AND HAS TWO IMPLEMENTATIONS ──────────────────────────────────────────────
// This file is authoritative. `src-tauri/src/retro_receipt.rs` serializes the SAME shape with
// `#[serde(rename_all = "camelCase")]`, and every optional field is
// `#[serde(skip_serializing_if = "Option::is_none")]` so an absent field is absent rather than null.
// A round-trip test on each side pins them together. Do not add a field to one without the other.

/** What completing the retro step looked like for this agent.
 *
 *  Three states, and the distinction between the first two is the whole product decision:
 *   • `captured`   — a real retro was observed. This INCLUDES a retro with zero pain points; an
 *                    agent that hit no friction still completed the step, and saying so is what
 *                    stops "nothing worth reporting" from becoming an excuse.
 *   • `excused`    — no retro, but the agent recorded a reason that passed muster (engine/retroMuster).
 *   • `overridden` — an agent that could not answer (dead, crashed, quota-blocked) was retired anyway
 *                    and the gap was accepted. Written by a PERSON **or** by the CONCIERGE acting on
 *                    the founder's standing authorization — `source` is what tells them apart
 *                    (`human-override` vs `concierge-override`), and nothing else does, so never read
 *                    `state: "overridden"` as proof a human looked at it. It does NOT file a bead —
 *                    an earlier version of this comment said it "always files a bead alongside", and
 *                    no production path ever did (knightwatch probe 8). The receipt is the whole
 *                    record. */
export type RetroReceiptState = "captured" | "excused" | "overridden";

/** Where the receipt came from. Kept because the writers have very different trust:
 *  a parsed PR marker is evidence, an agent's own declaration is a claim, a human override is a
 *  decision, and a concierge override is a decision NO PERSON TOOK. The confirm dialog words itself
 *  differently for each. */
export type RetroReceiptSource =
  /** Parsed from `<!-- sparkle:retro {json} -->` in a PR body — the frozen emit contract. */
  | "pr-marker"
  /** Parsed from a worker's `<worktree>/.sparkle/result.json` `.retro`. */
  | "result-json"
  /** The agent said so itself, through the lifecycle tool. */
  | "agent-declared"
  /** A human retired an unreachable agent and accepted the gap. */
  | "human-override"
  /** The CONCIERGE retired an agent that had no retro anywhere — no receipt, no feedback beads — on
   *  the founder's standing authorization. A machine-authored counterpart to `human-override`: same
   *  `overridden` state, same permanent mark, but nobody read the row before it was written. It is a
   *  separate member precisely so that mark cannot masquerade as a human decision — an audit asking
   *  "who accepted this gap?" gets the honest answer here rather than a person's name it invented. */
  | "concierge-override";

/** The enumerated reasons an agent may have no retro.
 *
 *  A CLOSED VOCABULARY, on purpose: `assessNoRetroReason` can only check the shape of a sentence,
 *  never its truth, so the one thing it CAN enforce is that the agent picked from a list somebody
 *  thought about rather than inventing a category. Free text still travels alongside in `reasonText`.
 *
 *  Note what is deliberately ABSENT: "frictionless" / "nothing went wrong". That is not a reason to
 *  skip the step — it is a retro with `painPoints: []`, which worker-retro.schema.json already
 *  permits (it sets no `minItems`). Routing it here instead would turn the most common good outcome
 *  into an excuse, and excuses are the thing that cannot be verified. */
export const NO_RETRO_REASONS = [
  /** The agent produced no commits and left a clean tree. */
  "no-changes",
  /** The work was folded into another branch and reported there. */
  "absorbed",
  /** The task was overtaken and abandoned before it produced anything reportable. */
  "superseded",
  /** Genuinely nothing to report AND nothing to emit — rare; prefer an empty-painPoints retro. */
  "nothing-to-report",
  /** Anything else. Always requires `reasonText`; the human reads it at confirm time. */
  "other",
] as const;

/** The runtime list above is the source of truth, so the validator and the persona copy cannot
 *  drift from the type the way two hand-written lists would. */
export type NoRetroReason = (typeof NO_RETRO_REASONS)[number];

/** Is `v` one of the enumerated reasons? The only membership test — `assessNoRetroReason` and the
 *  lifecycle tool both go through it rather than re-listing the vocabulary. */
export function isNoRetroReason(v: unknown): v is NoRetroReason {
  return typeof v === "string" && (NO_RETRO_REASONS as readonly string[]).includes(v);
}

/** One agent's completed retro step. Stored at `receipts[<projectId>][<agentId>]`. */
export interface RetroReceipt {
  state: RetroReceiptState;
  /** Epoch ms the step was completed. */
  at: number;
  source: RetroReceiptSource;
  /** The PR the marker was read from, when `source === "pr-marker"`. */
  prNumber?: number;
  /** The retro's own TL;DR, carried so the row's pill can show WHAT was reported on hover rather
   *  than only that something was. Present on `captured`. */
  tldr?: string;
  /** How many pain points the retro carried. ZERO IS MEANINGFUL and must not be conflated with
   *  absent — see `RetroReceiptState.captured`. */
  painPointCount?: number;
  /** Present on `excused` and `overridden`. */
  reasonCode?: NoRetroReason;
  /** The agent's (or the app's) own words, shown VERBATIM in the confirm dialog. Never paraphrased:
   *  the human is being asked to judge a claim, and a summary of a claim is not the claim. */
  reasonText?: string;
  /** A one-line branch measurement (`"0 ahead, clean"`) recorded ALONGSIDE an excuse purely so the
   *  confirm dialog can show it next to the agent's words.
   *
   *  IT IS NEVER A GATE. The founder's decision was that a well-formed reason passes muster on its
   *  own; this exists so that when an agent claims `no-changes` over three unpushed commits, the
   *  person clicking the button can see that, rather than the app silently overruling either of
   *  them. Display, not policy — do not add a code path that reads this to decide anything. */
  branchEvidence?: string;
}

/** The on-disk store. `version` is present so a later shape change can migrate rather than guess. */
export interface RetroReceiptStore {
  version: 1;
  /** projectId → agentId → receipt. Nested by project exactly like `pr_owner.rs`'s `prs`, because
   *  agent ids are only unique within a project and the app runs several at once. */
  receipts: Record<string, Record<string, RetroReceipt>>;
}

/** Current on-disk version. */
export const RETRO_RECEIPT_STORE_VERSION = 1 as const;

/** Has this agent completed the retro step?
 *
 *  "No receipt" is NOT "no". It is "we have not been told", and every consumer must treat it as
 *  fail-closed: the Pusher's `retirableAgents` requires an affirmative `true` before it will
 *  recommend retiring anything, for the same reason it already requires `hasUnlandedWork === false`
 *  (pusherFleet.ts: *"a 'safe to retire' said over missing data tells the founder to discard an
 *  agent that may be holding unmerged commits"*).
 *
 *  ── WHY `!= null` AND NOT `!== undefined` (roborev 58719) ───────────────────────────────────────
 *  ABSENCE ARRIVES AS `null`, NOT `undefined`. The receipt is read across the Tauri boundary from
 *  `retro_receipt.rs`, and a Rust `Option<RetroReceipt>` serializes `None` to JSON `null` — it does
 *  not and cannot produce `undefined`, which has no JSON representation at all. A strict
 *  `!== undefined` therefore answered TRUE for every agent that has no receipt, which is the exact
 *  inversion of this function's purpose: it would report an agent nobody ever heard from as having
 *  filed its retro, and recommend retiring it.
 *
 *  The loose `!= null` is deliberate and is the correct operator here — it catches BOTH `null` (the
 *  wire) and `undefined` (a TS caller that never looked). Do not "tighten" it back to `!==`. */
export function retroSettled(receipt: RetroReceipt | null | undefined): boolean {
  return receipt != null;
}
