// THE bead card. One component, two chromes.
//
// ══ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════════
// A bead used to be drawn by three components that shared no code — the board's collapsed `Card`,
// the board's `DetailOverlay`, and the concierge's own card — so each showed a DIFFERENT subset of
// the same eight fields. The founder noticed it from the outside: the progress line was on the
// collapsed card, vanished when the card opened, and had never existed in the concierge at all.
// That is not three bugs, it is one missing component. His ask, verbatim: *"I want the card on the
// concierge column to look exactly like the card when it's in an open state on the actual plan
// board, with one exception: it would scroll after a certain height."*
//
// ══ EVERY ELEMENT IS PHRASING CONTENT, IN BOTH CHROMES ═════════════════════════════════════════
// `<span style={{ display: "block" }}>`, never `<div>`. The concierge chrome mounts inside
// `<Markdown>`'s `<p>`, where a `<div>` is invalid nesting: React emits it without complaint and the
// browser closes the paragraph and REPARENTS the node, moving the card away from the sentence that
// referenced it. HTML validity is a question about the ELEMENT, not about its CSS box, so
// `display: block`/`flex` on a span buys the layout without the invalidity.
//
// This is also the whole reason ONE component can serve both surfaces: phrasing content is equally
// valid inside the board's `<div>`, so the concierge's harder constraint is simply the constraint.
// `<button>` is already phrasing content, so the controls need no special handling.
//
// ══ WHAT SCROLLS, AND WHAT MUST NOT ════════════════════════════════════════════════════════════
// Only the DESCRIPTION, and only when the card is EXPANDED. Everything above it — title, id,
// priority, the status line, and the View-on-board button — stays pinned outside the scroll region.
// This is deliberate and follows bead `sparkle-qogah`'s rule that a row needing action is never
// hidden: a card whose whole body scrolled would take the priority control and the way out of the
// card with it.
//
// A COLLAPSED CARD SCROLLS NOTHING AT ALL — it renders no description, so there is no inner
// scroller for `descMaxHeight` to create. See `collapsed`.
//
// ══ THE WHOLE BODY IS THE EXPAND TARGET, SO EVERY CONTROL MUST STOP THE BUBBLE ═════════════════
// The founder asked for click-the-card rather than a chevron. That makes the card root's `onClick`
// an ancestor of every button on it, and React bubbles through the COMPONENT tree — including the
// priority menu, which is portaled to `document.body`. So each control (and each wrapper around a
// child component that owns its own controls) calls `stopPropagation`, or pressing Build It fires
// the build AND collapses the card in the same gesture.
//
// THAT CLICK IS A MOUSE CONVENIENCE AND NOTHING ELSE. The root carries NO `role="button"` and no
// `tabIndex`: ARIA gives the `button` role presentational children, so one on the root deletes the
// announced semantics of every control inside the card and displaces the chrome's `role="status"`.
// The disclosure semantics live on the TITLE BUTTON instead — see the root element and the title.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { FiExternalLink, FiMessageSquare, FiUsers, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { severityOf, type Bead } from "../../services/beads";
import type { BeadComment } from "../../services/beadsCommands";
import type { WorkflowStageId } from "../../engine/workflowStage";
import type { EpicGoal, EpicGoalSource } from "../../engine/epicGoal";
import type { EpicLadderKey } from "../../services/epicBoard";
import type { BeadLineage } from "../../engine/beadLineage";
import { PriorityPill } from "./PriorityPill";
import { BeadSeverityBadge } from "./BeadSeverityBadge";
import { CommentThread } from "./CommentThread";
import { EpicCardGoal } from "./EpicCardGoal";
import { TypePill } from "./TypePill";
import { BeadLineageRows } from "./BeadLineageRows";
import { StageLine } from "./StageLine";
import { stageLabel, statusDot } from "./beadStatus";

/**
 * Which surface is drawing the card.
 *
 * It governs the SHELL only — surface colour, padding, the testid prefix, and whether the card
 * announces itself as a live region. Type sizes, field order and every control are identical, which
 * is the founder's ask; a `chrome` that could change what is SHOWN would be the drift this
 * component was written to end.
 */
export type BeadCardChrome = "board" | "concierge" | "epics";

interface ChromeSpec {
  testId: string;
  surface: string;
  padding: string;
  /**
   * THE CARD'S OWN EDGE — the one shell property that genuinely differs per surface, because it
   * describes what the card is MOUNTED IN rather than what it says.
   *
   * ══ THIS IS NOT THE `chrome` ESCAPE HATCH THE FILE HEADER FORBIDS ═══════════════════════════
   * That rule is about CONTENT: a `chrome` that changed which fields or controls appear would be
   * the drift this component was written to end. Surface colour and padding are already per-chrome
   * for exactly this reason, and a border is the same kind of fact. Every field and every control
   * below is still identical in all three.
   *
   * ══ WHY EACH VALUE IS WHAT IT IS ════════════════════════════════════════════════════════════
   * • `board` — NONE. `BoardView`'s detail overlay is itself a bordered, rounded, shadowed panel
   *   with 20px of padding, and this card drew a SECOND border 20px inside it. That is the
   *   founder's item 19, screenshotted: [09:15] *"I know why we have we have, a double border
   *   around these I'm not sure why. We don't need that double border."* [09:41] *"So we can get
   *   rid of the double border. Just have one border."* The panel keeps its edge; the card drops
   *   its own, so the chain has exactly one.
   * • `concierge` — ALL FOUR SIDES, rounded. It mounts inline in a sentence with nothing around
   *   it, so its own border is the only thing making it a card.
   * • `epics` — THREE SIDES, SQUARE TOP. The card opens flush under its own row, and its
   *   `border-top` was the hairline cutting the two same-coloured fills apart: items 20 and 21,
   *   [12:55] *"the top of the card is rounded. But it shouldn't be rounded"* and [13:07]
   *   *"there's a line in between the row and the card, it should just be solid."* Dropping the
   *   top edge and squaring the top corners is one visual idea, not two — the open card reads as
   *   a continuation of its row rather than a separate floating box.
   *
   * ══ THREE SIDES ARE SPELLED AS LONGHANDS, NOT `border` PLUS `borderTop: "none"` ═════════════
   * The shorthand-then-override form is the shorter one and it is UNTESTABLE here: jsdom's
   * cssstyle drops the override outright when the colour is a `var()` — which every colour in this
   * app is — so the serialized style keeps all four sides and `border-top-style` reads empty
   * either way. A test could then assert the top edge was gone against a card that still painted
   * it. Naming the three sides that survive is both what we mean and what can be checked.
   */
  edge: CSSProperties;
  /** The concierge card IS the result of clicking a pill, so it announces itself. The board's is
   *  a panel the user navigated into and has nothing to announce. */
  role?: "status";
}

const CHROME: Record<BeadCardChrome, ChromeSpec> = {
  // NO BORDER: the detail overlay around it already is one. See `ChromeSpec.border`.
  board: {
    testId: "board-bead-card",
    surface: C.dialogSurface,
    padding: "16px 18px",
    edge: {},
  },
  concierge: {
    testId: "concierge-bead-card",
    surface: C.forest,
    padding: "10px 12px",
    edge: { border: `1px solid ${C.hairline}`, borderRadius: RADIUS.modal },
    role: "status",
  },
  // THE EPICS COLUMN'S INLINE CARD. Same fields and same controls as the other two — a `chrome`
  // that changed WHAT is shown would be the drift this component exists to end — differing only in
  // the box: the column is ~280px, so it takes the concierge's tighter padding rather than the
  // board panel's, and `epicCardFill` so the open card reads as the selected row's continuation
  // rather than as a foreign panel dropped into the ladder.
  //
  // `role: "status"` for the same reason the concierge has it: this card IS the result of clicking
  // the row above it, so it announces itself instead of appearing silently mid-list.
  epics: {
    testId: "epics-bead-card",
    surface: C.epicCardFill,
    padding: "10px 12px",
    // SQUARE-TOPPED AND OPEN AT THE TOP — the row above supplies that edge. The radius is
    // COMPOSED from `RADIUS.modal` rather than typed as a literal, so theme/scale.test.ts's
    // off-scale ratchet stays satisfied and a retune of the scale reaches here for free.
    edge: {
      borderRight: `1px solid ${C.hairline}`,
      borderBottom: `1px solid ${C.hairline}`,
      borderLeft: `1px solid ${C.hairline}`,
      borderRadius: `0 0 ${RADIUS.modal}px ${RADIUS.modal}px`,
    },
    role: "status",
  },
};

