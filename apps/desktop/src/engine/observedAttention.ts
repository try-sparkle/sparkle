// observedAttention — THE SECOND WITNESS FOR A ROW NOBODY HAS OPENED.
//
// ── THE BUG ─────────────────────────────────────────────────────────────────────────────────────
// The founder: "it was green when I first clicked on it… I guess it turned red AFTER I clicked."
// `runtimeStore.status` — the map the row colour reads — is written by a MOUNTED `AgentPane` and by
// essentially nothing else, and panes mount LAZILY, per project, on first visit. For an agent this
// window is not hosting, the colour is a frozen last reading with no writer that can ever move it
// (`engine/movementRetraction.ts:12-21` and `stores/runtimeStore.ts:715-725` both say so). Clicking
// the row did not turn it red; clicking the row created the writer that could. The trigger is
// MOUNT, not focus — `engine/attention.ts` reads `windowFocused` only to suppress the OS banner and
// notes that the row recolour "always happens".
//
// Green rather than gray because green is the LATCHED case: a hook stream that dies mid-turn leaves
// the last reading frozen at `working` with no contradiction possible.
//
// ── THE SIGNAL, AND WHY IT IS NOT A NEW ONE ─────────────────────────────────────────────────────
// `src-tauri/src/nudger.rs` already renders EVERY live session's grid off the PTY bytes once a
// second, with no dependency on the frontend being alive at all. `observed_attention.rs` classifies
// that grid and emits `attention://observed`. This module is the consumer: pure, so the whole
// contract below is assertable without a store, a PTY or a clock.
//
// ── THE CONTRACT, IN THE FOUNDER'S WORDS ────────────────────────────────────────────────────────
// Asked how loud an UNREADABLE screen should be, he chose neither "paint it red" nor "mint a fifth
// colour": **it never lowers and never raises — only the LATCH is broken.**
//
//     row was RED   + unreadable -> stays RED
//     row was GREEN + unreadable -> GRAY (we are no longer claiming it is working)
//     row was GRAY  + unreadable -> stays GRAY
//
// No new colour, no new alarm. Amber was unavailable on the grammar's own terms — `tokens.ts` says
// it means "the machinery stopped; nothing is owed BY you", and forbids membership in
// `attention.needsAttention` — which is the opposite of what an unreadable screen needs. A fifth
// tier would owe an arm in `StatusBand`/`RollupDot`/`statusInk`/the filter chips/the tab badges,
// a cost `tokens.ts` records explicitly so nobody pays it twice.
//
// ⚠️ THE GREEN->GRAY HALF OF THAT CONTRACT IS NOT IMPLEMENTED, and deliberately so. The only gray
// available to express it (`stopped`) is a LIFECYCLE claim rather than a neutral one, and it
// relabels a live agent as a finished session in three downstream engines — see
// {@link applyVerdict}'s `unreadable` arm. It also contradicts the founder's later rule that GRAY
// MEANS INACTIVE, which an unreadable screen cannot establish. `unreadable` therefore holds no
// opinion, pending his choice between the two rules. The `awaiting` arm — the actual fix — stands.

import type { AgentTabStatus } from "../types";
import { needsAttention } from "./attention";
import { isRedStatus } from "../services/windowStatus";
import { overlaidRowIds } from "./overlayRows";

/** What the grid said. Mirrors `observed_attention::Verdict` in Rust, lowercase on the wire. */
export type ObservedVerdict = "awaiting" | "unreadable" | "calm" | "gone";

/** One agent's reading, exactly as it crosses the wire. */
export type ObservedReading = {
  verdict: ObservedVerdict;
  /** Travels ALONGSIDE the verdict: Claude Code's own picker on the alternate buffer is `awaiting`
   *  WITH `alternate: true`, and a consumer must not have to re-derive that from the verdict. */
  alternate: boolean;
  atMs: number;
};

const VERDICTS: ReadonlySet<string> = new Set<ObservedVerdict>([
  "awaiting",
  "unreadable",
  "calm",
  // A RETRACTION, not a reading: this agent's terminal is gone, so any held verdict must be
  // DISCARDED. It exists because the producer emits on change and "the agent stopped existing" is a
  // change the other three cannot carry — without it a spun-down agent whose last reading was
  // `awaiting` stays raised forever. `services/observedAttentionListener` deletes the row rather
  // than storing this, so the overlay below should never see it; it is handled there anyway,
  // because "should never" is not a guarantee.
  "gone",
]);

