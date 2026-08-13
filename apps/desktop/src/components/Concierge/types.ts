// The Concierge column's public contract (bead sparkle-9z3y / CM-U1). This component is
// PURELY presentational: it renders a view-model and reports every user gesture through the
// controller callbacks. The integration unit (U7, sparkle-qd80) owns building the view-model
// from real app state and giving the callbacks effects — nothing in this directory reads a
// store, fetches data, or writes to a PTY.

import type { ReactNode } from "react";
import type { StatusBand } from "../../engine/buildSections";
import type { ConciergeMessageStatusText } from "./MessageStatus";
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
import type {
  Attachment,
  CollapsedSend,
  TextBlock,
} from "../composer/attachments";
// TYPE-ONLY, and that is the whole reason it is allowed. The rule this module's header states is
// that nothing under components/Concierge may TOUCH a store; a type import is erased at compile time
// and creates no subscription, no import cycle and no runtime dependency. Naming the store's own
// shape here is what stops the column and the store drifting into two definitions of one thing.
import type { AgentTabStatus } from "../../types";
import type { MountedThread } from "../../stores/mountedThreadStore";
// The @-mention shapes live with the pure module that owns the matching rules (./mentions — no
// React, no stores), for the same reason `Attachment` lives with the composer's model: one
// declaration, so the composer that produces a mention and the bubble that draws it cannot drift
// about what one is.
import type { ConciergeMention, MentionAgent } from "./mentions";
// Same rule as ./mentions above: the shape lives with the pure module that owns the RULE deciding
// what an anchor is (./replyAnchors — no React, no stores), so the reply that records one and the
// stub that draws it cannot drift about what one is.
import type { ReplyAnchor } from "./replyAnchors";
import type { ComposeQuote } from "./composeQuote";
import type { PendingQuote } from "./useQuoteOnSelection";
// Same rule again: the shape lives with the pure module that owns the WORDING rule (./lintMarks —
// no React, no stores), so the host that records a finding and the line that draws it cannot drift
// about what a finding is.
import type { MessageLintMark } from "./lintMarks";
// The receipt vocabulary, borrowed rather than restated: a second copy of "which kinds exist" or
// "which channels exist" would drift from the service that mints them, and the fold rule reads both.
import type {
  ConciergeActionKind,
  ConciergeSendChannel,
} from "../../services/conciergeReceipts";
// The rail's view-model lives with the component that RENDERS it, for the same reason `Attachment`
// lives with the composer's model and the mention shapes live with ./mentions: one declaration, so
// the host that builds a rail state and the strip that draws it cannot drift about what one is.
import type { SendTrayModel } from "./SendModeTray";
import type { SendMode } from "../../voice/sendMode";
// Same rule as ./mentions and ./replyAnchors: the shape lives with the component that RENDERS it, so
// the host that builds a notice and the row that draws it cannot drift about what one is.
import type { MountedNoticeModel } from "./MountedNotice";

/** One project's share of the Needs-you total, as the column is handed it.
 *
 *  It used to live with the header component that DERIVED a text line from it (`ScopeVitals`), and
 *  moved here when that component was deleted — the header now prints nothing but the red pill
 *  (bead sparkle-ircc3). The SHAPE outlived the line: `ConciergeHost` still builds this split from
 *  `feed.projects[].scopedCounts.needs_you`, so it lives in the contract module rather than being
 *  deleted along with the one renderer that happened to read it. */
export interface ProjectNeedsYou {
  projectId: string;
  projectName: string;
  /** This project's share of `vitals.needs_you` (feed.projects[].scopedCounts.needs_you). */
  needsYou: number;
  /** True for the project whose tab is selected — the segment that read "here". */
  isActive: boolean;
}

export type { ConciergeMention, MentionAgent };
export type { ReplyAnchor };
export type { MessageLintMark };
export type { SendTrayModel };
export type { MountedNoticeModel };

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

/**
 * A red episode that is OVER — the card stays, greyed, instead of vanishing.
 *
 * WHY THE CARD DOES NOT SIMPLY DISAPPEAR (founder, 2026-08-06, bead `sparkle-9adzg`): "The blocked
 * card should go away or show as resolved and be grayed out if it's no longer blocked." Asked which,
 * he chose to KEEP it — a card that deletes itself takes the record of what happened with it, and
 * the thread is where he reads that record back. So a resolved card is history: quiet, dateable, and
 * still naming its agent.
 *
 * The two instants are carried rather than a pre-formatted string so the card can spell the duration
 * in the app's ONE elapsed vocabulary (`engine/elapsed.formatElapsed`) — the same one the Build
 * column's rows a few hundred pixels away already use — and so a test can assert the duration
 * without matching prose.
 */
export interface NudgeResolution {
  /** When this red episode was first seen — the moment the loud card went up. */
  raisedAt: number;
  /** When the agent was first seen to have left the red band. */
  resolvedAt: number;
}

