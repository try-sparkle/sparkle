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
// …and the collapsed-text block for the same reason: `TextBlock` is the one declaration of "a long
// block of text, carried whole, shown as a pill" (see components/composer/attachments), and a second
// one here is how a transcript pill and a composer pill would drift about what a block is.
import type { Attachment, TextBlock } from "../composer/attachments";
// TYPE-ONLY, and that is the whole reason it is allowed. The rule this module's header states is
// that nothing under components/Concierge may TOUCH a store; a type import is erased at compile time
// and creates no subscription, no import cycle and no runtime dependency. Naming the store's own
// shape here is what stops the column and the store drifting into two definitions of one thing.
import type { MountedThread } from "../../stores/mountedThreadStore";
// The header line's per-project shape lives with the component that DERIVES it (ScopeVitals owns
// the pure text rules the founder's strings are pinned against), and is re-exported here so the
// column's contract still hands consumers one place to import from.
import type { ProjectNeedsYou } from "./ScopeVitals";
// The @-mention shapes live with the pure module that owns the matching rules (./mentions — no
// React, no stores), for the same reason `Attachment` lives with the composer's model: one
// declaration, so the composer that produces a mention and the bubble that draws it cannot drift
// about what one is.
import type { ConciergeMention, MentionAgent } from "./mentions";
// The rail's view-model lives with the component that RENDERS it, for the same reason `Attachment`
// lives with the composer's model and the mention shapes live with ./mentions: one declaration, so
// the host that builds a rail state and the strip that draws it cannot drift about what one is.
import type { SendTrayModel } from "./SendModeTray";
import type { SendMode } from "../../voice/sendMode";

export type { ProjectNeedsYou };
export type { ConciergeMention, MentionAgent };
export type { SendTrayModel };

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
  /** What rode along with THIS message — a SNAPSHOT taken at send time, not a live list.
   *
   *  The staged attachments live on the view model (`ConciergeViewModel.attachments`) and are
   *  consumed by the send, so without a copy on the message record the thread has nothing left to
   *  draw and the user never sees what they sent (PRD §8). `text` already carries a compact count
   *  ("look · 1 image"); this is what turns that count into the actual picture.
   *
   *  The same `Attachment` record the composer stages — reused, not re-declared, so a bubble and
   *  the chip it was staged as cannot disagree about what a file is. `dataUrl` is what a thumbnail
   *  draws from; it is deliberately STRIPPED before the thread is persisted (see
   *  stores/conciergeThreadStore), so a restored message renders its files as chips rather than
   *  blowing the localStorage quota with base64. */
  attachments?: Attachment[];
  /** The agents this message ADDRESSED by name (`@Blueprint UI/UX …`), so the bubble can draw them
   *  as pills instead of raw text.
   *
   *  A SNAPSHOT, like `attachments` above, and for a sharper reason than convenience: a sent message
   *  is history. Resolving the pills against the live roster at render time would make a mention
   *  decay into plain `@text` the moment its agent was closed — silently rewriting what the user is
   *  scrolling back through. The record travels with the message so the thread always shows who was
   *  addressed, whether or not they still exist.
   *
   *  `undefined` rather than `[]` on an unaddressed message, matching `attachments`: this thread is
   *  persisted, and an empty array per message buys nothing the absent field doesn't. */
  mentions?: ConciergeMention[];
}