export interface BeadCardProps {
  bead: Bead;
  chrome: BeadCardChrome;
  /** The unified Think→Plan→Build stage — `beadStage(status, delivered, workerStages)`. */
  stage: WorkflowStageId;
  /**
   * WHICH BUCKET PLACED THIS CARD, from `epicBoard.ladderKeyOf` against the board the surface is
   * showing. It is the whole content of the status chip — see `beadStatus.stageLabel`.
   *
   * A SECOND AXIS FROM `stage` ABOVE, not a duplicate of it, and the two are deliberately both on
   * the card. `stage` is the Think→Plan→Build workflow line (the word beside the blue rule); this
   * is where the card SITS on the board. An epic can be "Planned" on the workflow line while
   * sitting in the Backlog column, and collapsing them would make one of those facts unsayable.
   *
   * Optional because a surface with no board behind it genuinely has no answer — see the fallback
   * note on `stageLabel`, which is a stage word either way and never the wire status.
   */
  placedIn?: EpicLadderKey | null;
  /** Names of the workers bound to this bead. Empty renders no row. */
  workers: string[];
  /** The DOM id, so a disclosure trigger can point `aria-controls` at the card. */
  id?: string;
  /** Set only when the bead lives OUTSIDE the reader's selected project. */
  projectName?: string;
  /** Cap the description's height and scroll it instead of growing. Unset means "grow to fit",
   *  which is right for a card that already sits in its own scrolling panel. */
  descMaxHeight?: number;
  /**
   * EVERY OPTIONAL CALLBACK IS ALSO THE SWITCH FOR ITS AFFORDANCE. An absent one renders no
   * control at all, which preserves the property the concierge already had: a surface with no
   * board behind it (a support modal, an agent reply, a test fixture) shows a READ-ONLY card
   * rather than buttons that cannot work.
   */
  onViewOnBoard?: () => void;
  /**
   * OPEN THIS EPIC IN THE BUILD COLUMN — narrow that column to the agents working this epic.
   *
   * ══ THE FOUNDER ASKED FOR THE PAIR, NOT FOR THIS ONE ALONE ══════════════════════════════════
   * *"maybe instead of build it, because it's already building… it could say something like Open.
   * And then there's two options, and maybe they're just two clickable links. One is in column, and
   * the other is on board."* So this prop's real job is to turn the card's single board link into
   * the two-destination **Open** group below: supplied, the card offers *in column* and *on board*
   * together; absent, it keeps the standalone board button it has always had.
   *
   * ══ WHY IT IS A SECOND CALLBACK AND NOT A FLAG ══════════════════════════════════════════════
   * Callback-is-the-switch, exactly like `onChat`, `onComment` and `goal` above. TWO different
   * surfaces cannot offer this: a board overlay is ALREADY the board (its "in column" would be a
   * jump out of the surface the reader chose), and a read-only fixture has no column to narrow. The
   * concierge card is the one place both destinations are real, and it is the place he asked from.
   *
   * ══ ONLY AN EPIC GETS IT, AND THAT IS THE CALLER'S CALL ═════════════════════════════════════
   * Nothing here reads `bead.type` — this file must never grow its own answer to "is this an epic"
   * (`scripts/lib/epic-membership-guard.sh` fails CI on a second definition, and the card is
   * exactly where a raw comparison of the bead's `type` field would look harmless). The caller
   * gates it on the shared resolver and passes nothing for a task, which renders no link at all.
   */
  onOpenInColumn?: () => void;
  /**
   * Start a concierge chat that already references this bead (bead sparkle-1cpomd). The founder
   * asked for it on EVERY bead card, task or epic — which is why it needs no branching here:
   * nothing in this component keys on `bead.type`, so "task or epic" is already the default.
   *
   * ITS ABSENCE IS THE HIDING MECHANISM, per this block's rule above, and one caller depends on
   * that rather than on any window check: the SATELLITE window mounts no `ConciergeHost` and no
   * composer anywhere in its tree, so a Chat button there would `set()` a draft into a store with
   * no reader and it would be silently DROPPED. `satellite/SatelliteApp.tsx` therefore passes
   * nothing to `BoardView`, and the callback-is-the-switch convention removes the button for free —
   * no window-detection global, and nothing for a future surface to forget to consult.
   * (`windowContext.useIsMainWindow` could not have done it: it is hard-coded `true`.)
   */
  onChat?: () => void;
  onSetPriority?: (priority: number) => Promise<void>;
  onClose?: () => void;
  onBuildIt?: () => Promise<void>;
  onBuildAllPrd?: () => Promise<void>;
  /** How many epics share this bead's PRD. The batch button appears only above 1. */
  prdEpicCount?: number;
  /** The bead's comment thread, read LAZILY by the caller when the card opens (never on the board's
   *  5s poll). `undefined` renders no thread — the concierge and any read-only surface that has not
   *  fetched comments simply omit the section, exactly like every other absent affordance here. An
   *  empty array renders the thread frame with its "no comments yet" state. */
  comments?: BeadComment[];
  /** Post a comment. Like every other callback here, its PRESENCE is the switch for the compose box:
   *  a surface that cannot write (no project path) passes nothing and shows a read-only thread. */
  onComment?: (text: string) => Promise<void>;
  /**
   * THE EPIC'S GOAL. Callback-is-the-switch, exactly like `onChat` and `onComment` above: a surface
   * that cannot write a goal — or a bead that is not an epic — passes nothing and the field is not
   * drawn at all.
   *
   * THIS DOES NOT BREAK THE "chrome NEVER CHANGES WHAT IS SHOWN" RULE at the top of this file. The
   * switch is a PROP THE CALLER SUPPLIES, not a branch on `chrome` — the board's epic overlay can
   * pass it and get the identical field. What must never happen is this component deciding, from
   * the surface it is on, that an epic's goal is worth showing here and not there.
   */
  goal?: EpicGoal;
  onSetGoal?: (text: string, source: EpicGoalSource) => void | Promise<void>;
  /**
   * DRAW THE WORKFLOW PROGRESS LINE. Default `true`, which is every surface but one.
   *
   * ══ THE FOUNDER CALLED IT "THIS LITTLE BLUE BAR" AND ASKED FOR IT OFF THE EPIC CARD ═════════
   * [13:17], reading the epics column's open card top to bottom: *"we don't wanna have this little
   * blue bar here. Don't do that."* — his item 22, immediately after the two edges above it.
   *
   * ON THAT CARD IT IS ALSO REDUNDANT, which is why the reading is coherent rather than merely
   * literal: the meta row directly above already names the stage in words, and the column is
   * ~280px wide, so a full-bleed gradient rule plus its own repeated stage word is the same fact
   * said twice in the narrowest place the app has to say it.
   *
   * ══ A PROP, NOT A BRANCH ON `chrome` ════════════════════════════════════════════════════════
   * This file's header forbids `chrome` deciding what is SHOWN, and that rule is right: it is what
   * let three drawings of one bead drift field by field. A caller-supplied switch keeps the
   * decision where it belongs — the board's overlay can pass `false` tomorrow and get the same
   * card — and is the same shape `goal`/`onSetGoal` and `onChat` already take.
   */
  showStageLine?: boolean;
  /**
   * DRAW THE HALF-HEIGHT CARD. Default `false`, i.e. the full card every surface renders today.
   *
   * The founder, 2026-08-22, about the cards the concierge posts into chat: *"they're just taking
   * up too much real estate, and I love them, but I want them to be click to expandable… maybe half
   * the height when it's closed."*
   *
   * COLLAPSED IS LESS CONTENT, NOT THE SAME CONTENT IN A SMALLER WINDOW — *"when it's collapsed, it
   * would not scroll — would just have less of the actual text."* A scrollable region nested inside
   * a scrolling thread captures the wheel and stops the thread, so a collapsed card must NOT set
   * `descMaxHeight` and must not clip a description behind an inner scroller.
   *
   * WHAT SURVIVES THE COLLAPSE: Build It (top left), the title, the id, the single merged metadata
   * line, and the two lineage rows. Everything else — description, labels, comments, composer —
   * belongs to the expanded state. This supersedes the earlier "title, id and status only" note.
   *
   * A PROP, NOT A BRANCH ON `chrome`, per this file's header: the surface supplies the state, the
   * card never decides from where it is mounted.
   */
  collapsed?: boolean;
  /**
   * Toggle {@link collapsed}. THE WHOLE CARD BODY IS THE TARGET — *"best might be that you just
   * click on the card. Right? Instead of having a Chevron."*
   *
   * ITS PRESENCE IS ALSO THE SWITCH, like every other callback here: a surface that cannot expand
   * passes nothing and the card is inert rather than advertising a gesture that does nothing.
   *
   * THE TRAP TO SOLVE RATHER THAN DISCOVER: with the body as the target, EVERY interactive child —
   * Build It, the priority pill, the id, a lineage pill, the close X — must stop propagation, or
   * the same click fires the control AND toggles the card.
   */
  onToggleCollapsed?: () => void;
  /**
   * THIS CARD'S PARENT, CHILDREN AND BUILD AGENTS, resolved by the caller via
   * `beadLineageOf(...)` in `engine/beadLineage.ts`.
   *
   * Passed in rather than derived here because resolution needs the project's full bead snapshot
   * and its agent roster — neither of which a card should reach for — and because the `EpicIndex`
   * it walks must be built ONCE per snapshot, not once per card (a raw per-card scan measured
   * 3.4–4.0s on the founder's store).
   *
   * THE SAME TWO ROWS COLLAPSED AND EXPANDED. *"If I click to expand the card, I think I would
   * still see those same fidelity of information… it would still just show me two rows."* Expansion
   * adds the rest of the card, NOT more lineage — so nothing here keys on {@link collapsed}.
   */
  lineage?: BeadLineage;
  /** Jump to a task on the `Tasks:` row. Absent renders those pills as static text. */
  onOpenBead?: (beadId: string) => void;
  /** Jump to a build agent — the same affordance the concierge uses in chat. */
  onOpenAgent?: (agent: { agentId: string; projectId?: string }) => void;
  /** A sentence the caller wants under the controls — today, "that board could not be opened". */
  notice?: string;
  /** Bumped by the caller so a REPEAT of the same notice re-registers as a live-region update
   *  rather than an identical re-render React drops on the floor. */
  noticeKey?: number;
}