/** A cross-project alert card in the thread. The WHOLE card is clickable (→ onNudgeClick,
 *  "open the source project/agent"); its action buttons fire onNudgeAction and never bubble
 *  into the card click. */
export interface ConciergeNudge {
  id: string;
  kind: "nudge";
  /**
   * Set ONLY once the agent has left the red band — absent on every live card.
   *
   * OPTIONAL AND ABSENT-BY-DEFAULT ON PURPOSE. The dangerous direction here is not a red that
   * lingers, it is a live blocker rendered quiet: Sparkle's standing rule is that nothing which
   * needs the founder may be hidden. An optional field that must be positively SET to go grey means
   * every path that forgets it fails loud, which is the safe way round.
   */
  resolved?: NudgeResolution;
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
  /**
   * The fragment of the transcript this message was replying TO — selection-to-quote's record.
   *
   * The MIRROR of {@link ConciergeSparkleMessage.answers}: that field draws quoted originals above a
   * concierge reply, this one draws the quoted original above the USER's message. Same
   * {@link ReplyAnchor} shape and the same `ReplyAnchorStubs` renderer, so the two halves of one
   * visual idiom cannot drift apart.
   *
   * A SNAPSHOT, like `attachments` and `mentions` above and for the same reason — the thread is
   * trimmed from the front and rewritten on restore, so a live lookup would blank the quote the
   * moment its source aged out, silently turning a message that says what it is about into one that
   * doesn't.
   *
   * RENDERED WITHOUT `onJump` (see ConciergeMessageRow). The founder chose attribution the brain can
   * resolve over a clickable back-reference, so this draws as the degraded text form the stub
   * already has for an anchor whose target is gone — deliberately, not by omission.
   *
   * Its `id` goes through `remapAnchors` on rehydrate alongside `answers`; see
   * stores/conciergeThreadStore.
   */
  quoting?: ReplyAnchor;
  /**
   * The long blocks this message PASTED, carried whole and drawn as pills instead of as a wall of
   * text — the user-side twin of {@link ConciergeSparkleMessage.collapsed}, and the founder's ask
   * verbatim: *"I want that same functionality when I'M the one sending big blocks of text."*
   *
   * ── WHAT `text` MEANS ONCE THIS FIELD IS PRESENT ──────────────────────────────────────────────
   * `text` is what the user TYPED AROUND the pastes, and it is `""` on a paste-only send. The whole
   * message body is `composeBody(collapsed, text, { verbatimTyped: true })` — the same function the
   * compose box built it with, so the bubble and the wire cannot disagree about what a pill expands
   * to. Splitting the two is what keeps the QUESTION visible while the paste stays collapsed;
   * collapsing `text` itself would have hidden "what is wrong here?" inside the log it was asked
   * about.
   *
   * ── THIS IS THE BUBBLE'S RENDERING AND ONLY THE BUBBLE'S ──────────────────────────────────────
   * A user's message is rendered several ways (ConciergeHost's `send`, and the count kept in
   * ./agentRefs' header): the thread bubble, the payload relayed into a live Claude Code PTY, the
   * plain text the router and the auto-namer read, and the `display` every prompt-history surface
   * shows. THIS FIELD TOUCHES ONLY THE FIRST. Every other rendering is built from the composed body
   * the compose box hands `onSend` as its FIRST argument, which collapsing never touches — if a
   * pill ever shortened what reached the PTY, the agent would silently receive less than the
   * founder typed, which is the worst outcome this feature has available to it.
   * `ConciergeHost.userCollapsed.test.tsx` is the guard on exactly that, and it is not optional.
   *
   * ── THE OTHER READERS OF A `you` MESSAGE'S WORDS, WHICH THIS FIELD MADE PARTIAL ────────────────
   *   • `CopyAnswerButton` on the bubble — recomposes the full body, so the copy glyph still copies
   *     everything that was sent rather than only the visible half.
   *   • `replyAnchors.pendingAnchors` — quotes `text`, which is EMPTY on a paste-only send, so it
   *     falls back to the first block's preview. Without that, a 40-row message was quoted as
   *     "0 attachments".
   *   • `stores/conciergeThreadStore` — `clip` bounds `text` and cannot see this field, so
   *     `boundCollapsedPayloads` bounds it on both kinds.
   * A FOURTH reader pays the same price or reintroduces the bug. Check before adding one.
   *
   * `undefined` rather than `[]` on a message with no pastes, matching `attachments` and `mentions`.
   */
  collapsed?: TextBlock[];
}