/** Left-aligned plain Sparkle reply. No "Sparkle" label, no glow — just warm text. */
export interface ConciergeSparkleMessage {
  id: string;
  kind: "sparkle";
  text: string;
  /** True when the brain authored this WITHOUT a user message behind it — the proactive push
   *  channel (services/conciergeProactive). An ordinary reply leaves it unset. */
  proactive?: boolean;
  /** The SURFACED-state digest this message was authored against (`surfacedDigest` — the ids and
   *  statuses of the agents it actually names, not every in-scope agent). Only a
   *  push carries one, and it is what makes {@link stale} decidable: a thread entry is append-only,
   *  so without it "You have 3 P1s" keeps asserting a resolved count forever (PRD §2a, Staleness). */
  digest?: string;
  /** True once {@link digest} no longer matches the live state. The thread renders it visibly
   *  superseded — a push that is no longer true must LOOK no longer true, not silently lie. */
  stale?: boolean;
  /**
   * A long payload this line is ABOUT, carried whole and drawn as a collapsed pill under it.
   *
   * WHAT IT IS. Today's producer is the deferred-send reconciliation (`ConciergeHost`'s
   * `onDeferredSendOutcome`): "CI Hardening is up — I sent your message" is the receipt, and the
   * relayed brief is the payload. The thread draws the payload as a `TextPill` (variant `inline`)
   * with the full text one click away, so a 40-row brief costs one row of the column.
   *
   * WHY IT IS A SEPARATE FIELD AND NOT MORE `text`. Because those are two different things, and
   * conflating them IS the bug this field exists to fix. `text` is the RECEIPT SENTENCE — one line
   * of bookkeeping, rendered as markdown, read out by the live region, capped and persisted as
   * conversation. The payload is a verbatim blob of the user's own words that must be reproducible
   * byte for byte and must NOT be spoken or laid out as prose. Interpolating it into `text` is what
   * pushed the whole conversation off screen (the founder's screenshot) and handed a screen reader
   * forty rows to read; and it made the standing rule — the concierge must never paste relayed text
   * back at the user — unenforceable, because the APP was doing the pasting regardless of how the
   * concierge behaved. Kept apart, the sentence stays a sentence and the payload stays a record.
   *
   * `undefined` on an ordinary line, matching `ConciergeUserMessage.attachments`: this thread is
   * persisted, and an empty field per message buys nothing the absent one doesn't.
   */
  collapsed?: TextBlock;
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

/** A turn that failed, said in the user's terms with the machine's own words attached.
 *
 *  ITS OWN KIND, rather than the plain `sparkle` bubble failures used to borrow, for two reasons.
 *  The evidence must render VERBATIM — a quota line goes through `<Markdown>` in a sparkle bubble,
 *  where `_` and `*` in a stderr dump are formatting instructions. And a failure must NOT be
 *  persisted: `conciergeThreadStore.PERSISTED_KINDS` is an allow-list, so a kind that is not on it
 *  is dropped at save time, and "You've hit your session limit · resets 8:40am" restored from
 *  localStorage tomorrow morning is a lie the app would be telling on its own initiative. */
export interface ConciergeFailureMessage {
  id: string;
  kind: "failure";
  /** Our sentence: what went wrong and what to do. From engine/conciergeFailureNotice. */
  headline: string;
  /** The concierge's own words, unedited. Rendered as plain text, never as markdown. */
  evidence: string;
}

export type ConciergeMessage =
  | ConciergeUserMessage
  | ConciergeSparkleMessage
  | ConciergeFailureMessage
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
  /**
   * This message reached the brain, and the brain never answered it: the turn was still running with
   * nothing emitted when the user's NEXT message displaced it (`concierge.rs` kills the old child
   * and its reader goes silent — no event, no log, nothing).
   *
   * WHY THIS FIELD EXISTS. On 2026-07-29, 149 of 378 turns (39.4%) died this way, and 12 of the 14
   * turns in the 20:18-20:31 burst. Every one of those questions is still sitting in the thread
   * looking asked-and-answered-by-silence, which is the single most misleading thing this column
   * can render: the user cannot tell a question nobody answered from one they simply scrolled past.
   *
   * NOT a health claim. A displaced turn says nothing about whether the concierge is well — the
   * user's own next message is what killed it — so this never feeds the liveness detector
   * (engine/conciergeLiveness). It is a fact about ONE message, stated on that message.
   */
  unanswered?: true;
}

/** Everything the column renders, supplied by the integration layer. */
export interface ConciergeViewModel {
  /** Pinned → "Pinned to <name>" in gold; absent → "All projects". Hand it the FULL folder name:
   *  the header spends its own width budget on it (ScopeVitals `shortProjectName`) and keeps the
   *  whole thing on hover, so truncating here would only lose the recoverable half. */
  scope: { pinnedProjectName?: string };
  /** In-scope per-band counts. The header states only `needs_you` (nothing → "all calm") — see
   *  ScopeVitals' header for why `running` and `done` are carried but not printed. */
  vitals: Record<StatusBand, number>;
  /** The per-project split of `vitals.needs_you`, worst project first once rendered. Column one is
   *  the GLOBAL index (PRD §2a, answered 2026-07-28), so its one line reads across projects while
   *  column two stays scoped to the selected one. Absent → the line states the undivided total. */
  needsYouByProject?: ProjectNeedsYou[];
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
  /** Set when an attach attempt lost files — rendered above the chips until the user dismisses it
   *  or a later attempt succeeds. The affordance above promises the drop will land, so the one
   *  case it doesn't has to be stated rather than left for the user to spot (bead sparkle-zviq). */
  attachNotice?: string | null;
  /** Whether the GLOBAL needs-you filter is currently on. It is state the shell owns (it focuses
   *  every open column at once), reflected here so the header pill can paint it; the column never
   *  filters anything itself. */
  needsYouFilter?: boolean;
}

