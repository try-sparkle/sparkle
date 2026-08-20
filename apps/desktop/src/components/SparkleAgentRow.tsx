import { memo } from "react";
import { C } from "../theme/colors";
import { APP_WINDOW_LABEL } from "../windowContext";
import { useInteractionStore } from "../stores/interactionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { sparkleAgentIdFor, SPARKLE_AGENT_DISPLAY_NAME } from "../services/sparkleAgent";
import { consentPillLabel } from "./sparkleRowStatus";
import { DOT_SIZE, DOT_SLOT_W, GLYPH_SLOT_H } from "../engine/rowGeometry";
import { mountsOnRowActivation } from "../engine/cable";
import type { PairSide } from "../engine/rowGeometry";
import { ActiveFillets, rowBoxFor } from "./rowAnatomy";
import { StatusDot } from "./StatusDot";
import { AGENT_NAME_FONT_SIZE, rowTitleWeight } from "./FittedAgentName";
import { useRowClock, ElapsedTimer } from "./rowClock";
import type { AgentTabStatus } from "../types";

/** The pinned, always-present Sparkle self-improvement agent row.
 *
 *  IT IS A BUILD ROW THAT HAPPENS TO BE PINNED, and everything below is about keeping it that way.
 *  It had drifted into a special case with its own vocabulary — a larger disc, its own left inset,
 *  its own font size, a sweeping gradient progress bar, a divider rule above it and a bordered
 *  consent pill — none of which any other row in the column had. The whole point of the column is
 *  that it is scannable straight down; a row with its own dialect is a row you have to stop and
 *  read.
 *
 *  So: same disc slot (DOT_SLOT_W / DOT_SIZE), same box (ROW_PAD_*, LIST_PAD_X), same title size
 *  (AGENT_NAME_FONT_SIZE) and neutral ink, same leading ElapsedTimer, same `+N` treatment for both
 *  the worker count and the consent word. It is separate from the project agents by POSITION only
 *  — pinned below the list, outside every stage group — and by nothing else.
 *
 *  What it still does NOT have, and shouldn't: a close button (it can't be closed), a rename (its
 *  name is the product's), and a stage section (it never lands work on the user's branch).
 *
 *  `st` / `dotColor` / `dotLabel` come from the caller, which derives them with the SAME
 *  effectiveStatus + rollupDot pipeline every build row goes through — see the `sparkleRow` memo in
 *  AgentSidebar. Do NOT re-derive status here; a second derivation is how the row ended up green
 *  while sitting on an unanswered picker.
 *
 *  `React.memo`'d (sparkle-alrm.3) with primitive props + a stable `onSelect`, so a project agent's
 *  status flip re-renders only that agent's row, never this pinned footer row. */
