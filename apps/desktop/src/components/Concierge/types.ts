// The Concierge column's public contract (bead sparkle-9z3y / CM-U1). This component is
// PURELY presentational: it renders a view-model and reports every user gesture through the
// controller callbacks. The integration unit (U7, sparkle-qd80) owns building the view-model
// from real app state and giving the callbacks effects — nothing in this directory reads a
// store, fetches data, or writes to a PTY.

import type { ReactNode } from "react";
import type { StatusBand } from "../../engine/buildSections";
// A TYPE ONLY, from the pure module that owns the digest rule (no stores, no Tauri) — so the two
// halves of a digest line, the rule that builds it and the shape that renders it, cannot disagree
// about what variants exist.
import type { DigestVariant } from "../../services/conciergeDigest";
// The attachment RECORD is the one the removed AgentPane composer used (components/composer/
// attachments.ts) — a pure, React-free, Tauri-free model, so importing it here does not break this
// directory's "presentational only" rule, and it keeps the concierge off a parallel model.
import type { Attachment } from "../composer/attachments";

// The column speaks the app's ONE status vocabulary — "Needs you" / "Running" / "Done" — rather
// than a private P0/P1 scale. Re-exported so consumers of this module's public surface don't have
// to reach into the engine for the type of a field they're already handed.
export type { StatusBand };

/** One clickable action button on a nudge card ("Show me", "Auto-fix", "Park it", …). */
export interface ConciergeNudgeAction {
  id: string;
  label: string;
  /** Visual weight, per the prototype: primary = gold-tinted, ghost = muted; default = plain. */
  kind?: "primary" | "ghost";
}

/** A cross-project alert card in the thread. The WHOLE card is clickable (→ onNudgeClick,
 *  "open the source project/agent"); its action buttons fire onNudgeAction and never bubble
 *  into the card click. */
export interface ConciergeNudge {
  id: string;
  kind: "nudge";
  /** The source agent's band. Every nudge surfaced today is `needs_you` (that IS the surfacing
   *  gate); the field is carried rather than assumed so the card labels itself from data. */
  band: StatusBand;
  /** The project chip ("drodio-website") — how a cross-project alert names its origin. */
  projectName: string;
  /** The agent the alert came from ("OG Image Pipeline"). */
  agentName: string;
  /** What Sparkle says about it, with the recommendation. */
  text: string;
  actions: ConciergeNudgeAction[];
}

/** Right-aligned user bubble. No "You" label — alignment + bubble chrome carry authorship.
 *  Carries the routing receipt (where this message went) once the host has routed it. */
export interface ConciergeUserMessage {
  id: string;
  kind: "you";
  text: string;
  receipt?: ConciergeReceipt;
}

/** Left-aligned plain Sparkle reply. No "Sparkle" label, no glow — just warm text. */
export interface ConciergeSparkleMessage {
  id: string;
  kind: "sparkle";
  text: string;
  /** A BRAIN REPLY, i.e. something worth reading aloud — only these get a speaker button.
   *  The host posts plenty of other `sparkle` lines that are bookkeeping, not speech ("Sent to
   *  CI Hardening.", "…terminal has closed — that didn't send.", the deferred-outcome
   *  reconciliations): offering to read those aloud, and letting `speakingMessageId` point at
   *  one, is not what "exactly one REPLY reads as active" meant (roborev 48172).
   *
   *  REQUIRED, not optional (roborev 52363): defaulting to "not a reply" would let a future
   *  brain-reply producer forget the flag and silently lose the speaker button — a missing
   *  affordance, the hardest kind of regression to notice. Every construction site must decide. */
  speakable: boolean;
}

/** A thin centered divider line ("All projects calm · nothing needs you"). */
export interface ConciergeBatchMessage {
  id: string;
  kind: "batch";
  text: string;
}

/** A collapsed "3 Need you in drodio-website" line — the digest that replaces a stack of cards when
 *  more than one agent of a band is surfaced for a project (bead sparkle-4562.4). Clicking it hands
 *  off to column two (opens that project's tab) rather than duplicating it here. */
export interface ConciergeDigestMessage {
  id: string;
  kind: "digest";
  /** The band the collapsed agents share — the same vocabulary a nudge card carries, so a digest
   *  line and the cards it stands in for read as one urgency rather than two. */
  band: StatusBand;
  /** What this line's number is a promise about, and therefore what its click may do.
   *
   *  REQUIRED, not defaulted: a "rows" line's count is a promise that the click leaves exactly that
   *  many rows standing, and a producer that forgot the flag would make that promise on behalf of
   *  agents that have no rows at all — the empty-column bug the digest's whole invariant is about.
   *  Every construction site must decide. */
  variant: DigestVariant;
  text: string;
  /** The agent to reveal when the line is clicked. */
  leadAgentId: string;
}