/**
 * THIS SPARKLE LINE IS AN ACTION RECEIPT, and what it recorded — so a RUN of identical ones can be
 * folded to a single row (./receiptRuns).
 *
 * ══ WHY THE MESSAGE HAS TO CARRY IT ═════════════════════════════════════════════════════════════
 * `postSparkle` renders a receipt to `text` and drops everything else, so a receipt row is
 * structurally indistinguishable from any other app-authored line: no kind, no status, no marker.
 * That is exactly why the column could show sixteen near-identical "Sent to @X's terminal." rows and
 * nothing could tell they were the same fact sixteen times.
 *
 * ══ EVERY FIELD IS AN OBSERVATION, COPIED — NEVER RE-DERIVED ════════════════════════════════════
 * These mirror `ConciergeActionReceipt`'s own fields and are stamped from it at post time. They must
 * never be inferred from the rendered sentence: the folding rule turns on {@link ok} and
 * {@link failed}, and a mark that guessed them could fold a REFUSAL into a success count — the one
 * thing folding is forbidden to do (see ./receiptRuns for why that would be worse than no folding
 * at all).
 */
export interface ConciergeReceiptMark {
  /** The action, as the reader should understand it. Verbatim from the receipt. */
  kind: ConciergeActionKind;
  /** Did it actually happen? Verbatim from the receipt's own `ok`, which came from the dispatch
   *  reply's. A `false` here is what pins this row open on its own forever. */
  ok: boolean;
  /** For `sent`: which channel, because the three are visible at different times and must not share
   *  a folded sentence. */
  channel?: ConciergeSendChannel;
  /** This receipt was already plural (a broadcast). NEVER folded, refused or not — and that test
   *  sits ABOVE the refusal arm in `foldKeyOf` precisely so it still holds now that a gist-less
   *  refusal folds (roborev 63747). Folding several fan-outs would need a count of counts, and "Not
   *  sent, 2 times" over two broadcasts of N recipients understates how many agents missed the
   *  message. See ./receiptRuns. */
  fanout?: true;
  /** This `sent` was a picker press, not a message. Folds in its own bucket. */
  viaPicker?: true;
  /** How many recipients REFUSED, on a fan-out that reported `ok` anyway. Any value above zero
   *  keeps this row standing alone. */
  failed?: number;
  /**
   * THIS LINE SAYS MORE THAN ITS STANDARD SENTENCE, so it can never fold.
   *
   * `ok: true` is not the same as "nothing to read here". A spawn that came up but could not be
   * BRIEFED stays ok and carries the shortfall as its reason (services/conciergeReceiptClassifier —
   * "it stays ok and carries the shortfall as the reason"), which `actionReceiptLine` renders as a
   * whole second sentence: *"I created the agent, but its terminal didn't start … its opening brief
   * hasn't gone in yet."* An agent that starts unbriefed sits there doing nothing, and this line is
   * the only place the reader learns it.
   *
   * A fold replaces the sentence with a count, so that second sentence would simply be gone —
   * hiding the actionable half of a receipt behind a chevron, which is the one thing folding is
   * forbidden to do. A BOOLEAN rather than the text itself: the fold's only question is whether
   * this row must stand alone, the text is already in `text`, and every field here is written to
   * localStorage on every turn.
   */
  hasDetail?: true;
  /**
   * The subject AS THE LINE ITSELF RENDERED IT — resolved through the feed at post time by the same
   * lookup `actionReceiptLine` used, not re-resolved later.
   *
   * `subjectId` is present only when that lookup HIT, which is what makes a pill safe: a folded row
   * must not be able to name an agent the row it replaced could not, and must never mint a reference
   * to an id the app cannot open. `subjectName` is the label that was shown either way.
   */
  subjectId?: string;
  subjectName?: string;
  /**
   * For a REFUSAL aimed at the concierge: the short phrase its line showed in place of the tool's
   * paragraph (`Concierge/refusalAudience.refusalGist`). Absent on a success, and absent on a
   * refusal the founder must read — whose verbatim words never fold.
   *
   * WHY THE FOLD NEEDS IT (roborev 63295, Medium). These refusals repeat BY CONSTRUCTION — a merge
   * re-attempted while checks settle, a five-agent fan-out refusing per spawn at capacity — and the
   * founder's original report was that he saw them "verbatim and repeatedly". Keeping every row (as
   * it must, so a refusal can still contradict a turn claiming success) therefore trades N
   * paragraphs for N identical rows, which is the same column-of-identical-rows this module exists
   * to end. Folding on `kind + gist` collapses them without merging two different reasons.
   *
   * THIS DOC USED TO END "and a founder-actionable refusal still never folds because it has no
   * gist", which is the exact rule roborev 63727 reversed. It folds — on its VERBATIM reason, see
   * {@link reason} — and this block comment is the spec the next agent pins tests against, so a
   * stale sentence here is a live trap rather than an untidy comment. What `gist` still means, and all
   * it means, is WITHHOLDING: the tool's paragraph replaced by a short phrase, limited to refusals
   * `refusalAudience` positively recognises as the concierge's.
   */
  gist?: string;
  /**
   * For a refusal the FOUNDER must read: its verbatim words, so a run of IDENTICAL ones can fold
   * while still saying every word the rows it replaced said.
   *
   * THE OPPOSITE FIELD FROM {@link gist}, and mutually exclusive with it by construction — `gist` is
   * what a row shows INSTEAD of the tool's words, this is the words themselves. Exactly one of the
   * two is set on a refusal, which is what lets `./receiptRuns` tell a withheld reason from a kept
   * one without re-running the classifier.
   *
   * WHY THE TEXT AND NOT A BOOLEAN, unlike {@link hasDetail}. That field only had to answer "must
   * this row stand alone?", and the answer is a bit. This one has to be RENDERED: the folded
   * sentence repeats the reason verbatim, so a bit would leave it with nothing to say and force it
   * back to a count — which is the withholding this field exists to avoid. A digest would bucket
   * correctly and still not render.
   *
   * FOLDING IS NOT WITHHOLDING, which is the whole licence for this field (the founder's ruling:
   * "maybe you collapse them all or something", after four reports of the same wall). A folded run
   * of founder refusals states the count, repeats the reason word for word, names every subject as
   * the row did, and expands in place. Nothing that reached him before reaches him less.
   *
   * IT COSTS LOCALSTORAGE, and that is the known trade. Every mark is persisted on every turn, and
   * `hasDetail`'s doc chose a boolean partly for that reason. A refusal reason is one sentence and
   * only refusals carry it, so the cost falls on the population that is by definition rare — while
   * the alternative is a permanent wall on the population that is not.
   */
  reason?: string;
}