/**
 * A DRAG-SELECTION IS NOT A CLICK — and, just as importantly, A KEYPRESS IS NOT A DRAG.
 *
 * `click` is dispatched to the nearest common ancestor of mousedown and mouseup, so sweeping across
 * the title, the description, or the bead id — which this file calls "a handle you copy" — ends on
 * whichever element encloses the sweep. Collapsing there hides the text the reader just selected,
 * before they can copy it.
 *
 * ══ WHY IT TAKES THE EVENT ═════════════════════════════════════════════════════════════════
 * The title's toggle is a native `<button>`, so it is ALSO activated by Enter and Space — the
 * whole reason it is a button rather than a div with a role. A keyboard activation never touches
 * the document's selection, so a guard that only reads `getSelection()` suppresses it whenever a
 * selection happens to exist anywhere on the page: sweep the description with the mouse, tab to the
 * title, press Enter, and the control is silently dead. `detail` is 0 for a keyboard-generated
 * click and >= 1 for a real pointer click, which is what separates the two.
 *
 * SHARED because the card has TWO toggle entry points: the card root and the title's disclosure
 * button. The button stops the bubble, so it never reaches the root's copy of this check — a guard
 * written only on the root leaves the title, the most natural thing to sweep across, unprotected.
 */
function gestureSelectedText(e: { detail: number }): boolean {
  // A KEYBOARD ACTIVATION IS ALWAYS ALLOWED THROUGH. It cannot have produced a selection, so there
  // is nothing here to protect, and suppressing it breaks the affordance the button exists for.
  if (e.detail === 0) return false;
  const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
  return sel !== null && !sel.isCollapsed && sel.toString() !== "";
}

/** A block-level span. Written once so no call site below can reach for a `<div>` by reflex. */
const block = (extra: CSSProperties = {}): CSSProperties => ({ display: "block", ...extra });

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

/**
 * KEEP A CLICK OFF THE CARD BODY.
 *
 * The card root is the expand/collapse target, so every control on the card — and every child
 * component that owns controls of its own (the priority pill and its portaled menu, the goal
 * editor, the comment composer) — has to swallow the bubble. Written once, because "I added a
 * button and forgot the `stopPropagation`" is the exact defect the founder asked to have solved
 * rather than discovered later.
 *
 * `display: contents` on the wrappers below, NOT `block`: the wrapper must not become a flex item
 * of its own or it would change the spacing of a component it is only listening on.
 */
const swallow = (e: { stopPropagation: () => void }): void => {
  e.stopPropagation();
};

/** A wrapper that exists only to swallow clicks — see {@link swallow}. */
const SWALLOW_BOX: CSSProperties = { display: "contents" };

/** THE TITLE'S OWN METRICS, shared by the plain span and by the disclosure BUTTON that stands in
 *  for it when the card can expand — so the control is pixel-for-pixel the text it replaces. */
const TITLE_STYLE: CSSProperties = {
  display: "block",
  minWidth: 0,
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: TYPE.title,
  lineHeight: 1.3,
};

/** …and everything a `<button>` drags in that a `<span>` does not: it never inherits the card's
 *  font, and it arrives with a UA border, background, padding and centred text. */
const TITLE_BUTTON_RESET: CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  fontFamily: FONT_UI,
  cursor: "pointer",
  // ══ A BUTTON LABEL IS NOT A SELECTION TARGET, AND THE TITLE MUST STAY ONE ═════════════════
  // Without these the drag-selection guard beside the toggle is protecting a capability the
  // runtime has already removed: in the Tauri WKWebView a `<button>`'s label cannot be swept at
  // all, so "select the title and copy it" — the exact thing the guard exists for — is impossible.
  // jsdom applies no UA stylesheet for `user-select`, so no behavioural test can show this; it is
  // pinned as a style value beside the card's other layout-invisible rules.
  userSelect: "text",
  WebkitUserSelect: "text",
};

/**
 * ONE ITEM ON THE MERGED META LINE.
 *
 * The founder, 2026-08-22: *"we have backlog, p two, task — and then we have the row that says
 * planned. I think we can all make that one line. So the row would not be the full width of the
 * card, but it would be to the right of where it says task. Let's make that on the same line so the
 * row is just as wide, but we save a row of height."* — so the build-state row and the metadata row
 * are ONE row, in both states, and the saving applies collapsed AND expanded.
 */
interface MetaItem {
  key: string;
  node: ReactNode;
  /** Take the line's remaining width. Exactly one item wants this — the progress rule, which is a
   *  bar and therefore the only item with no intrinsic width worth keeping. */
  grow?: boolean;
  /**
   * GIVE GROUND RATHER THAN CLIP. Set on the two items whose length is CONTENT, not a fixed label:
   * the parent-epic chip (its text is a bead TITLE, and "A TITLE CAN BE A SENTENCE") and
   * `in ${projectName}`.
   *
   * WITHOUT IT THE CHIP'S ELLIPSIS CANNOT FIRE. `maxWidth: "100%"` resolves against the item's own
   * wrapper, so an unshrinkable `flex: "0 0 auto"` wrapper is always exactly as wide as its text —
   * `text-overflow` has nothing to overflow. Under the row's `nowrap` + `overflow: hidden` a long
   * epic title then clipped silently at the card's edge, and the chip is the LAST item on the line,
   * so it is precisely the thing that disappeared.
   *
   * The short fixed labels (Build It, the status word, `P1`, `epic`) must NOT take this: they are
   * already minimal, and letting them shrink is what broke words mid-letter ("Backl/og", "e/pi/c")
   * in the `concierge-bead-card` capture.
   */
  shrink?: boolean;
}

/** THE **Open** GROUP'S LINK SHAPE, written once so the two destinations cannot drift apart — a
 *  pair of navigation links that differ by a shade or a weight stops reading as one choice.
 *
 *  A `<button>` painted as a link, which is the honest combination here: it moves the app rather
 *  than following an href (so it is not an `<a>`), but it offers a CHOICE BETWEEN destinations
 *  rather than performing an action (so it is not drawn as a button). `padding: 0` and the
 *  transparent background are what strip the UA button chrome; `accentInk` + underline are what the
 *  rest of the app already uses to say "this goes somewhere". */
const openLinkStyle: CSSProperties = {
  flex: "0 0 auto",
  background: "transparent",
  border: "none",
  padding: 0,
  color: C.accentInk,
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  lineHeight: 1.4,
  textDecoration: "underline",
  // The link is the thing the eye lands on; the label beside it is not. Without this the
  // underline sits hard against the descenders at the card's small type size.
  textUnderlineOffset: 2,
};