/**
 * Parse ONE payload off the wire.
 *
 * ⚠️ STRICT PER-PAYLOAD, AND NEVER ALL-OR-NOTHING ACROSS THE MAP. AGENTS.md records the measured
 * incident: an all-or-nothing parser that rejects one field discards the WHOLE payload and falls
 * back to its "we did not look" default, with nothing logged — so the feature is inert permanently,
 * for everyone. Here a bad payload costs exactly that one agent's reading and the caller counts it.
 *
 * Every field is required, deliberately. The Rust side has no `Option`, so there is no `null`-vs-
 * absent ambiguity to model, and writing `alternate?: boolean` here would describe a shape the
 * producer cannot emit.
 */
export function parseObservedReading(
  raw: unknown,
): { agentId: string; reading: ObservedReading } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { agentId, verdict, alternate, atMs } = o;
  if (typeof agentId !== "string" || agentId === "") return null;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return null;
  if (typeof alternate !== "boolean") return null;
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  return {
    agentId,
    reading: { verdict: verdict as ObservedVerdict, alternate, atMs },
  };
}

/**
 * THE OVERLAY. Apply mount-independent readings to a status map.
 *
 * Three rules, one per verdict, and the two that do nothing are as load-bearing as the one that
 * acts:
 *
 * 1. `awaiting` RAISES a row to `waiting` — the fix the founder asked for, an agent blocked on a
 *    human going red without anyone having opened its pane. It raises ONLY a status that is neither
 *    red nor an attention tier: a row that is already red is already surfacing, and a row showing
 *    `questions` (BLUE — the one attention state that is GOOD news) must not be repainted in the
 *    alarm colour, which `tokens.ts` is explicit is a strictly worse outcome than the glance-
 *    readability it would buy. Two statuses ARE raised, and both for the same reason — a positive
 *    reading of the grid outranks an INFERENCE about it: `lapsed` (amber), because `tokens.ts` says
 *    a genuine red outranks it; and `blocked`, because it is the stall timer's guess and this is
 *    the thing itself. See {@link applyVerdict} for why the `blocked` promotion is load-bearing.
 *
 * 2. `unreadable` holds NO OPINION — see {@link applyVerdict}. It was a latch-break (green to
 *    gray) until roborev 67199 showed that the only available gray, `stopped`, is a LIFECYCLE claim
 *    three downstream engines read as "the session is over" — relabelling a live agent behind a
 *    full-screen TUI as a finished one, once a second.
 *
 * 3. `calm` DOES NOTHING. The wire contract calls it "the only verdict that may lower a row"; that
 *    is permission, not obligation, and this overlay declines it. Retraction is
 *    `engine/movementRetraction.ts`'s job, it has its own carefully argued contract about what
 *    licenses one (movement recorded AFTER the red was raised, never mere freshness), and letting
 *    this coarser signal lower a red that a mounted pane's richer classifier raised would fight it.
 *
 * @param hasLiveWriter Does a MOUNTED pane exist for this agent? If so the row is left untouched —
 *   that pane's reading is live, continuous and richer than a grid scrape, and this overlay exists
 *   only to supply a writer where none exists. Being over-broad here is the safe direction: a
 *   false "yes" means today's behaviour, a false "no" means fighting a live producer.
 */
export function withObservedAttention(
  agents: ReadonlyArray<{ id: string }>,
  base: Readonly<Record<string, AgentTabStatus>>,
  readings: Readonly<Record<string, ObservedReading>>,
  hasLiveWriter: (agentId: string) => boolean,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  for (const id of overlaidRowIds(agents, readings)) {
    const reading = readings[id];
    if (!reading) continue;
    if (hasLiveWriter(id)) continue;
    const current = base[id];
    const next = applyVerdict(current, reading.verdict);
    if (next === undefined || next === current) continue;
    // Copy on first write only — this runs on every sidebar render and a quiet fleet must not
    // churn a new object each time (the same reason `setStatus` drops unchanged writes).
    out ??= { ...base };
    out[id] = next;
  }
  return out ?? (base as Record<string, AgentTabStatus>);
}