/** Left-aligned plain Sparkle reply. No "Sparkle" label, no glow — just warm text. */
export interface ConciergeSparkleMessage {
  id: string;
  kind: "sparkle";
  text: string;
  /** Set when this line is an action receipt — see {@link ConciergeReceiptMark}. Absent on every
   *  other app-authored line and on every brain reply, which is what keeps those out of a fold. */
  actionReceipt?: ConciergeReceiptMark;
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
  /**
   * The user messages this reply is answering, in the order they were SENT — rendered as quoted stubs
   * above the reply, the way iMessage shows the original it is replying to.
   *
   * WHY IT IS ON THE MESSAGE. The founder sends several messages while a turn is in flight; each send
   * kills the turn before it, so one reply arrives covering the lot and nothing says which question
   * any paragraph belongs to. This field is that record. The rule that fills it — "everything the
   * brain still owed an answer on when this reply began" — is INFERRED by the app, not declared by the
   * model (see ./replyAnchors for why), so it cannot quietly stop working on a terse turn.
   *
   * It carries a QUOTE SNAPSHOT alongside each id, like `ConciergeUserMessage.mentions` carries the
   * addressed names: the thread is trimmed from the front and reindexed on restore, so a stub
   * resolved from the live array would vanish the moment its target aged out.
   *
   * `undefined` on a reply that answers nothing — a push, or the first line of a session — matching
   * every other optional field here: this thread is persisted.
   */
  answers?: ReplyAnchor[];
  /**
   * THE TURN BEHIND THIS BUBBLE REACHED `done` — the brain finished speaking.
   *
   * Set from `onConciergeDone`, so it distinguishes the three things that all render as a plain
   * left-aligned bubble and are otherwise indistinguishable:
   *
   *   • a real, completed answer — this flag;
   *   • an APP-AUTHORED status line ("Sent to Kraken Auth.", "Approving…") — `ConciergeHost.postSparkle`
   *     appends 25 kinds of these as ordinary `sparkle` messages, and they never go near a turn;
   *   • an ABANDONED FRAGMENT — a turn the user's next send killed mid-stream. `askSparkle`
   *     deliberately leaves a bubble that streamed text alone, so nine characters of a dead answer
   *     stay in the thread forever.
   *
   * WHY THE DISTINCTION IS LOAD-BEARING, and not just tidiness: the reply-anchor rule walks back for
   * "everything the brain still owed an answer on" and has to stop at the previous ANSWER
   * (./replyAnchors). Inferring that from `kind` alone made a routing receipt end the burst, and made
   * a dead fragment both end the burst AND claim the messages the real reply went on to answer — in
   * exactly the interleaved-burst case the affordance exists for.
   *
   * A restored bubble is stamped by `conciergeThreadStore.rehydrateThread`: nothing that survived a
   * restart is still streaming.
   */
  settled?: true;
  /**
   * This bubble's stream is OVER, but it never became an answer.
   *
   * Set when a turn ends without reaching `done` — it failed, or the user's next send superseded it
   * mid-stream. The text already painted stays on screen (see the ABANDONED FRAGMENT case above), so
   * the bubble is finished growing even though nothing settled it.
   *
   * ── WHY THIS IS NOT `settled` (roborev 62935) ───────────────────────────────────────────────────
   * `settled` means "this is the previous real ANSWER" and `replyAnchors` walks back to it. A dead
   * fragment that claimed that role would both end the burst and claim the messages the real reply
   * went on to answer — the exact defect the paragraph above records. So a second field, read by the
   * consumers that need "has it stopped changing" rather than "did it answer".
   *
   * `conciergeHistoryCapture` is the first such consumer: it waits for a brain bubble to stop
   * growing before indexing it, and without this marker a reply the founder can still scroll back to
   * would never be searchable — the "did you never ask / we never captured" confusion the concierge
   * history exists to remove, reintroduced on the failure path.
   */
  streamEnded?: true;
  /**
   * This reply is HELD by a blocking lint finding while a correction turn runs.
   *
   * The row stays in the thread with its text blanked rather than being spliced out, because the
   * thread is ordered by position and `upsert` appends a row it cannot find — a spliced reply came
   * back at the BOTTOM, under anything that landed during the hold, so the answer to one question
   * rendered beneath a later one and read as its answer (roborev 58971).
   *
   * So the flag exists to tell "blanked on purpose, a rewrite is in flight" apart from "a turn that
   * produced nothing" — an empty bubble with no marker reads as a lost reply, which is precisely
   * what the block path must never look like. `ConciergeThread` draws the placeholder off this;
   * `settleHold`'s upsert clears it when the winning text lands.
   */
  held?: true;
  /**
   * WHAT THE REPLY LINTER CAUGHT IN THIS TURN (bead sparkle-kr2jz, part A).
   *
   * `services/conciergeLint/` runs on every `concierge:done` and its findings used to go two places
   * the app cannot show anyone: an in-memory counter nothing reads, and a JSONL only a CLI script
   * reads. So `ask-without-action` — "say go and I'll spawn it" instead of spawning it, the founder's
   * single most-repeated complaint, 35 of 45 first-person promises never carried out across 1,490
   * measured turns — fired correctly and invisibly. This field is what makes it visible: the turn's
   * violations ride on the bubble they were found in, and ./LintMark draws one quiet line from them.
   *
   * METADATA ONLY, and the type enforces it: {@link MessageLintMark} is a narrowing of the linter's
   * `Violation` that drops `span` (a character COUNT, never the matched text) and carries only the
   * check id, the severity, and the check's own short reason. Reply text and matched spans must
   * never land here — see `services/conciergeLint/types.ts`'s `Violation` doc comment, and
   * `services/conciergeAudit.ts`'s standing decision against putting concierge prose on disk. This
   * field IS written to disk (below), which is what makes that rule load-bearing rather than tidy.
   *
   * IT SURVIVES A RESTART, unlike {@link ConciergeFailureMessage} — the deliberate counter-example,
   * kept off `PERSISTED_KINDS` because "you've hit your session limit · resets 8:40am" restored
   * tomorrow morning is a claim about NOW that has expired. A lint mark is not that kind of claim.
   * It is a closed observation about a turn that is over: "this reply said it would act and no
   * action ran in it" was true when it was recorded and cannot become false later, and the reply
   * text it annotates is persisted verbatim right beside it. Dropping it on restart would also undo
   * the point — the founder's complaint is a PATTERN across turns, and a mark that evaporates
   * nightly rebuilds exactly the invisibility this field exists to end.
   *
   * Bounded and re-validated at both persistence boundaries rather than trusted: see
   * `stores/conciergeThreadStore`'s `persistableThread` and `rehydrateThread`, and `MAX_LINT_MARKS`
   * in ./lintMarks. `undefined` on a clean reply, matching every other optional field here.
   */
  lint?: MessageLintMark[];
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
  /** EVERY agent this line stands for, in feed order — `memberIds.length` equals the line's count.
   *  Carried so a line can name what it collapsed rather than only counting it: a number you cannot
   *  open is the "+11 more" dead end this whole rule came from. */
  memberIds?: string[];
}

