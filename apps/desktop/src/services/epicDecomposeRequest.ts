// epicDecomposeRequest — THE MISSING DOOR IN FRONT OF `services/epicDecompose`'s GATE.
//
// ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────
// `services/epicDecompose` is complete and has been since it shipped: pure pickers, a serial
// one-AI-call-per-epic sweep, the `decomposing` / `decomposed` / `decompose-failed` label state
// machine, crash recovery, a mid-sweep AI re-check. Every one of those is gated behind an explicit
// opt-in label, `DECOMPOSE_REQUESTED_LABEL`, whose own header calls its absence "the safe default".
//
// NOTHING IN THE APP EVER WROTE THAT LABEL. Grep it across `apps/` outside the tests and the only
// hits are epicDecompose's own definition, epicDecompose's own consumption, and one comment in
// `sendToBuild` saying it is deliberately not attached there. So the whole pipeline was unreachable:
// no epic could ever be picked, at all, by any path. The measured consequence, from the founder's
// own audit of the live store: 67 epics, 33 of them with ZERO children. An epic with no children
// cannot be worked, so each one eventually gets swept to Blocked and stays there.
//
// The gate was never the bug. A gate with no door is.
//
// ── WHAT THIS MODULE IS ──────────────────────────────────────────────────────────────────────
// The copy and the predicates for ASKING. `services/epicSweepRunner` is the caller: it already
// walks every epic in every project this window owns on a ten-minute tick, already holds the watch
// set the founder chose (`beads.PROMOTED_LABEL` — "epics he has handed to Build at least once"),
// already caps itself at one action per tick per project, and already knows how to write a label,
// leave a durable `bd comment`, and put a sentence in front of him. A hollow epic was the one thing
// it walked past, answering `skip: nothing-planned` forever.
//
// ── WHY THE WATCH SET IS THE RIGHT SPEND GATE, RATHER THAN A NEW SWITCH ──────────────────────
// The opt-in label exists so decomposition never spends money on an epic nobody asked for. Reading
// `PROMOTED_LABEL` as that ask preserves the intent exactly: promotion to Build is the founder's
// own statement that he wants the thing delivered, made by hand, per epic. It is also strictly
// weaker than what this sweep already does unasked on the same watch set — it RESTARTS orchestrators
// there, spending an agent slot, which costs more than one decompose call. Auto-opting every epic
// in the store would be the opposite: 33 paid calls at once, on work nobody had pointed at.
//
// ── NOTHING NEW IS DRAWN ─────────────────────────────────────────────────────────────────────
// The founder's hard rule is that epic work looks and behaves exactly like the build agents, colors
// included. This module introduces no state a card has to render: it writes the SAME opt-in label
// `epicDecompose` already defines, and the pipeline labels the board already knows how to show are
// written by `epicDecompose` exactly as before. The only new artifacts are a `bd comment` on the
// epic and one sentence in the concierge — both channels the sweep already uses for restarts.
import {
  DECOMPOSE_FAILED_LABEL,
  DECOMPOSE_REQUESTED_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSING_LABEL,
} from "./epicDecompose";
import type { Bead } from "./beads";

/**
 * Labels meaning "this epic is already somewhere in the decompose pipeline" — in flight
 * (`decomposing`) or terminal (`decomposed` / `decompose-failed`).
 *
 * DERIVED FROM `epicDecompose`'s OWN CONSTANTS rather than re-typed, because this list and the
 * `PIPELINE_LABELS` the picker excludes on have to mean the same thing. If they drift, this module
 * asks for a decomposition the picker will then refuse — a request that spends a label write, a
 * comment and a concierge line and produces nothing, forever, silently.
 */
export const DECOMPOSE_PIPELINE_LABELS: readonly string[] = [
  DECOMPOSING_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSE_FAILED_LABEL,
];

/** Has decomposition already been requested for this epic? */
export function isDecomposeRequested(bead: Pick<Bead, "labels">): boolean {
  return bead.labels.includes(DECOMPOSE_REQUESTED_LABEL);
}

/** Is this epic already in the decompose pipeline — in flight or finished either way? */
export function isInDecomposePipeline(bead: Pick<Bead, "labels">): boolean {
  return bead.labels.some((l) => DECOMPOSE_PIPELINE_LABELS.includes(l));
}

/**
 * The sentence the founder reads.
 *
 * SAYS WHAT WAS ASKED FOR AND HOW TO SAY NO, because remedy copy in this repo is an instruction the
 * reader will follow and gets audited like a branch. The opt-out it names is the one the engine
 * actually vetoes on — `beads.NO_AUTO_RESTART_LABEL`, the same veto that stops a restart — and it
 * is passed in rather than spelled here so the sentence cannot drift from the constant.
 */
export function requestDecomposeMessage(epic: Pick<Bead, "id" | "title">, optOutLabel: string): string {
  return (
    `**${epic.id} — ${epic.title}** was promoted to Build but has no child beads at all, so there ` +
    `is nothing for anyone to pick up. I have asked for it to be broken down into tasks. ` +
    `If you would rather plan it yourself, add the \`${optOutLabel}\` label to the epic and I will ` +
    `leave it alone. I will only ask once — if the breakdown fails, the epic says so on its card.`
  );
}

/**
 * The durable record, written onto the epic itself.
 *
 * WHY, given the concierge line already exists: the notice is a chat message he may not have been
 * at the machine for, and it scrolls. This lands in a store every worktree shares and the board
 * polls every five seconds, and it is the only artifact that still answers "why did that epic
 * suddenly grow eleven children last Tuesday?" a week later.
 *
 * STATES ONLY WHAT WAS MEASURED — the hollow duration comes from the same timestamp the DECISION
 * was made from, so the note and the decision cannot disagree.
 */
export function requestDecomposeNote(
  epic: Pick<Bead, "id" | "title">,
  hollowSinceAt: number | null,
  now: number,
): string {
  // Whole hours: the grace period is fifteen minutes and the reach cap is fourteen days, so minutes
  // are noise at the scale this note is read at. `null` stays `null` rather than becoming 0 — "we
  // could not read a date" and "it was touched this instant" are opposite facts.
  const hours = hollowSinceAt === null ? null : Math.floor((now - hollowSinceAt) / (60 * 60 * 1000));
  return [
    `Decomposition requested by the epic sweep.`,
    ``,
    `WHY: this epic was promoted to Build and has ZERO children` +
      (hours === null ? `.` : `, and nothing has touched it in ${hours}h.`) +
      ` An epic with no children cannot be worked — nothing can be started against it and it ends` +
      ` up in Blocked for want of a plan nobody asked for.`,
    `ACTION: added the \`${DECOMPOSE_REQUESTED_LABEL}\` label, which is the explicit opt-in the` +
      ` auto-decompose watcher spends on. It will make one AI call to break this epic into child` +
      ` beads and then consume the label.`,
    `BUDGET: asked ONCE. On success the label is consumed; on failure the epic is badged` +
      ` \`${DECOMPOSE_FAILED_LABEL}\` and retries only when that badge is cleared. The sweep does` +
      ` not ask again on its own.`,
  ].join("\n");
}