/** The per-row decision, split out so the truth table is assertable directly. */
export function applyVerdict(
  current: AgentTabStatus | undefined,
  verdict: ObservedVerdict,
): AgentTabStatus | undefined {
  if (verdict === "awaiting") {
    if (current === undefined) return "waiting";
    // ⚠️ `blocked` IS PROMOTED, and it is the one red this overlay overwrites.
    //
    // `blocked` is an INFERENCE — statusEngine's stall timer firing because a row went quiet, which
    // `tokens.ts` glosses as "went quiet / stalled". `awaiting` is a POSITIVE READING of a prompt on
    // the agent's own grid. A reading outranks an inference about the same fact, and the difference
    // is not cosmetic in either direction:
    //
    //   • The COLOUR does not change — both are red — but the BAND does. `blocked` is deliberately
    //     outside `attention.needsAttention` ("needs you eventually", not "answer this now"), so it
    //     raises no dock badge and no banner. Once we have actually SEEN the prompt, "answer this
    //     now" is precisely what it is, and the badge is correct.
    //   • It is what survives step (0). `calmNewAgent` de-escalates a never-briefed agent's
    //     `blocked` to `new` (GRAY) — right when the evidence is a stall timer, wrong when the
    //     evidence is a prompt on screen. `waiting` is exempt there by DEMONSTRATED_ASK, so
    //     promoting is what keeps a briefless agent standing at a real prompt from rendering calm.
    //     That case is a live bug caught by `observedAttentionPublished.test.ts`, not a hypothetical.
    if (current === "blocked") return "waiting";
    // Every other surfacing status is a MORE specific claim than "a prompt is on screen", so it is
    // left alone: `approval` names a dangerous action, `errored` names a dead process, and
    // `questions` is BLUE — the one attention state that is good news, which `tokens.ts` is explicit
    // must never be repainted in the alarm colour. `needsAttention` and `isRedStatus` are DIFFERENT
    // sets on purpose, so both are asked; `tokens.ts` warns that reaching for the wrong one is a bug
    // that has shipped twice.
    if (needsAttention(current) || isRedStatus(current)) return undefined;
    return "waiting";
  }
  if (verdict === "unreadable") {
    // ⚠️ INERT ON THE COLOUR, AND THIS REVERSES AN EARLIER DECISION ON PURPOSE.
    //
    // It used to map a latched `working` to `stopped` — the founder's "break the latch" contract,
    // chosen over painting red or minting a fifth colour. That mapping is WRONG, for a reason the
    // colour argument could not see: `stopped` is not a neutral gray, it is a LIFECYCLE CLAIM, and
    // three engines downstream of this overlay read it as "the session is over" —
    //
    //   • `unmergedAttention.RESTING` (idle|done|stopped) relabels the row "Needs merge";
    //   • `stallEscalation.GRAY_STATUSES` includes it, so `grayFloorFor` repaints it AMBER
    //     `lapsed` ("Auto-continue stopped") outside a terminal section;
    //   • `retirementReadiness.UNREACHABLE_STATUSES` flips the retire dialog to "it can't be asked".
    //
    // …and `unreadable` is produced for a LIVE agent every time `reader_parked` (flow control) or a
    // foreign full-screen TUI holds. So a working agent was being relabelled a dead one, and could
    // flap between the two once a second (roborev 67199).
    //
    // It also collides head-on with the founder's later rule: "GRAY MEANS IT'S INACTIVE… if it's
    // still active it should be green/amber/red, but not gray." An unreadable screen is precisely
    // the case where we DO NOT KNOW whether it is active, so claiming inactive is the one thing the
    // evidence cannot support. No existing gray token means "we could not tell" — every one of
    // them (`idle`, `new`, `unmerged`, `done`, `stopped`) asserts something — and minting a fifth
    // is the cost he declined.
    //
    // So this holds NO opinion until he picks between the two rules. The feature's actual fix — an
    // agent blocked on a human going red with no pane mounted — is the `awaiting` arm above and is
    // unaffected. What is lost is only the latch-break on a green nobody can verify, which is a
    // strictly smaller harm than mislabelling a live agent as a finished one.
    return undefined;
  }
  // `calm` — see rule 3 above. `gone` too: it is a retraction the LISTENER acts on by deleting the
  // row, so by the time the overlay runs there is nothing to hold an opinion about. Reaching this
  // arm means a stale entry survived; having no opinion is the correct, harmless answer.
  return undefined;
}