/** The return-from-Away briefing. Its shape lives with the DIFF that builds it
 *  (services/conciergeRecap) rather than here, for the same reason `Attachment` does: it is a pure,
 *  React-free model, and a second declaration of it is exactly how the card and the diff would
 *  drift. Re-exported so consumers of this module's public surface get it from one place. */
export type { ConciergeRecapMessage } from "../../services/conciergeRecap";
import type { ConciergeRecapMessage } from "../../services/conciergeRecap";
// TYPE ONLY — this directory stays store-free; the union is defined beside the function that
// produces it so both sides of the seam cannot drift.
import type { RevealOutcome } from "../../services/agentReveal";

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
  /** True when the failure was classified as an AUTH failure, so the bubble can offer to
   *  re-authenticate in place.
   *
   *  A REMEDY STRING IS AN INSTRUCTION THE USER WILL FOLLOW (AGENTS.md), and the auth headline now
   *  says "sign in again" — so the button that makes that possible has to travel with it. Without
   *  this flag the copy would name an action the UI does not offer, which is how the previous
   *  version ("run `claude` in a terminal") sent desktop users to a shell. */
  canReauth?: boolean;
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
   * This message's TURN was displaced: it was still running with nothing emitted when the user's
   * NEXT message arrived (`concierge.rs` kills the old child and its reader goes silent — no event,
   * no log, nothing).
   *
   * RECORDED, BUT NO LONGER RENDERED. This used to drive a receipt line reading "→ Replaced by your
   * next message — never answered". That line was deleted on 2026-07-31: a displaced turn is
   * frequently answered anyway, a couple of messages later, because the user's next message carries
   * enough of the earlier question for the brain to address both. "Never answered" is therefore a
   * claim the app CANNOT KNOW, and it was stated flatly on turns that had in fact been served. A
   * receipt whose whole justification is that the user can trust it must not assert an unknowable.
   * So `receiptText` ignores this flag and a displaced message renders the ORDINARY receipt for its
   * target ("→ Answered here" / "→ Sent to <agent>"); RoutingReceipt.test.tsx pins the absence.
   *
   * WHY IT IS STILL RECORDED. Displacement itself IS knowable and did happen at scale: on
   * 2026-07-29, 149 of 378 turns (39.4%) were displaced this way, and 12 of the 14 turns in the
   * 20:18-20:31 burst. Keeping the fact on the message keeps it available to anything that wants to
   * count or reason about displacement without re-deriving it from the transcript.
   *
   * NOT a health claim. A displaced turn says nothing about whether the concierge is well — the
   * user's own next message is what killed it — so this never feeds the liveness detector
   * (engine/conciergeLiveness). It is a fact about ONE message.
   */
  unanswered?: true;
  /**
   * The message was NOT sent anywhere: the target terminal declined free text (a full-screen app, a
   * prompt waiting on screen, a screen that could not be read) and the words went back to the
   * composer.
   *
   * WHY THIS IS ITS OWN FIELD (roborev 57360). The refusal used to post `target: "sparkle"`, on the
   * reasoning that the message had "fallen back" — but `receiptText` renders a sparkle target as
   * **"→ Answered here"**, and nothing was answered anywhere. The brain was never asked; the text is
   * sitting back in the box. That is the same class of lie as a `target: "agent"` receipt over a
   * write that never landed, which the code around it already guards against — the `sparkle` arm was
   * simply the unguarded twin.
   *
   * NOT `unanswered`, which is a different fact with different copy ("Replaced by your next message
   * — never answered"): that one reached the brain and got silence. This one never left.
   */
  refused?: true;
}