/** The return-from-Away briefing. Its shape lives with the DIFF that builds it
 *  (services/conciergeRecap) rather than here, for the same reason `Attachment` does: it is a pure,
 *  React-free model, and a second declaration of it is exactly how the card and the diff would
 *  drift. Re-exported so consumers of this module's public surface get it from one place. */
export type { ConciergeRecapMessage } from "../../services/conciergeRecap";
import type { ConciergeRecapMessage } from "../../services/conciergeRecap";

export type ConciergeMessage =
  | ConciergeUserMessage
  | ConciergeSparkleMessage
  | ConciergeBatchMessage
  | ConciergeDigestMessage
  | ConciergeRecapMessage
  | ConciergeNudge;

export type ConciergeAttachKind = "screenshot" | "image" | "files";

/** Re-exported so consumers of the column's contract get the attachment shape from one place. */
export type { Attachment };

/** Where a send went. The concierge box is the app's ONLY composer (CM-U7), so it serves both jobs
 *  the user has: talking to Sparkle itself ("sparkle" — the headless brain) and sending a prompt
 *  straight into a build agent's terminal ("agent" — what the removed AgentPane composer did).
 *
 *  This used to be a target the user PICKED before sending, via a toggle on the compose box. That
 *  call was reversed on 2026-07-26: it is now a destination the host INFERS per message
 *  (services/conciergeRouter) and then REPORTS via ConciergeReceipt — so the type describes an
 *  outcome, not a setting. What makes the inference safe is not better guessing; it is that every
 *  send carries a visible receipt naming where it went, with a one-tap redirect. */
export type ConciergeSendTarget = "sparkle" | "agent";

/** The receipt line under a user bubble: where that message actually went, and the one-tap offer
 *  to also send it the other way.
 *
 *  `redirectable` is what keeps inference honest — a misroute the user can see and fix in a click
 *  is recoverable; a silent one is not. Only the LATEST receipt sets it, because redirecting a
 *  message from ten turns ago is never what the user means.
 *
 *  A redirect RE-SENDS; it never retracts. Text already delivered into a PTY cannot be pulled
 *  back, so `alsoSentTo` records that the message went to both places and the rendered wording
 *  must never imply the first delivery was undone. */
export interface ConciergeReceipt {
  /** Where the router sent it. */
  target: ConciergeSendTarget;
  /** The agent it reached (or would reach on redirect); absent when there is no build agent. */
  agentName?: string;
  /** The id behind `agentName`. Carried so a redirect can deliver to the agent the BUTTON NAMED,
   *  not to whatever happens to be selected when the user gets around to clicking — the selection
   *  moves for reasons unrelated to this thread, and the label is an explicit promise. */
  agentId?: string;
  /** Set once the user has redirected: the message ALSO went here, after the original target. */
  alsoSentTo?: ConciergeSendTarget;
  /** Whether to offer the one-tap redirect (latest receipt only). */
  redirectable?: boolean;
}

/** Everything the column renders, supplied by the integration layer. */
export interface ConciergeViewModel {
  /** Pinned → "Pinned to <name>" in gold; absent → "Following all projects". */
  scope: { pinnedProjectName?: string };
  /** In-scope per-band counts. Nothing needing you and nothing running renders "all calm" —
   *  see ScopeVitals.vitalsParts for why `done` is not a vital sign. */
  vitals: Record<StatusBand, number>;
  /** The thread, oldest first. Nudges are messages of kind "nudge". */
  messages: ConciergeMessage[];
  /** True while Sparkle is composing a reply — renders the typing indicator row. */
  typing?: boolean;
  /** Files riding along with the NEXT send (parity row #21), rendered as removable chips above the
   *  compose row. The integration layer owns the list; the box only reports removals. */
  attachments?: Attachment[];
  /** True while a native file drag is over the compose box — lights the drop affordance. The
   *  webview drag event is window-global, so only the integration layer can hit-test it. */
  dropActive?: boolean;
}