export const SparkleAgentRow = memo(function SparkleAgentRow({
  active,
  status,
  dotColor,
  dotRing,
  dotLabel,
  workerCount,
  onSelect,
  onMount,
  paneSide,
  jointOpen,
}: {
  active: boolean;
  status: AgentTabStatus;
  /** Rolled-up disc paint, when this row's workers disagree with its own status. Same override the
   *  build rows take; `undefined` means "use the status taxonomy". */
  dotColor?: string;
  /** Draw the disc as a RING: the colour describes a row UNDER this one. Set exactly where
   *  `dotColor` is — see StatusDot's `variant` (roborev 63126). */
  dotRing?: boolean;
  dotLabel?: string;
  /** Workers folded under this row. 0 today (the improvement pass runs a single agent), wired to
   *  the same rule build rows use so a future subtree gets the same badge for free. */
  workerCount: number;
  /** Reveal this window's Improve Sparkle pane. The SELECT half of a build row's gesture — it
   *  seats the pane and nothing else, and in particular it does NOT patch the cable. */
  onSelect: () => void;
  /**
   * PATCH THE CABLE ONTO THIS ROW. The MOUNT half, and the reason this prop exists at all.
   *
   * ══ THE ASYMMETRY THIS CLOSES (beads sparkle-gyvjyt, sparkle-9useo2) ══════════════════════════
   * The founder, on v0.114.0: *"I am able to double click to mount regular build agents and write
   * to them so those are working OK. It's only the Improve-Sparkle one that's not working."*
   *
   * This row was a bare `<div data-hint="improve" onClick={onSelect}>` — no `role`, no `tabIndex`,
   * no `onKeyDown`, no `onDoubleClick` — whose single callback revealed the pane and patched the
   * cable together. So it was operable by POINTER ONLY: unreachable from the keyboard and from
   * assistive tech, on the one row where that costs the entire feature, because `SparkleAgentPane`
   * carries no composer and the cable is therefore this agent's only input surface. And the gesture
   * the founder actually makes — the double press — raised no handler at all; it merely ran the
   * single-click path twice, the second `patchCable` being an identity no-op.
   *
   * ══ AND THE SPLIT IS WHAT LETS THIS ROW RUN THE SHARED GESTURE RULE ═════════════════════════════
   * Separating reveal from mount is what makes `engine/cable.mountsOnRowActivation` answerable here
   * at all: that predicate exists to decide whether an activation is a SELECT or a MOUNT, and it has
   * nothing to decide while the two are one callback. The row's `onClick` block has the gesture table
   * and the history of the one cut of this that went the other way.
   */
  onMount: () => void;
  /** Same two geometry inputs every build row takes — this row is the same anatomy, so it mirrors
   *  with the pair and opens its concierge end on the same cable. See engine/rowGeometry. */
  paneSide: PairSide;
  jointOpen: boolean;
}) {
  const consent = useSettingsStore((s) => s.sparkleImprovementConsent);
  const pill = consentPillLabel(consent);
  // The SAME "elapsed since the user last touched this agent" the build rows show — read from the
  // same interactionStore, formatted by the same ElapsedTimer, ticked by the same useRowClock.
  // `undefined` until the first interaction, so a never-touched row shows no timer at all rather
  // than an ever-growing number (see this row's note in PRD/sparkle/improve--parity.md).
  const lastTouchAt = useInteractionStore((s) => s.lastAt[sparkleAgentIdFor(APP_WINDOW_LABEL)]);
  const clockNow = useRowClock(lastTouchAt);
  const pinBox = rowBoxFor({ paneSide, jointOpen, isActive: active, pinned: true });
  return (
    <div
      data-hint="improve"
      // The selected state is carried entirely by inline paint (see the fill note below), which is
      // not a thing a test can read without asserting on colors. This mirrors the build rows'
      // `aria-selected` as a plain data hook so "which column claims the pane" is observable.
      data-active={active ? "1" : "0"}
      // ══ THE SAME ACTIVATION VOCABULARY EVERY BUILD ROW HAS — see the `onMount` prop ═════════════
      // `role` + `tabIndex` + a key handler is the trio AgentRow carries (roborev 59545/59322), and
      // it is not decoration here either: without it this row is operable by pointer ONLY, so a
      // keyboard or assistive-tech user has no gesture that reaches the agent at all — this pane has
      // no composer of its own (SparkleAgentPane), which makes the cable the ONLY input surface.
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // ══ THE SHARED PREDICATE DECIDES, EXACTLY AS IT DOES FOR A BUILD ROW (bead sparkle-9useo2) ══
        // Founder, 2026-08-20: *"For build agents, I have to double click on them to mount the
        // concierge pane. I want the improve sparkle to work the same way. So it shouldn't mount the
        // concierge pane unless I double click on improve sparkle just like any other build agent
        // works."*
        //
        // So there is no branch here for this agent, and adding one back is the change to refuse.
        // `mountsOnRowActivation` is the whole rule (engine/cable): a plain mouse press SELECTS, a
        // `dblclick` MOUNTS, and Enter/Space and a `detail === 0` assistive-tech press mount because
        // they have no double form to promote the mount to.
        //
        // ══ WHY THE PREVIOUS CUT REFUSED THIS, AND WHY THAT REASONING NO LONGER HOLDS ═══════════════
        // A press on this row used to mount unconditionally, on roborev 65160's finding: routing reads
        // the CABLE PIN and not the visible pane, so a seat-without-patch press would leave the
        // founder looking at Improve Sparkle while his words went to whatever the cable was still
        // pinned to — and this pane, having no composer, could not itself say so.
        //
        // The premise there was that nothing on screen names the far end. That stopped being true one
        // day earlier, in commit 4a656f33b (bead sparkle-9gsjqm): the concierge column now resolves
        // its mount FROM THE CABLE'S OWN PIN, so the surface the founder is typing into keeps showing
        // the mounted agent's "Chatting with ● <Agent>" chip and that agent's conversation, whatever
        // pane the build column happens to be drawing. Seat-without-patch is therefore labelled on
        // this row by the same surface every build row relies on, and it is the state the founder is
        // explicitly asking for.
        //
        // What the earlier parity work was actually FOR is below and is unaffected: the row had no
        // `role`, no `tabIndex`, no `onKeyDown` and no `onDoubleClick`, so it was unreachable from the
        // keyboard and from assistive tech entirely.
        onSelect();
        if (mountsOnRowActivation({ type: "click", detail: e.detail })) onMount();
      }}
      onDoubleClick={() => {
        // THE FOUNDER'S GESTURE. It does not re-select: the browser delivered click, click, dblclick
        // in that fixed order, so `onClick` has already run twice and the pane is seated. (`onMount`
        // re-reveals anyway — AgentSidebar.onMountSparkle — so an AT activation, which is preceded by
        // nothing, lands the pane before the cable names it.) There are no chips on this row to bail
        // over, which is why there is no `stopPropagation` dance here (contrast AgentRow, whose
        // retire/notice/epic pills each need one).
        onMount();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Space scrolls the column otherwise, and Enter would bubble to whatever else listens.
        e.preventDefault();
        onSelect();
        // AND IT STILL MOUNTS, where a plain single mouse press no longer does — the same asymmetry
        // AgentRow's `onRowKeyDown` carries. Enter/Space is the keyboard's deliberate activation with
        // no double form; dropping its mount would leave keyboard-only users with no way to reach this
        // agent at all, since the pane has no composer.
        if (mountsOnRowActivation({ type: "key" })) onMount();
      }}
      title="Improve Sparkle — reviews your usage to propose improvements to the open-source app"
      style={{
        flex: "0 0 auto",
        // The active fill's concave fillets are absolutely positioned against this box.
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        // THE SAME RULE THE BUILD ROWS USE — `rowBox`, with `pinned` set, because this row sits
        // OUTSIDE the padded scroll container and so already touches the column's edges: its open
        // end takes margin 0 where a list row takes a negative one, and its shut end is held off by
        // a POSITIVE margin where a list row simply keeps the container's padding. Both baselines
        // land the ink at the identical distance from the column edge, which is what puts this
        // row's disc on the same vertical line as every build row's.
        //
        // NOTHING HERE IS CONDITIONAL ON `active`, and that is the same rule the build rows follow:
        // geometry belongs to every row, never only the selected one. A `marginRight: active ? …`
        // narrows the row's CONTENT BOX the instant you select it, so the title under the pointer
        // jumps — the list-twitch the build rows were just fixed for.
        //
        // The trailing 6 is the gap to the footer, not a separator.
        margin: `0 ${pinBox.marginRight}px 6px ${pinBox.marginLeft}px`,
        padding: pinBox.padding,
        cursor: "pointer",
        // THE SELECTED STATE IS THE BUILD ROW'S, NOT A BESPOKE ONE — and that resolves the long
        // argument this comment used to record.
        //
        // The history, kept because the measurements are still the reason the fill is `forest`:
        // this row painted CHAT_USER_BUBBLE until roborev 53613, where its label measured 3.20/3.71
        // (dark/light), its consent pill 3.20/2.38, and the status DOT 2.64/1.70 red and 4.56/1.01
        // green — the dot the whole row reads by, invisible in light. On `forest` those become
        // 6.37/8.36, 6.37/5.35, 5.25/3.83 and 9.07/2.22, better at both ends than the sidebar's own
        // `deepForest` plane. So the active fill is `forest`, and stays.
        //
        // But `forest` on a `deepForest` column is 1.08/1.38 — the fill step is not visible and
        // never was (roborev 53662). On a BUILD row that is fine, because what actually carries
        // selection there is the SQUARE RIGHT EDGE plus the concave fillets shaping it into an
        // opening onto the terminal. This row used to have none of that geometry, which is why it
        // needed a `hairline` outline of its own to avoid being a WCAG 1.4.11 failure (roborev
        // 53814) — and that outline was the row's last piece of private vocabulary.
        //
        // It now takes the geometry instead: same square right edge, same fillets, same fill. The
        // outline is gone because the thing it was compensating for is gone. Do NOT reintroduce it,
        // and do NOT restore the older `3px solid C.goldFill` rail either — the colored version is
        // the decoration the column cleanup deliberately cut.
        //
        // NO borderTop. It was a divider rule marking this row off from the list above, and it was
        // the only horizontal rule anywhere in the column. Position already says the row is
        // separate — it is pinned below the scroll container, outside every stage group — so the
        // rule was saying it a second time, in the one vocabulary no other row uses.
        background: active ? C.forest : "transparent",
        borderRadius: pinBox.borderRadius,
      }}
    >
      {/* The disc, in the SAME fixed slot a build row gives it: fixed height so the title beside it
          sits on the glyph's line, fixed width with the disc CENTERED so its left edge lands on the
          column's one vertical line of discs. */}
      <div
        style={{
          flex: "0 0 auto",
          width: DOT_SLOT_W,
          height: GLYPH_SLOT_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StatusDot
            status={status}
            size={DOT_SIZE}
            color={dotColor}
            variant={dotRing ? "ring" : "fill"}
            label={dotLabel}
          />
      </div>
      {/* Timer, then title, then badges — the collapsed build row's strip, element for element. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: GLYPH_SLOT_H,
        }}
      >
        {lastTouchAt != null && (
          <ElapsedTimer since={lastTouchAt} now={clockNow} color={C.muted} />
        )}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              // NEUTRAL INK, like every other row's title. It used to be
              // `statusInk(AGENT_STATUS[status].color)`, which made this the one row in the column
              // whose text changed color with its status — the exact thing build and worker rows
              // were taken off years of ago. Color lives in the disc.
              color: C.cream,
              fontSize: AGENT_NAME_FONT_SIZE,
              fontWeight: rowTitleWeight(active),
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {/* THE CONSTANT, not the literal it used to be. `get_state`'s roster now names this
                agent too (bead sparkle-x0pvw), and the row and the roster answering differently is
                the exact failure engine/agentDisplayName's header was written about. */}
            {SPARKLE_AGENT_DISPLAY_NAME}
          </span>
          {/* Same `+N` a collapsed orchestrator shows. 0 today; see the prop's note. */}
          {workerCount > 0 && (
            <span
              aria-label={`${workerCount} ${workerCount === 1 ? "worker" : "workers"}`}
              title={`${workerCount} ${workerCount === 1 ? "worker" : "workers"}`}
              style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1 }}
            >
              +{workerCount}
            </span>
          )}
          <SparkleConsentBadge label={pill} />
        </div>
      </div>
      {/* THE SAME COMPONENT a selected build row draws, not a copy of it — they are what makes the
          1.08:1 fill step legible as selection, so they are not decoration and must not be dropped.
          No `showOverlay` condition here: this row has no hover card to be stood in for. */}
      <ActiveFillets ends={pinBox.filletEnds} paneSide={paneSide} />
    </div>
  );
});

/** The Always / Manual / Off badge on the Improve Sparkle row — reflects the consent mode. */
/** The consent mode (Always | Manual | Off) beside the Improve Sparkle title.
 *
 *  IT IS THE `+N` BADGE'S TWIN, not a pill. It used to be a 10px semibold capsule with a teal
 *  outline and a letter-spaced label — the only bordered chip in the column, on the only row that
 *  had one, which made a piece of ordinary row metadata read as a status announcement. It is the
 *  same class of fact as "+2 workers": a small muted note about the row, sitting in the same slot
 *  the `+N` occupies. So it takes the same ink, size and weight, and no box at all.
 *
 *  It keeps its `title`, because unlike "+2" the word alone doesn't say what it modifies. */
export function SparkleConsentBadge({ label }: { label: string }) {
  return (
    <span
      title={`Improvement PRs: ${label}`}
      style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1, whiteSpace: "nowrap" }}
    >
      {label}
    </span>
  );
}