/** WHICH copy affordance fired (PRD 1). The two are deliberately different operations — a selection
 *  copies the RENDERED words, an answer copies its MARKDOWN SOURCE — so the confirmation says which
 *  one happened rather than one vague "Copied". */
export type ConciergeCopyKind = "selection" | "answer";
/** Which side of the shell holds the live cable, or `off` for none.
 *
 *  ONE VALUE, and every visual consequence follows from it — the flood, the dropped lift, the
 *  composer going transparent, the user bubble's fill. MAPPING.md is explicit that this must NOT be
 *  implemented as scattered component state, and this type is how that survives contact with a
 *  React tree: the column takes the value and derives, rather than each piece deciding for itself.
 *
 *  The column does not choose it. `Workspace` owns the shell's layout and therefore owns which pair
 *  is patched, so this arrives as a prop and defaults to `off` — which is what lets that file and
 *  this one be worked on independently. */
export type ConciergeWired = "off" | "left" | "right";

/** THE MOUNTED AGENT'S OWN CONVERSATION, ready to render.
 *
 *  Present ⇒ the column shows THAT AGENT'S transcript instead of the Sparkle conversation. Absent or
 *  `null` ⇒ the ordinary concierge thread, unchanged.
 *
 *  ARRIVES FULLY RESOLVED, as a value, because nothing under `components/Concierge` touches a store
 *  (see this module's header). Reading the transcript means a store subscription, a Tauri command and
 *  a poll timer, so all of that lives in the integration layer and only the RESULT crosses this
 *  boundary — the same division the rest of `ConciergeViewModel` already follows. */
export interface ConciergeMountedAgent {
  agentId: string;
  /** Display name, for the empty state and the thread's accessible label. */
  name: string;
  /** The loaded slice of transcript plus its load/paging flags. Typed from the store's own shape so
   *  the two cannot drift; the column still never imports the store itself. */
  thread: MountedThread;
  /** The reader scrolled near the top and wants older turns. */
  onReachTop: () => void;
}

/** Every gesture the column can emit. The integration layer supplies all of these. */
export interface ConciergeController {
  /** The user submitted trimmed non-empty text (Send button or ⌘/Ctrl+Enter). The integration
   *  layer decides where it goes (services/conciergeRouter) — the column never decides, and no
   *  longer carries an affordance for the user to decide either.
   *
   *  `mentions` is the EXPLICIT half of that decision, and the only thing that overrules the
   *  router: the agents the text addresses by name. Absent when it addresses none — which is every
   *  send this column has made until now, so nothing already implementing this callback changes.
   *
   *  May return a promise resolving FALSE when the send did not land; the compose box then puts
   *  the draft back rather than making the user retype it. Returning nothing means "assume it
   *  landed" (the chat path, which can't fail visibly). */
  onSend(text: string, mentions?: ConciergeMention[]): void | Promise<boolean>;
  /** The user tapped the redirect on a routing receipt: send that same message the OTHER way.
   *  Additive — the original delivery stands (see ConciergeReceipt). */
  onRedirect?(messageId: string): void;
  onAttach(kind: ConciergeAttachKind): void;
  /** Drop one staged attachment by id. Optional: a column mounted without attachments has none. */
  onRemoveAttachment?(id: string): void;
  /** The user acknowledged the attach-failure notice. */
  onDismissAttachNotice?(): void;
  /** A digest line was clicked — open that project's tab and reveal its lead agent. This is the
   *  handoff to column two that the digest exists to make (bead sparkle-4562.4). */
  onDigestClick?(digest: ConciergeDigestMessage): void;
  /** A header segment naming ANOTHER project was clicked ("1 in mobile"): switch to that project.
   *  Switch ONLY — no agent is named by a count, so nothing may be selected on its behalf. Bead
   *  `sparkle-vohh` fixed the mirror-image bug (a nudge selected an agent without switching
   *  project); this must not reintroduce its other half. */
  onProjectClick?(projectId: string): void;
  /** Something in the thread reached the clipboard: the user's own selection, or a whole answer via
   *  its copy button (PRD 1 §1/§2).
   *
   *  A CALLBACK RATHER THAN A LOCAL ANNOUNCEMENT, and that is load-bearing. This column has exactly
   *  ONE `aria-live` region (see {@link ConciergeColumnProps.announcement}); a confirmation spoken
   *  from a second one is how a screen reader ends up reading every event twice, which is what
   *  roborev 52648/53010/53088 were. The integration layer owns the region, so it owns this line
   *  too. */
  onCopied?(what: ConciergeCopyKind): void;
  /** Whole-card click: open the nudge's source project/agent. */
  onNudgeClick(nudge: ConciergeNudge): void;
  /** Reveal an agent named by a CARD that is not a nudge — today, a recap row's pill.
   *
   *  Same destination as `onNudgeClick` (both land in `revealAgent`), but keyed on an id because a
   *  recap row is not a nudge and building a synthetic one to pass here would be a lie the next
   *  reader has to unpick.
   *
   *  IT MUST ANNOUNCE, and that is why this exists rather than the pill using the pill CONTEXT's
   *  opener. A pill on the context path mounts its own `role="status"` to report the outcome, and
   *  the concierge column owns exactly ONE live region — a second one is what
   *  `ConciergeThread.roleLabels` forbids, and what the recap card's own test caught. Supplying an
   *  `onOpen` suppresses the pill's region, so whatever is supplied has to take over the reporting;
   *  `revealAgent` already does, through the column's announcer. */
  onRevealAgent?(agentId: string): void;
  /** The header's 8-dot grip was used: move the concierge to the OTHER side of the shell. Optional,
   *  and the grip renders only when it is supplied — a grip with nowhere to drag to is an
   *  affordance that lies, the same rule ScopeVitals' segment buttons already follow. */
  onMoveSide?(): void;
  /** The header's red pill was pressed: toggle the GLOBAL "show only what needs you" filter. It
   *  focuses every open column at once, which is why it is a shell gesture rather than something
   *  this column can do; `ConciergeViewModel.needsYouFilter` reflects the result back. */
  onNeedsYouFilterToggle?(): void;
  /** An action button on the card; never accompanied by onNudgeClick. */
  onNudgeAction(nudge: ConciergeNudge, actionId: string): void;
}