/** Every gesture the column can emit. The integration layer supplies all of these. */
export interface ConciergeController {
  /** The user submitted trimmed non-empty text (Send button or ⌘/Ctrl+Enter). The integration
   *  layer decides where it goes (services/conciergeRouter) — the column never decides, and no
   *  longer carries an affordance for the user to decide either.
   *
   *  May return a promise resolving FALSE when the send did not land; the compose box then puts
   *  the draft back rather than making the user retype it. Returning nothing means "assume it
   *  landed" (the chat path, which can't fail visibly). */
  onSend(text: string): void | Promise<boolean>;
  /** The user tapped the redirect on a routing receipt: send that same message the OTHER way.
   *  Additive — the original delivery stands (see ConciergeReceipt). */
  onRedirect?(messageId: string): void;
  onAttach(kind: ConciergeAttachKind): void;
  /** Drop one staged attachment by id. Optional: a column mounted without attachments has none. */
  onRemoveAttachment?(id: string): void;
  /** A digest line was clicked — open that project's tab and reveal its lead agent. This is the
   *  handoff to column two that the digest exists to make (bead sparkle-4562.4). */
  onDigestClick?(digest: ConciergeDigestMessage): void;
  /** Toggle the mic. The box owns no mic state — `micLive` comes down as a prop (CM-U9). */
  onMicToggle(): void;
  /** Whole-card click: open the nudge's source project/agent. */
  onNudgeClick(nudge: ConciergeNudge): void;
  /** An action button on the card; never accompanied by onNudgeClick. */
  onNudgeAction(nudge: ConciergeNudge, actionId: string): void;
  /** The speaker button on a Sparkle reply: speak it now, or stop if it is the one playing.
   *  Optional — omit it and no reply renders a speaker at all (voice is an opt-in surface). */
  onSpeak?(message: ConciergeSparkleMessage): void;
}

export interface ConciergeColumnProps {
  model: ConciergeViewModel;
  controller: ConciergeController;
  /** Mic armed/live — tints the mic button. */
  micLive?: boolean;
  /** Column width in px (the shell is fixed-width; the workspace owns resizing). */
  width?: number;
  /** Optional affordance rendered under the scope/vitals line — the shell drops the ⌘K palette
   *  trigger here (PRD §4: history search lives in the concierge). */
  searchSlot?: ReactNode;
  /** Live, uncommitted dictation transcript for the compose box; "" when nothing is being said. */
  interim?: string;
  /** Handed straight to the compose box so the integration layer can receive committed segments.
   *  Must be referentially stable. */
  registerInsert?: (append: ((text: string) => void) | null) => void;
  /** The id of the reply currently being spoken, so exactly one speaker button reads as active. */
  speakingMessageId?: string | null;
  /** The user typed or deleted in the compose box (not a dictated segment, not the send clear). */
  onTextEdit?: (text: string) => void;
  /** The last FINISHED line for the thread's hidden live region — a completed reply, a status
   *  notice, or a ROUTING RECEIPT ("→ Sent to Kraken Auth"). Never a streaming chunk: the region
   *  would then re-announce on every delta.
   *
   *  Routing has to reach this node. With the send-target toggle gone the receipt is the only
   *  signal of where a message went, so a receipt that is rendered but not announced leaves a
   *  screen-reader user with no routing information at all — and routing is STICKY, so consecutive
   *  identical receipts are the common case rather than a corner one. That is exactly what `seq`
   *  below is for. */
  announcement?: ConciergeAnnouncement;
  /** Armed sends counting down before they reach an agent's terminal
   *  (components/Concierge/CountdownBanner), rendered between the suggestion row and the compose
   *  box. A slot, not view-model data, because the banner subscribes to the module-level intent
   *  registry (services/dispatchIntent) and this column renders nothing it isn't handed.
   *
   *  It must NOT contain a live region: the countdown is announced through `announcement` above,
   *  and a second `aria-live` node would make a screen reader read every send twice. */
  countdownSlot?: ReactNode;
}

/** One write to the column's live region. `seq` is a monotonic WRITE COUNTER, not data — it exists
 *  so an IDENTICAL repeat is still a distinct write (roborev 53392). An `aria-live` region only
 *  speaks when its content CHANGES, so passing the text alone made two consecutive identical lines
 *  ("Sent to CI Hardening." on each of two sends to the same pinned agent) announce exactly once:
 *  React bails out of an `Object.is`-equal setState, and even re-rendered the text node is
 *  unchanged. The column keys the rendered node on `seq`, which turns every write into a real DOM
 *  mutation for the assistive technology to notice. */
export interface ConciergeAnnouncement {
  seq: number;
  text: string;
}