/** A metadata line — a faint field name followed by its value. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: "flex", gap: 8, fontSize: TYPE.small, lineHeight: 1.4 }}>
      <span style={{ color: C.muted, flex: "0 0 auto", minWidth: 62 }}>{label}</span>
      <span style={{ color: C.cream, minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </span>
  );
}

export function BeadCard({
  bead,
  chrome,
  goal,
  onSetGoal,
  stage,
  placedIn,
  workers,
  id,
  projectName,
  descMaxHeight,
  onViewOnBoard,
  onOpenInColumn,
  onChat,
  onSetPriority,
  onClose,
  onBuildIt,
  onBuildAllPrd,
  prdEpicCount,
  comments,
  onComment,
  showStageLine = true,
  collapsed = false,
  onToggleCollapsed,
  lineage,
  onOpenBead,
  onOpenAgent,
  notice,
  noticeKey,
}: BeadCardProps) {
  const spec = CHROME[chrome];
  const t = spec.testId;

  // ── THE PRIORITY WRITE ────────────────────────────────────────────────────────────────────────
  //
  // ══ THE OPTIMISTIC VALUE LIVES HERE, NEVER IN `beadsStore` ══════════════════════════════════
  // That store replaces its whole snapshot on every 5-second poll, so an optimistic priority
  // written into it would be clobbered by the next tick — reverting under the reader's eyes for no
  // reason they could see. Held in component state it survives until the poll delivers the truth,
  // and the effect below retires it the moment `bead.priority` agrees.
  const [optimistic, setOptimistic] = useState<number | null>(null);
  // ══ TWO BUSY FLAGS, NOT ONE ═══════════════════════════════════════════════════════════════════
  // One shared flag made a PRIORITY save relabel the primary action to "Building…" and disable it —
  // telling the reader a build had started when none had. On the board that is a straight
  // regression: `DetailOverlay` had a `buildBusy` only the build handlers touched. A single `err`
  // slot is still right (one control is in flight at a time, and the sentence names its own cause).
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (optimistic !== null && bead.priority === optimistic) setOptimistic(null);
  }, [bead.priority, optimistic]);

  async function pickPriority(p: number) {
    if (onSetPriority === undefined || priorityBusy) return;
    const previous = optimistic;
    setErr("");
    setOptimistic(p);
    setPriorityBusy(true);
    try {
      await onSetPriority(p);
      // Deliberately NOT clearing `optimistic` here. The write landed in `bd`, but this app's view
      // of `bd` is a poll — up to five seconds behind — so clearing now would snap the pill back to
      // the OLD value and then forward again. The effect above clears it when the truth arrives.
    } catch (e) {
      // ROLL BACK. The pill is the only thing that moved, so the only honest thing to show is the
      // value the bead still has, next to a sentence saying why it did not change.
      setOptimistic(previous);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPriorityBusy(false);
    }
  }

  async function runBuild(fn: () => Promise<void>) {
    if (buildBusy) return;
    setErr("");
    setBuildBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuildBusy(false);
    }
  }

  const shownPriority = optimistic ?? bead.priority;

  // ── THE MERGED LINE ───────────────────────────────────────────────────────────────────────────
  // Build It, then status, priority, severity, type, project, the build state, and the parent epic.
  // What used to be TWO rows — the metadata row and the full-bleed progress rule beneath it — is
  // one, which is the row of height this whole change reclaims. It is merged in BOTH states, per
  // the founder: he described the saving on the card as such, not on the collapsed card.
  const meta: MetaItem[] = [];

  // ══ BUILD IT COMES FIRST, AND SURVIVES THE COLLAPSE ═════════════════════════════════════════
  // *"I think build it should probably actually be in the top left corner instead of the bottom
  // left because if it's long, and we're doing a click to expand, that's a lot… And in that case,
  // it COULD still say build it when it's collapsed, so that would be okay."* He reversed himself
  // mid-thought and the SECOND position is the decision. The reasoning is load-bearing rather than
  // cosmetic: an action at the BOTTOM of a long card cannot be reached without expanding first,
  // which is precisely what collapsing was supposed to save.
  //
  // `Build all N epics` deliberately does NOT come with it — it is the secondary action, it names a
  // number that needs the rest of the card to make sense of, and it stays where it was, expanded.
  if (onBuildIt !== undefined) {
    meta.push({
      key: "build-it",
      node: (
        <button
          type="button"
          data-testid={`${t}-build-it`}
          onClick={(e) => {
            // THE TRAP, SOLVED HERE. Without this the same click builds AND collapses the card.
            e.stopPropagation();
            void runBuild(onBuildIt);
          }}
          disabled={buildBusy}
          title="Build It — claim this unit of work and hand it to the Build orchestrator"
          style={{
            flex: "0 0 auto",
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: RADIUS.modal,
            // THE LINE'S OWN METRICS, not the old standalone row's `5px 14px`. It now shares a line
            // with `TYPE.small` metadata, and a taller button would put back the height the merge
            // just saved — the row is only as short as its tallest item.
            padding: "3px 10px",
            fontSize: TYPE.small,
            fontWeight: FONT_WEIGHT.semibold,
            cursor: buildBusy ? "default" : "pointer",
            opacity: buildBusy ? 0.7 : 1,
            fontFamily: FONT_UI,
          }}
        >
          {buildBusy ? "Building…" : "Build It"}
        </button>
      ),
    });
  }

  meta.push({
    key: "status",
    node: (
      <span style={{ ...rowStyle, gap: 5 }}>
        <span style={{ ...statusDot(bead.status), display: "inline-block" }} aria-hidden />
        {stageLabel(bead, placedIn)}
      </span>
    ),
  });
  if (onSetPriority !== undefined) {
    meta.push({
      key: "priority",
      node: (
        // WRAPPED TO SWALLOW THE CLICK. The pill's menu is PORTALED to `document.body`, and React
        // bubbles through the component tree rather than the DOM tree — so without this, picking a
        // priority from a menu that is not even inside the card still toggles the card.
        <span style={SWALLOW_BOX} onClick={swallow}>
          <PriorityPill
            testId={`${t}-priority`}
            priority={shownPriority}
            disabled={priorityBusy}
            onChange={(p) => void pickPriority(p)}
          />
        </span>
      ),
    });
  } else if (shownPriority !== undefined) {
    // READ-ONLY, and it must still SAY the priority. A surface with no project path cannot write,
    // but the number is the single most decision-relevant field on the card.
    meta.push({
      key: "priority",
      node: <span data-testid={`${t}-priority-readonly`}>{`P${shownPriority}`}</span>,
    });
  }
  // SEVERITY — a distinct axis beside priority (the founder asked for both visible), read from the
  // `sev-<N>` label. Renders nothing when the bead carries no score, so it adds a meta item only when
  // there is one to show; `severityOf` returns null otherwise.
  const severity = severityOf(bead);
  if (severity !== null) {
    meta.push({
      key: "severity",
      node: <BeadSeverityBadge severity={severity} testId={`${t}-severity`} />,
    });
  }
  // NO `type` ITEM ON THIS ROW — the TYPE PILL in the card's top-left corner is where the type is
  // shown now, and it is shown ONCE. This line printed it a second time, in bd's own lowercase, in
  // the middle of the metadata row; the founder's screenshot for `sparkle-huw924.8` is exactly that
  // — a `bug` card reading "· Done · P0 bug ▁▁▁ Merged" with an empty pill slot above it. Removing
  // the pill without removing this would leave the duplicate; removing this without the pill would
  // lose the field. See `BeadCard/TypePill.tsx`.
  // Only when the bead is somewhere else. "View on board" calls `selectProject`, so this is the
  // line that turns a silent whole-project jump into a choice.
  if (projectName !== undefined && projectName !== "") {
    // SHRINKABLE — a project name is content, not a fixed label. See `MetaItem.shrink`.
    meta.push({
      key: "project",
      shrink: true,
      // TRUNCATION RULES, because this item is `shrink: true`. A shrinkable box with no
      // `overflow`/`text-overflow` does not ellipsise — it just renders past its own width, so a
      // long project name pushed the merged line out under `nowrap` instead of giving way.
      node: (
        <span
          data-testid={`${t}-project`}
          title={`in ${projectName}`}
          style={{
            display: "block",
            minWidth: 0,
            // …and a CEILING, matching the parent chip. `minWidth: 0` lets it give ground but does
            // not bound it, so without this the text can still lay itself out wider than the
            // wrapper and paint over the items after it on the line.
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {`in ${projectName}`}
        </span>
      ),
    });
  }

  // ══ THE BUILD STATE, TO THE RIGHT OF `type` — HIS ITEM, VERBATIM ════════════════════════════
  // *"the row would not be the full width of the card, but it would be to the right of where it
  // says task."* So the progress rule keeps its bar AND its stage word; what it loses is the
  // full-bleed row of its own. `grow` is what makes it "not the full width of the card": it takes
  // whatever the named fields left over, and no more.
  //
  // STILL GOVERNED BY `showStageLine`, unchanged. The epics column passes `false` and gets no bar
  // and no stage word at all — see that prop, and item 22 in `BeadCardChrome.test.tsx`.
  if (showStageLine) {
    meta.push({
      key: "stage",
      grow: true,
      node: <StageLine stage={stage} height={3} testId={`${t}-stage`} />,
    });
  }

  // ══ THE PARENT EPIC RIDES THIS LINE TOO, AT ITS RIGHT END ═══════════════════════════════════
  // The founder settled this on 2026-08-22 when asked — he had never specified it. A chip here
  // costs ZERO extra height and keeps *"just two rows, one for tasks and one for build agents"*
  // literally true; a third lineage row would have cost height on the MAJORITY of cards, since most
  // beads are tasks inside an epic — the exact height this change is reclaiming.
  //
  // ONE PARENT TREATMENT, NOT TWO. This replaces the expanded-only `Field label="Epic"` that
  // printed `bead.parent` as raw mono id text.
  //
  // IT READS THE TITLE, and falls back to the raw id: `lineage.parent` is a whole `Bead`, so the
  // chip can say what the epic IS. A surface that passes no lineage has only ever known the id —
  // that is not a reason to say nothing, so the id is what it shows.
  const parentBead = lineage?.parent ?? null;
  const parentId = parentBead?.id ?? bead.parent ?? null;
  const parentLabel = parentBead === null ? parentId : parentBead.title || parentBead.id;
  if (parentId !== null && parentLabel !== null && parentLabel !== "") {
    const openParent = onOpenBead;
    meta.push({
      key: "parent",
      // SHRINKABLE, or the ellipsis below is decoration. See `MetaItem.shrink`.
      shrink: true,
      node: (
        <span
          data-testid={`${t}-parent`}
          data-bead-id={parentId}
          title={`Epic: ${parentLabel}`}
          aria-label={`Epic: ${parentLabel}`}
          role={openParent === undefined ? undefined : "button"}
          tabIndex={openParent === undefined ? undefined : 0}
          onClick={
            openParent === undefined
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  openParent(parentId);
                }
          }
          onKeyDown={
            openParent === undefined
              ? undefined
              : (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  openParent(parentId);
                }
          }
          style={{
            display: "inline-block",
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: "100%",
            // A TITLE CAN BE A SENTENCE. It ellipsises rather than wrapping the merged line onto a
            // second one, which would give back the height this change exists to save.
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            background: "transparent",
            border: `1px solid ${C.hairline}`,
            borderRadius: RADIUS.input,
            color: C.cream,
            padding: "1px 7px",
            fontSize: TYPE.small,
            lineHeight: 1.5,
            cursor: openParent === undefined ? "default" : "pointer",
          }}
        >
          {parentLabel}
        </span>
      ),
    });
  }

  // The batch is offered only when there is a batch: one epic sharing a PRD with itself is not one.
  // Narrowed to a callback rather than to a boolean so the JSX below needs no non-null assertion.
  const buildAllPrd = (prdEpicCount ?? 0) > 1 ? onBuildAllPrd : undefined;

  // ── WHAT THE COLLAPSED CARD IS ────────────────────────────────────────────────────────────────
  // Derived from WHICH FIELDS ARE SHOWN, never from a pixel height — the founder left the number
  // open (*"maybe I don't know, half the height"*) and the concierge column is user-resizable, so a
  // hard-coded height would be wrong at every width but one.
  //
  // COLLAPSED KEEPS: the chrome row (the id and the way out of the card), the title, the merged
  // line — Build It included — and the two lineage rows. EXPANDED ADDS: the goal, the description,
  // the labels, the workers row, `Build all N epics`, and the comment thread. That is roughly half
  // the rows on a typical card and it shrinks further on a bead with less to say, which is the
  // property a fixed height cannot have.
  //
  // A COLLAPSED CARD THEREFORE SCROLLS NOTHING: *"when it's collapsed, it would not scroll — would
  // just have less of the actual text."* A scroller nested inside the scrolling thread captures the
  // wheel and stops the thread, so the fix is not a shorter clamp — it is NO clamped element. The
  // description is the only thing `descMaxHeight` ever reaches, and `expanded` is what decides
  // whether it is drawn at all, so the prop simply has nothing to act on here.
  const expanded = !collapsed;
  const toggles = onToggleCollapsed !== undefined;

  return (
    <span
      id={id}
      // ══ THE CARD BODY IS A MOUSE CONVENIENCE — THE TOGGLE ITSELF IS THE TITLE BUTTON ═════════
      // *"best might be that you just click on the card. Right? Instead of having a Chevron, you
      // just click on each of these cards to expand it."* That gesture is kept, exactly: a click
      // anywhere on the body still opens the card.
      //
      // WHAT IS **NOT** HERE, AND WHY: `role="button"` + `tabIndex={0}`. ARIA gives the `button`
      // role PRESENTATIONAL CHILDREN — assistive tech drops the semantics of everything inside it.
      // Putting it on the ROOT therefore silenced every control on the card at once (Build It, the
      // priority pill, Chat, View on board, Close, the parent chip, the goal editor, the comment
      // box) the moment a caller wired `onToggleCollapsed`, and made the whole card ONE tab stop
      // wrapping other tabbable elements. It also DISPLACED the chrome's `role="status"` on every
      // card, expanded ones included, so a card posted into the concierge thread stopped announcing
      // itself. The root keeps `spec.role` and the disclosure semantics live on the TITLE BUTTON
      // below — a real `<button aria-expanded aria-controls>` that gets Enter and Space for free.
      //
      // THE CALLBACK IS STILL THE SWITCH: a surface that cannot expand passes nothing and the card
      // is INERT — no handler, no pointer cursor, and a title that is plain text again.
      role={spec.role}
      onClick={
        toggles
          ? (e: { detail: number }) => {
              if (gestureSelectedText(e)) return;
              onToggleCollapsed();
            }
          : undefined
      }
      data-testid={t}
      data-bead-id={bead.id}
      data-collapsed={collapsed ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        margin: chrome === "concierge" ? "6px 0" : undefined,
        padding: spec.padding,
        background: spec.surface,
        ...spec.edge,
        fontFamily: FONT_UI,
        cursor: toggles ? "pointer" : undefined,
        // The card carries prose, and a pill it may sit beside is `nowrap`.
        whiteSpace: "normal",
        // Bead titles carry paths, branch names and identifiers with no break opportunity at all.
        overflowWrap: "anywhere",
      }}
    >
      {/* ── THE CHROME ROW — THE EPIC PILL TOP-LEFT, THE ID AND THE CONTROLS TOP-RIGHT ──────
          The founder's layout, from the card as it looks CLOSED on the planning board: [08:42]
          *"We have it above the title. So that should be above the title, and that's gonna work
          well because when they say when it says epic there, we've got space in the top right,
          and that's where the chat button and the bead ID are gonna go in the top right. And then
          in the top left, it'll say epic."* [10:08] *"it should look the same when it's open as
          it does when it's closed."*

          SO THE TITLE MOVES DOWN A LINE, which is also his: [05:44] *"that would mean that the
          title is gonna go down one row."* Nothing here is gated on `chrome` — the board's
          expanded epic gets the identical corner, which is the whole point of one component. */}
      <span data-testid={`${t}-chrome`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* THE PILL IS DRAWN FROM THE BEAD, NOT FROM THE SURFACE. The board's collapsed card
            renders this same component from the same test, so the two cannot drift about what a
            type looks like — see `BeadCard/TypePill.tsx` for why it was extracted.

            IT IS THE TYPE PILL, NOT AN EPIC BADGE. The founder's screenshot for `sparkle-huw924.8`
            was an OPEN card of type `bug`: this corner was empty and the type appeared as plain
            lowercase text mid-way along the metadata row below. *"An epic reads EPIC, a bug reads
            BUG, a task reads TASK."* So there is no condition here at all — the component itself
            renders nothing for a bead bd gave no type — and the metadata row no longer prints the
            type a second time.

            The epic/other COLOUR decision lives inside the pill, where `isTypedEpic` can own it:
            "epic" has had three competing meanings in this codebase and `services/beads.ts` is the
            one place allowed to say which is meant. */}
        <TypePill type={bead.type} testId={`${t}-type-pill`} />
        {/* THE SPACER IS THE WHOLE LAYOUT. It takes the slack, so the cluster is pinned right and
            the pill left with no positioning and no `justify-content` fighting a wrapped pill.
            `aria-hidden` because it says nothing. */}
        <span aria-hidden style={{ flex: 1, minWidth: 0 }} />
        {/* ID FIRST, THEN CHAT — [09:52] *"chat would go to the right. The SparkLE ID would go to
            the left of chat."* Source order IS render order in a row flex container, so this is
            the assertion `BeadCardChrome.test.tsx` pins: the id node precedes the chat node.

            THE CLOSE BUTTON IS STILL HERE, DELIBERATELY. [07:51] has it moving up into the epic
            ROW, where the `6/6` count sits when collapsed — that lands in `EpicsColumn.tsx`'s
            `EpicRow`, which another branch is rewriting right now, so it is deferred rather than
            raced. */}
        {/* ══ IT MUST BE ABLE TO GIVE GROUND ═══════════════════════════════════════════════════
            `flex: "0 1 auto"` + `minWidth: 0`, NOT `0 0 auto`. This cluster carries the id plus up
            to three buttons — the concierge supplies all three at once — and its intrinsic width is
            roughly 300px. The epics column is ~280px and the concierge column is user-resizable
            down to `CONCIERGE_MIN_WIDTH`, so a cluster that cannot shrink pushes itself straight
            through the card's padding box and past its border: the row's only other flexible item
            is the zero-content spacer, and the card's `overflowWrap: "anywhere"` does not apply to
            a `nowrap` span. The id absorbs the squeeze (it ellipsizes below) while every BUTTON
            keeps `flex: "0 0 auto"` and stays pressable — the right priority, since the id is a
            handle you copy and the buttons are the only way out of the card.

            jsdom has no layout engine, so nothing here can be caught by rendering it; the test
            pins the style values instead, which is what the app's other narrow-column components
            do for the same reason. */}
        <span
          data-testid={`${t}-corner`}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 1 auto", minWidth: 0 }}
        >
          {/* ── THE ID ───────────────────────────────────────────────────────────────────
              MONO AND SMALL, in the corner. Mono because a bead id is what the founder types,
              greps and asks other agents about — [05:30] *"It can be that career style font
              that's fine"*, his rendering of "courier". `TYPE.micro` because he asked for it
              SMALLER than it was: [05:17] *"make it smaller font size, make it the same font
              size as the word open is."* It sat on a line of its own under the title at
              `TYPE.small`; it is now the left half of the top-right cluster. */}
          <span
            data-testid={`${t}-id`}
            // RECOVERABLE WHEN IT TRUNCATES. The corner cluster is the narrowest real estate on the
            // card and the id is the only shrinkable thing in it, so in the concierge's default
            // 360px column it ellipsises to a couple of characters — measured in the
            // `concierge-bead-card` capture. An id is a HANDLE the founder copies and greps, so a
            // truncated one with no way to read it is the same as not rendering it at all. The
            // cluster's own layout is a separate, larger question (see the note on this bead).
            title={bead.id}
            style={{
              color: C.muted,
              opacity: 0.8,
              fontSize: TYPE.micro,
              fontFamily: FONT_MONO,
              // TRUNCATES RATHER THAN PUSHING. `nowrap` keeps the id on one line (it is a handle,
              // not prose, and a wrapped `sparkle-huw924.5` is unreadable); these three are what
              // stop that line from being a battering ram against the controls beside it.
              whiteSpace: "nowrap",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {bead.id}
          </span>
          {onChat !== undefined && (
            // ══ THE BLUE IS BUILD IT'S BLUE, THE METRICS ARE THE TITLE ROW'S ═════════════════════
            // `C.teal` / `ON_BRAND_FILL` / `border: none` / `RADIUS.modal` are lifted verbatim from
            // the Build It button below, because the founder asked for "the same blue as Build It"
            // and a second near-teal would read as a different kind of action. Everything else is
            // this ROW's scale — the compact padding and `TYPE.small` its two neighbours use — so it
            // reads as a corner control rather than a second call-to-action shouting over the title.
            //
            // NO POSITIONING. The chrome row's spacer is `flex: 1`, so `flex: "0 0 auto"` is the
            // whole layout: the spacer takes the slack and this lands top-right. Absolute
            // positioning here would overlap the title, which now sits on the line below and is a
            // sentence long in the common case.
            //
            // NOT GATED ON `buildBusy`. That flag exists because ONE shared flag made a priority save
            // relabel the primary action to "Building…" (see the two-busy-flags note above); handing
            // a draft to the composer is synchronous and starts nothing, so it has no busy state of
            // its own to add and no business reading anyone else's.
            <button
              type="button"
              data-testid={`${t}-chat`}
              // STOPS THE BUBBLE. The card body is the expand target; without this, asking
              // Sparkle about the bead also collapses the card you asked from.
              onClick={(e) => {
                e.stopPropagation();
                onChat();
              }}
              title="Chat with Sparkle about this bead — starts a message that references it"
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: C.teal,
                color: ON_BRAND_FILL,
                border: "none",
                borderRadius: RADIUS.modal,
                cursor: "pointer",
                padding: "2px 8px",
                fontFamily: FONT_UI,
                fontSize: TYPE.small,
                lineHeight: 1.4,
              }}
            >
              <FiMessageSquare size={12} aria-hidden />
              Chat
            </button>
          )}
          {onViewOnBoard !== undefined && onOpenInColumn === undefined && (
            // A BUTTON, not a fake link. It was an underlined `accentInk` run — which reads as
            // navigation to somewhere else on the page and is the founder's item 3. It performs an
            // action inside the app, so it is drawn as the control it is.
            //
            // ══ AND IT STANDS DOWN WHEN THE **Open** GROUP IS DRAWING BOTH DESTINATIONS ═══════
            // `onOpenInColumn` is the signal that this card has TWO places to go (an epic in the
            // concierge). The founder asked for those two as a pair — *"there's two options… one
            // is in column, and the other is on board"* — so when both exist they belong in the
            // one group below, and rendering the board here as well would put "on board" on the
            // card twice, three inches apart, doing the same thing. This is the whole reason the
            // group takes over rather than sitting alongside.
            //
            // The condition is on the NEW prop, never on `chrome`: this file's header forbids the
            // surface deciding what is shown, and a board overlay that never passes
            // `onOpenInColumn` keeps this button unchanged — which is every caller but one.
            <button
              type="button"
              data-testid={`${t}-view-on-board`}
              onClick={(e) => {
                e.stopPropagation();
                onViewOnBoard();
              }}
              title="Open the Plan board focused on this card"
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "transparent",
                border: `1px solid ${C.hairline}`,
                borderRadius: RADIUS.input,
                color: C.accentInk,
                cursor: "pointer",
                padding: "2px 8px",
                fontFamily: FONT_UI,
                fontSize: TYPE.small,
                lineHeight: 1.4,
              }}
            >
              <FiExternalLink size={12} aria-hidden />
              View on board
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              data-testid={`${t}-close`}
              aria-label="Close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                background: "transparent",
                border: `1px solid ${C.hairline}`,
                borderRadius: RADIUS.input,
                color: C.muted,
                cursor: "pointer",
                padding: "2px 8px",
                fontFamily: FONT_UI,
                fontSize: TYPE.small,
                lineHeight: 1.4,
              }}
            >
              <FiX size={13} aria-hidden />
            </button>
          )}
        </span>
      </span>

      {/* ── TITLE — AND, WHEN THE CARD CAN EXPAND, THE DISCLOSURE CONTROL ITSELF ──────────────
          A REAL `<button aria-expanded aria-controls>`, rather than a `role` on the card root.
          The root carried both until ARIA's PRESENTATIONAL CHILDREN rule was pointed at it: one
          `button` wrapped around the whole card silences the semantics of every control inside it
          — see the root above. An accordion header is what this actually is, and the title is the
          honest label for it, since it names the thing that opens. A native button also brings
          Enter, Space and a focus ring with it instead of re-implementing them on a span.

          NOTHING MOVES. The button is reset back to the span's own metrics, and `<button>` is
          already phrasing content, so it is exactly as valid inside `<Markdown>`'s `<p>` as the
          span it replaces (this file's header).

          CALLBACK-IS-THE-SWITCH, like every other affordance here: a surface that cannot expand
          gets plain text back rather than a control that does nothing. */}
      {toggles ? (
        <button
          type="button"
          data-testid={`${t}-title`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={(e) => {
            // STOPS THE BUBBLE, like every other control on this card. The root's own `onClick` is
            // an ancestor of this one, so without it the gesture toggles TWICE and nets to nothing.
            e.stopPropagation();
            // …and BECAUSE it stops the bubble, the root's selection guard never runs for this
            // gesture. The title is the most natural thing on the card to sweep across, so without
            // its own check, selecting the title collapsed the card and hid it.
            if (gestureSelectedText(e)) return;
            onToggleCollapsed();
          }}
          style={{ ...TITLE_STYLE, ...TITLE_BUTTON_RESET }}
        >
          {bead.title || bead.id}
        </button>
      ) : (
        <span data-testid={`${t}-title`} style={TITLE_STYLE}>
          {bead.title || bead.id}
        </span>
      )}

      {/* ── THE GOAL ───────────────────────────────────────────────────────────────────────────
          DIRECTLY UNDER THE TITLE, which is where the founder put it: [05:44] "the title is gonna
          go down one row… and then where the bead name currently is right now, we would have the
          goal." The title moves down as the id and the chat button take the top-right corner
          (bead sparkle-huw924.5), and the goal takes the line beneath it.

          ABOVE THE ID, not below, so the two things a person reads about an epic — what it is
          called and what it is FOR — are adjacent. The id is a handle you copy, not prose. */}
      {expanded && onSetGoal !== undefined && (
        // WRAPPED TO SWALLOW THE CLICK — the goal editor is a text field and a Save button, and a
        // click landing on either of them must not also collapse the card out from under the edit.
        <span style={SWALLOW_BOX} onClick={swallow}>
          <EpicCardGoal goal={goal} onSetGoal={onSetGoal} testId={t} />
        </span>
      )}

      {/* ── META ─────────────────────────────────────────────────────────────────────────────── */}
      <span
        data-testid={`${t}-meta`}
        style={{
          ...rowStyle,
          // ══ ONE LINE MEANS `nowrap`, AND THAT IS THE WHOLE POINT OF THE MERGE ═══════════════
          // `rowStyle` wraps, and inherited here it undid the change: at the concierge's DEFAULT
          // 360px the merged line broke onto THREE lines — worse than the two rows it replaced.
          // Measured in the `concierge-bead-card` capture. The founder merged these to SAVE a row
          // ("I think we can all make that one line"), so a line that wraps is not a narrower
          // version of the feature, it is the absence of it.
          //
          // Nothing is silently clipped by this: the stage item carries `flex: 1 1 96px;
          // minWidth: 0` and gives up its width first — exactly the "not the full width of the
          // card" behaviour he asked for — and the two content-length items (the parent chip and
          // `in <project>`) are `flex: 0 1 auto; minWidth: 0`, which is what lets the chip's
          // ellipsis actually fire rather than clipping the title at the card's edge.
          flexWrap: "nowrap",
          minWidth: 0,
          // The backstop, and it is deliberately CLIPPING rather than wrapping: a merged line that
          // wraps is the absence of the feature, while a clipped tail still reads as one line and
          // still says the things that matter first (Build It, status, priority).
          overflow: "hidden",
          color: C.conciergeMuted,
          fontSize: TYPE.small,
        }}
      >
        {meta.map((item, i) => (
          // A separator BETWEEN items rather than after each: the priority pill is a bordered
          // control, and a trailing interpunct beside it reads as a broken sentence.
          <span
            key={item.key}
            style={{
              ...rowStyle,
              gap: 8,
              // A SEPARATOR MUST NEVER WRAP AWAY FROM THE ITEM IT INTRODUCES. Inheriting
              // `rowStyle`'s wrap let the `·` break onto its own line while its item went to the
              // next — a stray interpunct floating alone, visible in the capture.
              flexWrap: "nowrap",
              // ONE ITEM TAKES THE SLACK — the progress rule. Everything else keeps its intrinsic
              // width, which is what makes the merged line read as named fields followed by a bar
              // rather than as a row of things fighting for space. `minWidth: 0` is what lets the
              // bar actually shrink in the narrowest column the app has.
              //
              // ══ EVERY FIXED LABEL MUST BE `0 0 auto` AND `nowrap` ══════════════════════════
              // A flex item's DEFAULT is `0 1 auto` — it shrinks. Under the `nowrap` row above that
              // squeezed each label below its own text width and the words broke mid-letter:
              // "Backl/og", "e/pi/c", the status dot on a line of its own. Measured in the
              // `concierge-bead-card` capture, and it is strictly worse than the wrap it replaced.
              // The named fields are short and already minimal; the stage bar is the one thing with
              // slack to give, which is precisely the founder's "not the full width of the card".
              //
              // ══ …BUT THE TWO CONTENT-LENGTH ITEMS MUST GIVE GROUND ═════════════════════════
              // The parent-epic chip and `in <project>` are as long as what they say, and a
              // `0 0 auto` wrapper is always exactly as wide as its own text — which is why the
              // chip's `text-overflow: ellipsis` could never fire and a long epic title clipped at
              // the card's edge instead. `0 1 auto` + `minWidth: 0` is what gives the ellipsis
              // something to work with; `nowrap` is what keeps it on this line. See `MetaItem`.
              ...(item.grow === true
                ? { flex: "1 1 96px", minWidth: 0 }
                : item.shrink === true
                  ? { flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap" as const }
                  : { flex: "0 0 auto", whiteSpace: "nowrap" as const }),
            }}
          >
            {/* NO SEPARATOR BEFORE THE GROWING ITEM. The stage is a BAR, not a word, so an
                interpunct introducing it buys nothing even at full width — and at the concierge's
                narrow default the bar is squeezed to a sliver, leaving the "·" dangling at the end
                of the line with nothing visibly after it. Measured in the capture. */}
            {i > 0 && item.grow !== true && (
              <span aria-hidden style={{ opacity: 0.6 }}>
                ·
              </span>
            )}
            {item.node}
          </span>
        ))}
      </span>

      {/* ── THE STATUS LINE IS NOW *ON* THE META LINE ABOVE ───────────────────────────────────
          It used to be a full-bleed row of its own directly here. The founder merged the two:
          *"we have backlog, p two, task — and then we have the row that says planned. I think we
          can all make that one line."* It is still the answer to "how far along is this?", still on
          every surface that draws a bead, and still switched off by name on one — `showStageLine`
          gates the meta item exactly as it gated this row. What changed is a row of height. */}

      {/* ── DESCRIPTION — THE ONLY THING THAT SCROLLS, AND ONLY WHEN EXPANDED ────────────────── */}
      {expanded && bead.description !== "" && (
        <span
          data-testid={`${t}-description`}
          style={block({
            ...(descMaxHeight === undefined
              ? {}
              : { maxHeight: descMaxHeight, overflowY: "auto" as const }),
            color: C.cream,
            fontSize: TYPE.small,
            lineHeight: 1.5,
            // A bead description is plain text with its own line breaks (`bd` stores it verbatim);
            // rendering it as markdown would re-linkify the ids inside it and nest this card in
            // itself.
            whiteSpace: "pre-wrap",
          })}
        >
          {bead.description}
        </span>
      )}

      {/* ── THE REMAINING FIELDS — EXPANDED ONLY ──────────────────────────────────────────────
          THE `Epic` FIELD IS GONE FROM HERE ON PURPOSE. It printed `bead.parent` as a raw mono id
          on a row of its own; the parent is now a chip on the merged line, reading the epic's
          TITLE. ONE parent treatment, not two — and one fewer row. The `${t}-parent` testid moved
          with it, so every caller that addressed the field still addresses the chip. */}
      {expanded && bead.labels.length > 0 && (
        <Field label="Labels">
          <span data-testid={`${t}-labels`}>{bead.labels.join(", ")}</span>
        </Field>
      )}
      {expanded && workers.length > 0 && (
        <Field label="Workers">
          <span data-testid={`${t}-workers`} style={{ color: C.tealInk }}>
            <FiUsers size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} aria-hidden />
            {workers.join(", ")}
          </span>
        </Field>
      )}

      {/* ── OPEN ─────────────────────────────────────────────────────────────────────────────────
          THE TWO PLACES AN EPIC CAN BE OPENED, as one group.

          ══ WHY IT SITS HERE, DIRECTLY ABOVE BUILD ═════════════════════════════════════════════
          The founder read this off the card himself: *"instead of Build It, because it's already
          building… it could say something like Open."* `useBeadBuildActions` returns
          `buildIt: startable ? … : null`, and that null is documented as "a RENDER instruction as
          much as a capability one" — so a card for an epic that is ALREADY RUNNING has an empty
          slot exactly here, where its primary action used to be. This group fills that slot with
          the thing he actually wants at that moment: not a way to start the work again, but a way
          to go and watch it.

          ══ IT IS NOT GATED ON `startable`, AND THAT IS DELIBERATE ═════════════════════════════
          *"for an epic, no matter what state it's in, it could say something like open."* An epic
          that has not started, one mid-flight and one finished are all worth opening — the column
          and the board are views, not actions, and nothing about them can fail on a closed bead.
          So this appears whenever the caller says both destinations are real, and it can sit
          BESIDE Build It on an epic that has not started yet. That is the founder's reading; the
          two controls answer different questions ("start it" vs "show me it") and never compete.

          ══ LINKS, NOT BUTTONS — THE ONE PLACE THIS CARD DRAWS THEM ════════════════════════════
          `onViewOnBoard` above is deliberately a BUTTON because it performs an action, and the
          note there is right. These are the exception the founder named twice — *"maybe they're
          just two clickable links"* — and the distinction survives scrutiny: that button is one
          control doing one thing, while this is a choice BETWEEN destinations, which is what a
          run of links reads as. They are still real `<button>`s underneath, because they move the
          app rather than following an href, and a fake `<a>` here would lie to a screen reader
          about what pressing it does. */}
      {/* GATED ON `onOpenInColumn` ALONE. "Only a board" is not this group's case — it is the
          standalone button above, unchanged since before this existed — so the group appears
          exactly when the column destination is real, and decides internally whether it is drawing
          one link or two. */}
      {onOpenInColumn !== undefined && (
        <span style={rowStyle} data-testid={`${t}-open-links`}>
          <span style={{ color: C.muted, fontSize: TYPE.small, lineHeight: 1.4 }}>Open</span>
          <button
            type="button"
            data-testid={`${t}-open-in-column`}
            // STOPS THE BUBBLE, like every other control on this card. The root is the
            // expand/collapse target, so without this the press navigates AND folds the card in one
            // gesture — measured: the second press in `BeadPill.openEpic.test.tsx`'s idempotence row
            // found no link at all, because the first had collapsed the card out from under it.
            onClick={(e) => {
              e.stopPropagation();
              onOpenInColumn();
            }}
            // ══ `aria-label`, NOT `title` — A NATIVE TOOLTIP HERE WOULD BE DEAD CODE ══════════
            // `disableNativeTooltips()` strips every `title` app-wide on the first `mouseover`,
            // and it only rescues the text into `aria-label` for a control that has NO other
            // accessible name. These links have visible text, so a `title` on them is dropped
            // outright: no tooltip, and nothing moved to the AX tree. (The `title`s on this card's
            // older buttons are inert for the same reason — pre-existing, and not this change's to
            // fix.) `HeaderLink` already solved it the way this copies: compose the accessible
            // name as `<label> — <description>`.
            //
            // It is worth the words because "in column" is the ambiguous half of the pair. The
            // build column is off-screen-right of the concierge at most widths, so the label alone
            // names neither the column nor what will change about it.
            // "this card" rather than "this epic": the link is offered for a TASK too, where it
            // narrows one rung further — to just the agents on that task. Naming the rung here
            // would mean this component deciding what a bead IS, which is the one question it must
            // never answer for itself (`epic-membership-guard.sh`), and the sentence is true of
            // both either way.
            aria-label="in column — narrow the Build column to the agents working this card"
            style={openLinkStyle}
          >
            in column
          </button>
          {/* THE SEPARATOR IS NOT A LINK and must never be read as one. `aria-hidden` keeps it
              out of the accessibility tree entirely, so the two controls read as two controls. */}
          {onViewOnBoard !== undefined && (
            <span aria-hidden style={{ color: C.hairline, fontSize: TYPE.small }}>
              ·
            </span>
          )}
          {/* ONE LINK WHEN ONLY ONE DESTINATION IS MEANINGFUL, TWO WHEN BOTH ARE. A surface that
              can narrow the column but has no board to open (none today, but the props allow it)
              shows "in column" alone rather than a dead second link — which is the same
              callback-is-the-switch rule every other affordance on this card follows. */}
          {onViewOnBoard !== undefined && (
            <button
              type="button"
              data-testid={`${t}-open-on-board`}
              // Same reason as its sibling above — see that note.
              onClick={(e) => {
                e.stopPropagation();
                onViewOnBoard();
              }}
              // Composed like its sibling above — see that note for why `title` cannot work here.
              aria-label="on board — open the Plan board focused on this card"
              style={openLinkStyle}
            >
              on board
            </button>
          )}
        </span>
      )}

      {/* ── THE PRD BATCH — THE SECONDARY BUILD, EXPANDED ONLY ────────────────────────────────
          `Build It` is NOT here any more: it is the first item on the merged line, top-left, and it
          survives the collapse. This one does not, and the asymmetry is the point — *"if it's long,
          and we're doing a click to expand, that's a lot"* is an argument about the PRIMARY action
          being unreachable, and a batch button that names a count only makes sense beside the rest
          of the card that explains the count. */}
      {expanded && buildAllPrd !== undefined && (
        <span style={rowStyle}>
          {
            <button
              type="button"
              data-testid={`${t}-build-all-prd`}
              onClick={(e) => {
                e.stopPropagation();
                void runBuild(buildAllPrd);
              }}
              disabled={buildBusy}
              title={`Claim and build all ${prdEpicCount} epics that share this PRD`}
              style={{
                background: "transparent",
                color: C.tealInk,
                border: `1px solid ${C.teal}`,
                borderRadius: RADIUS.modal,
                padding: "5px 14px",
                fontSize: TYPE.small,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: buildBusy ? "default" : "pointer",
                opacity: buildBusy ? 0.7 : 1,
                fontFamily: FONT_UI,
              }}
            >
              {`Build all ${prdEpicCount} epics in this PRD`}
            </button>
          }
        </span>
      )}

      {/* ── LINEAGE: `Tasks:` AND `Build agents:` ────────────────────────────────────────────────
          ABOVE THE COMMENTS, which the founder restated so it would not be lost. The SAME two rows
          collapsed and expanded — expanding adds the rest of the card, never more lineage — so this
          deliberately does not consult `collapsed`. Empty rows draw nothing at all, which is what
          keeps a leaf card free of the height this whole change is reclaiming. */}
      {lineage !== undefined && (
        <BeadLineageRows
          testId={t}
          tasks={lineage.tasks}
          buildAgents={lineage.buildAgents}
          onExpand={collapsed ? onToggleCollapsed : undefined}
          onOpenBead={onOpenBead}
          onOpenAgent={onOpenAgent}
        />
      )}

      {/* ── COMMENT THREAD + COMPOSE ─────────────────────────────────────────────────────────────
          The point of the whole feature: humans (and agents) comment on a bead instead of filing a
          near-duplicate. Rendered only when the caller wired EITHER a thread to show or a way to
          write — a bare read-only surface (a test fixture, a board with no project path) omits it.
          Comments are read lazily by the caller on open; nothing here fetches on the 5s poll. */}
      {expanded && (comments !== undefined || onComment !== undefined) && (
        // WRAPPED TO SWALLOW THE CLICK. The composer is a textarea and a submit button; clicking
        // into a half-typed comment must not collapse the card and throw the draft away.
        <span style={SWALLOW_BOX} onClick={swallow}>
          <CommentThread
            testId={`${t}-comments`}
            comments={comments}
            onComment={onComment}
          />
        </span>
      )}

      {/* THE ERROR SITS BESIDE THE CONTROLS, not in a toast — this app has no toast system, and the
          universal pattern is a local `err` next to the thing that failed. */}
      {err !== "" && (
        <span
          data-testid={`${t}-error`}
          role="alert"
          style={block({ color: C.dangerInk, fontSize: TYPE.small })}
        >
          {err}
        </span>
      )}
      {notice !== undefined && (
        <span
          key={noticeKey}
          data-testid={`${t}-notice`}
          style={block({ color: C.conciergeMuted, fontSize: TYPE.small })}
        >
          {notice}
        </span>
      )}
    </span>
  );
}