export interface ConciergeColumnProps {
  model: ConciergeViewModel;
  controller: ConciergeController;
  /** Column width in px (the shell is fixed-width; the workspace owns resizing). */
  width?: number;
  /** Whether releasing a text selection in the thread copies it (Settings → Concierge → "Copy on
   *  selection", PRD 1 §1). Defaults to ON.
   *
   *  HANDED IN, not read. It is a `uiStore` preference, and nothing in this directory reads a store
   *  (see this file's header). It governs the SELECTION affordance only — the per-answer copy button
   *  is an explicit click and always copies, whatever this says. */
  copyOnSelection?: boolean;
  /** Optional affordance rendered under the scope/vitals line — the shell drops the ⌘K palette
   *  trigger here (PRD §4: history search lives in the concierge). */
  searchSlot?: ReactNode;
  /** The pull-request affordance, rendered in the header immediately left of the ⋮ cluster.
   *
   *  A SLOT rather than a `prsReady` number and an `onPrClick` callback, which is what this used to
   *  be. Those were dead — nothing in the app ever passed either, so the chip could not render in
   *  production — and a count plus a click is anyway not enough to describe the job: opening the
   *  list, judging each PR's mergeability, merging from it, and jumping to the owning agent all
   *  require the fleet and the GitHub probe, neither of which this presentational directory knows
   *  about. The integration layer hands `<OpenPrMenu compact />` in through here instead.
   *
   *  Absent renders nothing at all, which is correct for any surface with no PR probe wired. */
  prSlot?: ReactNode;
  /** Live, uncommitted dictation transcript for the compose box; "" when nothing is being said. */
  interim?: string;
  /** Handed straight to the compose box so the integration layer can receive committed segments.
   *  Must be referentially stable. */
  registerInsert?: (append: ((text: string) => void) | null) => void;
  /** The user typed or deleted in the compose box (not a dictated segment, not the send clear). */
  onTextEdit?: (text: string) => void;
  /** Every builder agent the compose box's "@" picker may offer, and the roster a mention is
   *  resolved against. Handed down rather than read, like everything else here — this directory is
   *  presentational and does not know the fleet exists.
   *
   *  ORDER IS MEANINGFUL: it breaks the tie when two agents share a name (see ./mentions
   *  `findMentionSpans`), so the integration layer passes it relevance-first. */
  mentionAgents?: readonly MentionAgent[];
  /** The agent a send would reach WITHOUT a mention. Sorts to the top of the picker. */
  preferredAgentId?: string | null;
  /** Open an agent the CONCIERGE named — the click on a `sparkle-agent:` pill in a reply.
   *
   *  A callback rather than a call, for the same reason everything else here is: this directory is
   *  presentational and does not know the fleet exists, let alone how to reveal a row in it. The
   *  integration layer binds this to `services/openProjectTab`, which is the one path that opens
   *  the owning project's tab, selects it, clears the Sparkle overlay and reveals the agent — the
   *  partial re-implementations of that sequence are a documented source of "it's red somewhere but
   *  I can't find it" bugs.
   *
   *  RETURNS whether the reveal LANDED. `false` means the click changed nothing on screen — the
   *  project or the agent was gone by the time it arrived — and the pill turns that into a sentence
   *  instead of failing silently, which is the bug the return value exists for.
   *
   *  Absent means pills still RENDER (with their live name and status dot) but report a failed
   *  open when clicked, which is the honest default for a surface that has not wired the reveal
   *  path — it cannot navigate, so it must not pretend it did. */
  onOpenAgent?: (target: { agentId: string; projectId: string }) => boolean;
  /** Search the prompt history of an agent that can no longer be opened — the destination that
   *  replaces the dead end. Absent → an unresolvable pill stays plain prose rather than becoming a
   *  button with nowhere to go. */
  onSeeAgentHistory?: (target: { agentId: string; name: string }) => void;
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
  /** Concierge tool calls waiting on the human's yes or no
   *  (components/Concierge/ConciergeApprovals), rendered directly above the countdown banner.
   *
   *  A SLOT for the same reason `countdownSlot` is one: the prompt subscribes to the pending-
   *  approval ledger (stores/conciergeApprovals) and this column renders nothing it isn't handed.
   *  It sits ABOVE the countdown because the two answer different questions — "may I do this at
   *  all?" comes before "this is about to go out" — and because an unanswered approval is the one
   *  thing in the column that has stopped a tool call dead.
   *
   *  Like the countdown it must carry NO live region of its own: `announcement` above is the
   *  column's only one, and a second `aria-live` node would double-announce. */
  approvalSlot?: ReactNode;
  /** The auto-send countdown's live state (PRD §4), handed to the compose box.
   *
   *  DATA, not a slot — unlike `countdownSlot`/`approvalSlot` above. Those are slots because their
   *  contents subscribe to module-level registries; the countdown is drawn from a plain view-model
   *  the host already holds, and it has to sit INSIDE the compose box (the tray it sweeps is the
   *  box's own bottom bar), so a slot would mean handing the box a node it cannot lay out.
   *
   *  Absent → nothing counts. Like the two slots it carries NO live region: the arm and fire lines
   *  go through `announcement` above. */
  autoSend?: SendTrayModel;
  /** Where the send tray is parked (voice/sendMode). Absent → `send`. */
  sendMode?: SendMode;
  /** The user moved the tray. Absent → the tray's positions are inert. */
  onSendModeChange?: (next: SendMode) => void;
  /** A live PTY owns the keyboard, so the tray is not being addressed and goes flat grey. */
  trayInert?: boolean;
  /** The compose box's contents changed, whatever wrote them — the countdown's only view of what
   *  it would send. Distinct from `onTextEdit`, which is narrower on purpose; see ComposeBox. */
  onComposedText?: (text: string) => void;
  /** Receives the compose box's submit, so an expired countdown fires the SAME path the button
   *  does — clearing the box and resolving mentions exactly as a manual send would.
   *  Must be referentially stable.
   *
   *  The registered fn RETURNS whether a message went out: `false` when the box was empty, which is
   *  what stops the rail announcing "Sent to …" and recording a tuning sample for a no-op. */
  registerSubmit?: (submit: (() => boolean) | null) => void;
  /** Which side of the shell holds the live cable (see {@link ConciergeWired}). Defaults to `off`,
   *  which is the LIFTED state: a soft shadow, no colour change, reading as a layer above the
   *  pairs. Patched, the column drops flush and takes the terminal's colour. */
  wired?: ConciergeWired;
  /** When set, the column renders THIS AGENT'S conversation in place of the Sparkle thread.
   *
   *  Separate from `wired` on purpose. `wired` is the SIDE the cable is patched into and drives
   *  presentation (the flood, the lift, the bubble fill); this is WHICH AGENT, and drives content.
   *  A mount can be visually live for a moment before the agent's transcript is resolvable, and
   *  collapsing the two would make the pane flicker between two conversations on that seam. */
  mountedAgent?: ConciergeMountedAgent | null;
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