/** Everything the column renders, supplied by the integration layer. */
export interface ConciergeViewModel {
  /** Which projects the column is watching. STILL FED, NO LONGER PRINTED: the header used to read
   *  "Pinned to <name>" / "All projects" here and the founder asked for that line gone (bead
   *  sparkle-ircc3), so nothing in this directory renders it. Pinning stays visible on the pinned
   *  project's TAB — a solid, rotated, accent-ink pin held at full opacity (ProjectTabs.tsx). Hand
   *  it the FULL folder name regardless; a consumer that starts stating the scope again should get
   *  the whole thing and spend its own width budget on it. */
  scope: { pinnedProjectName?: string };
  /** In-scope per-band counts. The header states only `needs_you`, and only as the red filter
   *  pill's numeral — `running` and `done` are carried for consumers that want them and are
   *  deliberately never printed beside the wordmark. */
  vitals: Record<StatusBand, number>;
  /** The per-project split of `vitals.needs_you`, worst project first. Column one is the GLOBAL
   *  index (PRD §2a, answered 2026-07-28), so it accounts across projects while column two stays
   *  scoped to the selected one. STILL FED, NO LONGER PRINTED: the header's per-project segments
   *  ("2 here · 1 in mobile") went with the scope line in bead sparkle-ircc3. */
  needsYouByProject?: ProjectNeedsYou[];
  /** The thread, oldest first. The only nudges left here are RESOLVED ones — a finished episode is
   *  history, and history belongs in the transcript. Live ones are in {@link pinnedBlockers}. */
  messages: ConciergeMessage[];
  /**
   * LIVE blockers, pinned directly above the composer and never scrolling with the thread.
   *
   * Founder, 2026-08-07: *"I want any sort of blocked notices to be right above the compose window.
   * And not in line in the chat thread… they should stay persistently above the composed window so
   * that I see them regardless of how much the chat thread moves."*
   *
   * DISJOINT FROM {@link messages} BY CONSTRUCTION — the host puts a live nudge in exactly one of
   * the two. Rendering both would show one agent's blocker twice, and the scrolling copy is the one
   * that goes stale, which is the bug the move exists to end.
   */
  pinnedBlockers?: ConciergeNudge[];
  /** Blockers the reader has ACKNOWLEDGED, drawn as quiet chips that stay on the strip. Snapshots,
   *  not live feed items: acknowledging de-escalates the published band, so these agents are no
   *  longer derivable from the feed at all. See `PinnedBlockers`. */
  acknowledgedBlockers?: ConciergeNudge[];
  /** True while Sparkle is composing a reply — renders the typing indicator row. */
  typing?: boolean;
  /**
   * What the concierge is doing about a SPECIFIC message the user sent, keyed by that message's id.
   *
   * The founder's ask: *"I would like to see a status below each chat message that I send, showing
   * what it's doing about that specific message."* The column-level typing row answers the same
   * question for the column as a whole, which is ambiguous in a thread of several questions — the
   * reader has to work out which of their messages it refers to.
   *
   * SPARSE, and usually a single entry. A message the app knows nothing about carries no entry and
   * renders nothing; see services/conciergeMessageStatuses for why an unanswered older message is
   * deliberately left blank rather than marked dead.
   */
  statuses?: Record<string, ConciergeMessageStatusText>;
  /** The ONE turn boundary the column reports against (services/conciergeTurnFloor). */
  turnFloor?: number;
  /** Files riding along with the NEXT send (parity row #21), rendered as removable chips above the
   *  compose row. The integration layer owns the list; the box only reports removals. */
  attachments?: Attachment[];
  /** The transcript fragment the NEXT send is replying to, staged by the "Quote in response"
   *  chiclet and drawn as a removable chip above the draft. Owned by the integration layer for the
   *  same reason `attachments` is — the box only reports removals, and the host reads this at send
   *  time so `onSend`'s arity contract is untouched (see ComposeBox's `quote` prop). */
  quote?: ComposeQuote | null;
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

/** WHICH copy affordance fired (PRD 1). These are deliberately different operations — a selection
 *  copies the RENDERED words, an answer or a message copies its MARKDOWN SOURCE — so the
 *  confirmation says which one happened rather than one vague "Copied".
 *
 *  `message` is the user's OWN bubble, added when the founder asked for the same button on the
 *  things he wrote. It is a distinct kind rather than folding into `answer` because the live region
 *  is the only channel a screen-reader user has to tell the two apart: both sides of the
 *  conversation now carry a copy button, and "Answer copied" spoken after copying your own sentence
 *  is a lie about whose words are on the clipboard. */
export type ConciergeCopyKind = "selection" | "answer" | "message";
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
  /** THIS AGENT'S LIVE STATUS, for the "Chatting with ● Name" chip (bead sparkle-wj3ya).
   *
   *  The founder asked for "the dot that has the color of the agent … so it would be the dot and
   *  then the name of the agent", and the bead is explicit that it must reflect LIVE state, not the
   *  state at mount time: *"An agent that goes red while he is composing should show red."* So the
   *  host SUBSCRIBES to it rather than reading it once — see its construction in ConciergeHost.
   *
   *  Carried here rather than looked up in the column because this column never imports a store;
   *  the same rule `thread` above follows. Optional so every existing caller and suite is unchanged
   *  — absent simply renders the chip without a dot rather than inventing a status. */
  status?: AgentTabStatus;
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
   *  landed" (the chat path, which can't fail visibly).
   *
   *  `collapsed` is the BUBBLE's decomposition of that same body — the pills that were staged and
   *  the words typed around them (see composer/attachments' {@link CollapsedSend}). Present ONLY on
   *  a send that staged a pill, so an ordinary send is the one- or two-argument call it has always
   *  been. It changes what the transcript DRAWS and nothing else: `text` above is still the whole
   *  body, and it is `text` that reaches the PTY. */
  onSend(
    text: string,
    mentions?: ConciergeMention[],
    collapsed?: CollapsedSend,
  ): void | Promise<boolean>;
  /** The user tapped the redirect on a routing receipt: send that same message the OTHER way.
   *  Additive — the original delivery stands (see ConciergeReceipt). */
  onRedirect?(messageId: string): void;
  onAttach(kind: ConciergeAttachKind): void;
  /** Drop one staged attachment by id. Optional: a column mounted without attachments has none. */
  onRemoveAttachment?(id: string): void;
  /** The user acknowledged the attach-failure notice. */
  onDismissAttachNotice?(): void;
  /** A highlighted fragment of the transcript was sent to the compose box via the "Quote in
   *  response" chiclet. Optional: a column with no composer under it never raises the affordance. */
  onQuote?(quote: PendingQuote): void;
  /** The staged quote's × was pressed. */
  onRemoveQuote?(): void;
  /** A digest line was clicked — open that project's tab and reveal its lead agent. This is the
   *  handoff to column two that the digest exists to make (bead sparkle-4562.4). */
  onDigestClick?(digest: ConciergeDigestMessage): void;
  /** Switch to the named project. Switch ONLY — no agent is named by a count, so nothing may be
   *  selected on its behalf. Bead `sparkle-vohh` fixed the mirror-image bug (a nudge selected an
   *  agent without switching project); this must not reintroduce its other half.
   *
   *  STILL SUPPLIED, NO LONGER CALLED FROM THIS DIRECTORY: its one caller was the header's
   *  per-project segments ("1 in mobile"), deleted with the scope line in bead sparkle-ircc3.
   *  `ConciergeHost` still wires it, so a future cross-project affordance has the callback ready
   *  rather than having to re-derive the switch-without-selecting rule above. */
  onProjectClick?(projectId: string): void;
  /** Something in the thread reached the clipboard: the user's own selection, a whole answer via
   *  its copy button, or one of the user's own messages via the same button in its `message`
   *  variant (PRD 1 §1/§2). {@link ConciergeCopyKind} says which.
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
   *  affordance that lies, the same rule the header's other optional controls follow. */
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
   *  RETURNS WHAT THE READER SAW — `"revealed"`, `"already-showing"` or `"gone"`. It was a boolean,
   *  and the boolean was the bug (bead sparkle-ixsb3): `false` was documented here as "the click
   *  changed nothing on screen", while the function bound to it returns `true` whenever its WRITES
   *  RAN. Those are different questions, and every write on the reveal path is idempotent — so an
   *  agent whose column was already showing it reported success, the pill stayed silent on success,
   *  and the click was invisible. `"already-showing"` is the state that had no way to be said.
   *
   *  Absent means pills still RENDER (with their live name and status dot) but report a failed
   *  open when clicked, which is the honest default for a surface that has not wired the reveal
   *  path — it cannot navigate, so it must not pretend it did. */
  onOpenAgent?: (target: {
    agentId: string;
    projectId: string;
  }) => RevealOutcome;
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
  /** The Auto-send toggle's position — does an expired Speak countdown actually send? Absent → on,
   *  which is how Speak has always behaved. OFF still runs the countdown; see ./AutoSendToggle. */
  autoSendOn?: boolean;
  /** The user flipped Auto-send. ABSENT HIDES THE TOGGLE — a switch the engine ignores is worse
   *  than none. This column is a conduit for both, exactly as it is for `sendMode`. */
  onAutoSendChange?: (next: boolean) => void;
  /** A live PTY owns the keyboard, so the tray is not being addressed and goes flat grey. */
  trayInert?: boolean;
  /** Is the push-to-talk gesture active — key or button down? Passed straight through to the tray;
   *  the host reads it from `useSendMode`. This column is a conduit, not a decider. Missing this
   *  link made the tray's held treatment dead code in the app (roborev 57452). */
  pttHeld?: boolean;
  /** The compose box's contents changed, whatever wrote them — the countdown's only view of what
   *  it would send. Distinct from `onTextEdit`, which is narrower on purpose; see ComposeBox. */
  onComposedText?: (text: string) => void;
  /** An `@`-address is part-way written at the caret, so the countdown must pause (sparkle-14dtu).
   *  A conduit like the rest: the box owns the caret, the host owns the clock. */
  onMentionComposing?: (composing: boolean) => void;
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
  /**
   * The mounted agent a SEND would actually reach — which is a narrower fact than {@link
   * mountedAgent}, and the composer's typeface reports this one.
   *
   * DELIBERATELY A THIRD VALUE rather than a derivation of the two above (roborev 57358/57361). The
   * cable being patched is enough to decide whose CONVERSATION to show; it is not enough to decide
   * where words GO, because the host also gates routing on whether the agent's pane is on screen at
   * all (`promptTargetShown` — false with the Plan board or Improve-Sparkle up, or the tab closed).
   * In those states the mounted conversation should stay visible while the composer must NOT claim
   * to be typing into a PTY, because the send path has already decided it is not.
   *
   * Null is the honest default: a column that is not told this paints the app's own face, which is
   * what every composer did before the mounted-composer rule existed.
   */
  routableMountedAgentId?: string | null;
  /**
   * The latest mounted-path outcome, rendered in a row that survives the mount swap.
   *
   * MOUNTED, THIS COLUMN DOES NOT RENDER `ConciergeThread` AT ALL — so everything the send path says
   * with `postSparkle` is written to a component that is off screen, including terminal refusals and
   * the `@Sparkle` escape hatch's own reply (roborev 57360). This is the surface that is still there.
   * See ./MountedNotice for why it is a sibling row rather than a thread entry.
   */
  mountedNotice?: MountedNoticeModel | null;
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
