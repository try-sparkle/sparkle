// ConciergeHost — the integration layer (bead sparkle-qd80 / CM-U7) that turns the presentational
// ConciergeColumn (CM-U1) into the live, cross-project concierge: it builds the view-model from the
// real status-band feed (CM-U3), streams the headless brain (CM-U2) into the thread, and routes the
// user's answers into the right agent's terminal via the dispatch relay (CM-U4).
//
// Mounted UNCONDITIONALLY as the persistent left column of the workspace — the concierge IS the
// experience, not a flagged addition to an older UI (PRD/sparkle/concierge-mode.md §6). It owns
// all concierge state; the column stays a pure renderer. The status-band feed is built ONCE by
// Workspace (it drives the tab badges too) and passed in, so there is a single subscription, a
// single tray-roster fetch, and no chance of the tab counts and the vitals line disagreeing.
//
// The voice pass (bead sparkle-4562.2 / CM-U9) is wired here too, but INPUT ONLY: the mic borrows
// the app-wide dictation target (useConciergeDictation) while the user talks. Sparkle never talks
// back — text-to-speech was removed whole (PRD/feat/ui-refresh-2026-07-27 §5), so there is no
// autoplay gate, no speaker button, and no reason for this file to know a turn was dictated.
//
// AUTO-ROUTING (PRD/sparkle/concierge-auto-routing.md). The compose box no longer carries a target
// toggle: this host decides, per message, whether it goes to the selected agent's terminal or to
// Sparkle's chat (services/conciergeRouter — heuristics first, then one Haiku tiebreak). Three
// things make that defensible, and all three live in this file:
//   • every send posts a RECEIPT naming where it went, with a one-tap redirect (setReceipt);
//   • routing failure falls back to `sparkle`, the recoverable direction (the router's own rule);
//   • sends are SERIALIZED (enqueue), because routing is a network round trip and two messages
//     sent in quick succession would otherwise reach the PTY out of submit order.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ConciergeColumn,
  receiptText,
  type ConciergeAnnouncement,
  type ConciergeCopyKind,
  type ConciergeDigestMessage,
  type ConciergeMessage,
  type ConciergeNudge,
  type ConciergeReceipt,
  type ConciergeViewModel,
} from "./Concierge";
import type { ConciergeMountedAgent, ConciergeReceiptMark } from "./Concierge/types";
// The reply-anchoring RULE — which of the user's messages a reply is answering — lives in its own
// pure module (no React, no stores) so the inference is unit-testable without mounting this file, and
// so the stub that draws an anchor reads the same declaration the host writes.
import { anchorQuote, pendingAnchors, type ReplyAnchor } from "./Concierge/replyAnchors";
import { quoteFace, quotePrompt } from "./Concierge/composeQuote";
import { rememberSentText, SENT_TEXT_LIMIT } from "./Concierge/sentTextLedger";
// RE-EXPORTED, not just imported: `SENT_TEXT_LIMIT` and `rememberSentText` were exported from this
// file before they moved, so every existing importer keeps resolving them here.
export { rememberSentText, SENT_TEXT_LIMIT };

// The three shapes a send carries — the aim, the out-loud address, the quote to give back — plus the
// `agentId`→`id` adapter between the first and `conciergeLine.ref`. `ConciergePromptTarget` is
// RE-EXPORTED below: five suites import the type from this file.
import {
  asAgent,
  type ConciergeMentionAim,
  type ConciergePromptTarget,
  type SentQuote,
} from "./Concierge/hostTypes";
export type { ConciergePromptTarget };
// The refusal vocabulary — was this send refused, and what do we tell the founder about it.
// `TRIAL_SPENT_TEXT` is RE-EXPORTED because ConciergeHost.test.tsx imports it from this file.
import {
  refusalCopy,
  refusedPath,
  terminalRefusalLine,
  terminalRefusalText,
  terminalWriteBlocked,
  TRIAL_SPENT_TEXT,
} from "./Concierge/refusalCopy";
export { TRIAL_SPENT_TEXT };
// What the thread says about a message it handed on. `relayFollowUp` is RE-EXPORTED because
// ConciergeHost.mention.test.tsx imports it from this file.
import { elideQuote, OUTCOME_QUOTE_CHARS, relayFollowUp } from "./Concierge/relayCopy";
export { relayFollowUp };
// Two leaf components the host mounts and nothing else does. `prChipScopes` is RE-EXPORTED because
// ConciergeHost.prChipScope.test.tsx imported it from this file.
import { LivenessAnnouncer } from "./Concierge/LivenessAnnouncer";
import { ConciergePrChip, prChipScopes } from "./Concierge/ConciergePrChip";
export { prChipScopes };
// The linter's findings, projected to the metadata-only shape a message carries, plus the wording
// rule the mounted-column notice below reuses so the banner and the inline mark say ONE thing.
import { lintMarkText, toLintMarks, type MessageLintMark } from "./Concierge/lintMarks";
import { ConciergeSuggestions } from "./Concierge/ConciergeSuggestions";
// The two ALARM controls the card draws (Mute, [x]). Imported rather than re-spelled: the card
// fires them and this file handles them, and a literal on each side is a silent no-op waiting to
// happen — the handler would simply never match.
import { NUDGE_DISMISS_ACTION, NUDGE_MUTE_ACTION } from "./Concierge/NudgeCard";
import { PINNED_CLEAR_ACTION } from "./Concierge/PinnedBlockers";
import type { ConciergeAgent, ConciergeFeed } from "../useConciergeFeed";
// The column-one population selectors now live beside `accountedUnmerged` in the module that already
// owned that family, rather than in this file where they had accumulated.
import {
  accountedUnmerged,
  allAgents,
  feedStatuses,
  isPromptableTarget,
  nestedRowlessAgents,
  strandedAgents,
  surfacedAgents,
} from "../services/conciergeFeed";
import { agentToNudge, NUDGE_OPEN_ACTION } from "../engine/conciergeNudges";
import { buildSnapshot } from "../engine/conciergeSnapshot";
import { buildContinuityBlock } from "../engine/conciergeContinuity";
import { useConciergeThreadSummaryStore } from "../stores/conciergeThreadSummaryStore";
import { maybeRefreshThreadSummary } from "../services/conciergeThreadSummary";
// ONE concierge-history writer, not two (sparkle-yd1ud × sparkle-s7rfc). Both merged branches
// indexed this conversation — main by hand-placed `recordConciergePrompt`/`recordConciergeReply`
// calls on the dispatch and reply paths, this branch by a subscriber on the thread store. Wiring
// both would have written every message TWICE, and git resolves that cleanly because it is not a
// textual conflict. The subscriber survives: the history row id IS the bubble id, so `INSERT OR
// IGNORE` makes duplicates structurally impossible, and it sits downstream of every path that
// reaches the screen (normal, held, corrected, proactive) rather than three call sites that each
// have to be remembered. See services/conciergeHistoryCapture.ts.
import { startConciergeHistoryCapture } from "../services/conciergeHistoryCapture";
import { captureAsksFrom, openAsksNow, startAskQueue } from "../services/conciergeAskQueue";
import { createResearchDrain, withResearchPreamble } from "../services/research/drain";
import {
  allTasksNow as allResearchTasks,
  markResearchRead,
  refreshResearch,
  useResearchStore,
} from "../services/research/store";
import { recordConciergeEvent } from "../stores/conciergeEventLog";
import { oneLine } from "./promptHistory";
import { openProjectTab } from "../services/openProjectTab";
import { revealOutcomeFor, type RevealOutcome } from "../services/agentReveal";
import { useHistoryStore } from "../stores/historyStore";
import { formatBinding } from "../keyboardHints/keybindings";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import { useConciergeMessageStatuses, waitingLine } from "../services/conciergeMessageStatuses";
import {
  clearQueue,
  waitingCount,
  EMPTY_TURN_QUEUE,
  // ALIASED: this file already has an `enqueue` — the send SERIALIZER, which orders network
  // round-trips within one send. This one queues whole TURNS. Different jobs, and a shadowed name
  // here would silently route sends into the wrong one.
  enqueue as enqueueTurn,
  turnFinished,
  type QueuedTurn,
  type TurnQueueState,
} from "../engine/conciergeTurnQueue";
import { useConciergeTurnFloor } from "../services/conciergeTurnFloor";
import {
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  onConciergeTool,
  ConciergeAiDisabledError,
  onConciergeTurnsAbandoned,
  startConciergeTurn,
  startProactiveConciergeTurn,
  isProactiveTurn,
  isSupersededDetail,
  type ConciergeToolCall,
} from "../services/concierge";
import {
  noteConciergeNativeToolCall,
  noteConciergePhase,
} from "../services/conciergeActivity";
import {
  clearConciergeLiveness,
  conciergeSawAnswerText,
  noteConciergeFailed,
  noteConciergeProgress,
  noteConciergeSent,
  noteConciergeSettled,
} from "../services/conciergeLiveness";
import {
  buildLintCorrectionPrompt,
  reportLintOutcome,
  runReplyLint,
} from "../services/conciergeLintRunner";
import { DISABLED_POLICY, toLintPolicy } from "../services/conciergeLintPolicy";
import type { LintPolicy, LintResult, Violation } from "../services/conciergeLint";
import type { LintAction } from "../stores/conciergeLintMetrics";
import { getConfig, onConfigChanged, type EffectiveConfig } from "../services/config";
import { conciergeFailureNotice } from "../engine/conciergeFailureNotice";
import { reportClaudeAuthFailed } from "../services/claudeAuthSignal";
import {
  createProactiveScheduler,
  markStaleProactive,
  surfacedDigest,
} from "../services/conciergeProactive";
import {
  setConciergeNotifier,
  clearConciergeNotifier,
  notifyConcierge,
} from "../services/conciergeNotifier";
import {
  initialState as initialDelegationState,
  noteToolCall as noteDelegationToolCall,
  type DelegationState,
} from "../engine/conciergeDelegation";
import {
  agentCanAcceptPrompt,
  dispatchConciergeAnswer,
  onDeferredSendOutcome,
  type ConciergeDispatchResult,
} from "../services/conciergeDispatch";
import type { DispatchAuthority } from "../services/dispatchAuthority";
import {
  armIntent,
  armedIntents,
  cancelIntent,
  confirmIntent,
  countdownAnnouncement,
  resumeQueuedIntents,
  subscribeIntents,
} from "../services/dispatchIntent";
import { ConciergeApprovals } from "./Concierge/ConciergeApprovals";
import { CountdownBanner } from "./Concierge/CountdownBanner";
import { flat, line, plain, ref } from "./Concierge/conciergeLine";
import type { Line } from "./Concierge/conciergeLine";
import { actionReceiptLine, receiptMark } from "./Concierge/actionReceiptLine";
import {
  noteConciergeTurnForPromises,
  promiseVerbPhrase,
} from "../services/conciergePromiseLedger";
import { toLintToolCalls } from "../services/conciergeLintRunner";
import {
  claimReceiptForDisplay,
  onConciergeActionReceipt,
  setConciergeTurnOrigin,
} from "../services/conciergeReceipts";
import { routeMessage } from "../services/conciergeRouter";
import {
  mentionFreeText,
  mentionRoster,
  scanMentions,
  rosterFromMentions,
  type ConciergeMention,
} from "./Concierge/mentions";
import { classifyComposerRoute } from "./Concierge/composerRoute";
import { useMountedNotice } from "../hooks/useMountedNotice";
import { buildDigest, type DigestReadiness } from "../services/conciergeDigest";
import { usePrReadinessStore } from "../stores/prReadinessStore";
import { isSparkleAgentId, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import {
  agentTranscriptWorktree,
  subscribeAgentTranscriptWorktrees,
} from "../services/agentTranscriptRegistry";
import { createArrivalOrder, forgetArrival, orderByArrival } from "../engine/conciergeStreamOrder";
import {
  forgetEpisode,
  forgetResolved,
  noteCardsShown,
  noteResolutions,
  resolvedNudges,
  windowResolvedLedger,
} from "../engine/resolvedNudges";
import { useEffectiveWired } from "../hooks/useEffectiveWired";
import { isAskingIsolated } from "../engine/buildSections";
import { useUiStore } from "../stores/uiStore";
import { attachedDisplay, attachedPayload } from "../services/conciergeAttach";
import { useConciergeAttachments } from "../hooks/useConciergeAttachments";
import { useConciergeQuote, type ConciergeQuoteApi } from "../hooks/useConciergeQuote";
// The collapsed-text primitive, used here to keep a relayed payload OUT of the transcript's prose:
// `shouldPasteAsPill` is the one threshold rule and `collapseText` the one place a block is built, so a
// transcript pill and the build-agent composer's pill (components/composer/AttachmentRow — the only
// other caller today) cannot disagree about what collapses or what it carries.
import {
  collapseText,
  shouldPasteAsPill,
  type Attachment,
  type CollapsedSend,
  type TextBlock,
} from "./composer/attachments";
import { screenshotAttachment } from "./composer/attachmentsApi";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
// Read imperatively (getState) inside the handoff effect only, to tell a cloud build agent — whose
// null prompt target is BY DESIGN — from an agent that genuinely went missing. Not subscribed: this
// host renders from the feed, and a project-store subscription would re-render it on every unrelated
// agent write.
import { useProjectStore } from "../stores/projectStore";
import { useMountedThread } from "../stores/mountedThreadStore";
import { useAgentTranscript } from "../hooks/useAgentTranscript";
// The SELECTED project id, for the header's "here" segment. A scalar selector, deliberately — it
// re-renders this host only when the selection actually changes, which is the narrow subscription
// the note above rules the whole `projects` array out in favour of.
import { useCurrentProjectId } from "../windowContext";
import { describePaths } from "../services/logSafePaths";
import { log } from "../logger";
import { useConciergeDictation } from "../useConciergeDictation";
import { useAutoSend, notifyManualSend } from "../voice/useAutoSend";
import { useSendMode } from "../voice/useSendMode";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { resolveMode, usePresenceStore, type PresenceMode } from "../stores/presenceStore";
// `setConciergeChat` is aliased to `setChat` AT THE IMPORT so it stays module-scoped: that is what
// keeps `react-hooks/exhaustive-deps` from demanding it in five dependency arrays below (a store
// setter isn't on the rule's known-stable list the way `useState`'s is, even though this one never
// changes identity). See the store for the full reasoning.
import {
  useConciergeThread,
  setConciergeChat as setChat,
  useConciergeThreadStore,
  BRAIN_ID_PREFIX,
  endStreamsThrough,
} from "../stores/conciergeThreadStore";
import {
  buildRecap,
  recapSummary,
  type AwaySnapshot,
  type RecapAgentInfo,
} from "../services/conciergeRecap";

// STAYS HERE, deliberately. Every thread id (`you-N`, `sparkle-N`, `pill-N`, `recap-N`) comes off
// this counter, and stores/conciergeThreadStore documents a reindex that exists BECAUSE it restarts
// at 0 on reload. Moving it to a module the host also re-exported would risk two live copies, so it
// is the one piece of module scope that is not up for extraction.
let seq = 0;
const nextId = (p: string) => `${p}-${(seq += 1)}`;

/**
 * Ceiling on a single queued delivery, so a hung one can't wedge the shared chain forever. Well
 * above any healthy send (routing has its own 4s deadline and a dispatch is local), so this only
 * ever fires on something genuinely stuck.
 *
 * KNOWN RESIDUAL, accepted deliberately. A race is not a cancellation: an overrun task keeps
 * running and could still reach the PTY after the queue has let later work past it — the reordering
 * the chain exists to prevent. Making the chain wait for the real task instead would fix that and
 * reintroduce the wedge this bound was added for (roborev 53119), where one hung delivery kills
 * Approve — the button whose job is unsticking a blocked agent — for the rest of the session. A
 * permanently dead Approve is worse than a pathological late write, so the bound stays and the
 * residual is documented rather than papered over. Cancellation at the dispatch layer is what would
 * actually resolve it.
 */
const QUEUE_TASK_TIMEOUT_MS = 30_000;

/**
 * ONE REPLY HELD BACK WHILE ITS CORRECTION TURN RUNS — the whole state of the linter's block path.
 *
 * A `severity = "block"` check used to compute `LintResult.blocked` and reach nobody: the mount read
 * `.text` and dropped the flag, so the strictest tier the config offers rendered exactly like
 * `"warn"`. This record is what makes it mean something — the reply is held here instead of being
 * rendered, ONE correction turn is dispatched, and whatever comes back (or doesn't) ends in
 * `settleHold`.
 *
 * ══ NEVER LOSE A REPLY ══════════════════════════════════════════════════════════════════════════
 * `services/conciergeLint` states the one unacceptable failure of this design: "a linter that can
 * destroy one is worse than no linter." So {@link LintHold.text} is the reply as it would have
 * rendered, kept for the length of the hold, and EVERY exit renders something — the correction when
 * one arrives, this text when it does not. `done` is the latch that keeps two racing exits (a late
 * `done` and the backstop timer, say) from rendering twice.
 */
interface LintHold {
  /** The ORIGINAL turn, which owns the bubble everything here renders into. */
  turnId: string;
  /** The held reply, linted — what renders if the correction never lands. */
  text: string;
  /** The held reply's violations, deliberately UNREPORTED until the outcome is known
   *  (`runReplyLint` defers a blocked result; see its header). */
  violations: Violation[];
  /** The held turn's tool calls, so the promise ledger runs against the reply that actually lands
   *  rather than one the user never saw. */
  toolCalls: readonly ConciergeToolCall[] | undefined;
  /** Which of the user's messages this reply answers, captured AT HOLD TIME.
   *
   *  `answerFields` computes anchors from the thread as it stands when the bubble is CREATED, and a
   *  held reply's bubble may not be created until after the user has sent something else — at which
   *  point `pendingAnchors` would claim that newer message too. "Answered below" under a question
   *  the brain never received is the exact over-claim `neverSentRef` exists to prevent, one path
   *  further along, so the answer is frozen here while it is still true. */
  answers?: ReplyAnchor[];
  /** The reply before the held one, so the correction is linted against the same `restated-state`
   *  corpus the held reply was. */
  prevReply: string | null;
  /** The correction turn's id, once `startConciergeTurn` has resolved one. Null means the dispatch
   *  is still in flight and no event can be attributed to it yet. */
  correctionTurnId: string | null;
  /** The backstop that fires when the correction turn simply never speaks. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Latched by `settleHold`. Two exits can race; only the first renders. */
  done: boolean;
}

/**
 * How long a held reply waits for its correction before it renders anyway.
 *
 * A ceiling, not a schedule: every ORDINARY end of a correction turn (done, error, superseded,
 * abandoned, a rejected dispatch, the user sending again) settles the hold directly, so this only
 * fires when the backend goes silent without a terminal event — which is the one case where nothing
 * else would ever render the reply. Generous next to a real concierge turn because firing early
 * would render the original while a good correction was still being written.
 */
const LINT_CORRECTION_TIMEOUT_MS = 90_000;

/**
 * THE RESEARCH TURN-START DRAIN (bead `sparkle-s7rfc`; reporting-channel PRD §3.3).
 *
 * Findings from research the concierge dispatched are folded into the prompt of a turn that is
 * happening anyway — ahead of the founder's message on a user turn, ahead of the roster section on
 * a push. Deliberately NOT a proactive interrupt: a push per finding would spend the shared
 * six-an-hour ceiling on routine results and rate-limit out a genuine blocker.
 *
 * MODULE SCOPE, NOT A REF, and that is load-bearing. The drain remembers which turn ids are
 * carrying which findings; a remount mid-turn (a key change, a project close) would otherwise
 * forget the staging and the finding would be told a second time. One window, one drain.
 *
 * Every edge is here and nowhere else: the clock, the store's cache, the claim, and the event
 * recorder. The rules themselves are pure and live in services/research/drain.
 */
const researchDrain = createResearchDrain({
  now: () => Date.now(),
  tasks: () => allResearchTasks(),
  markRead: (ids, at) => {
    // Fire-and-forget, and a failure is SAFE: an unstamped finding is told again next turn, which
    // is the recoverable direction this whole design is built around. The refresh pulls the disk's
    // answer back into the cache; until it lands, the drain's own claim set stops a repeat.
    void markResearchRead(ids, at).then(
      () => refreshResearch(),
      (e) => console.warn("research: could not mark findings read:", e),
    );
  },
  recordEvent: (payload, at) => {
    recordConciergeEvent(payload, at);
  },
});

/**
 * Run ONE fire-and-forget bookkeeping call so it can never cost the concierge send.
 *
 * ── WHY A HELPER AND NOT ONE `try` AROUND THE BLOCK (roborev 61937) ─────────────────────────────
 * A single `try` wrapping several calls is not independence: the first failure jumps to the catch
 * and every later call in the block is skipped. So a throwing ask-queue would silently take the
 * history write with it — the same silent-drop class the guard exists to prevent, reintroduced by
 * the guard's own shape. One call per invocation is what makes them actually independent.
 *
 * ── AND IT COVERS THE FAILURE THAT CAN ACTUALLY HAPPEN ──────────────────────────────────────────
 * `captureAsksFrom` is `async` and catches its own body, so it CANNOT throw synchronously — a bare
 * `try` around it guards a shape the wire never produces. Its reachable failure is a REJECTION, or a
 * throw from `postSparkle` inside its `.then` callback (which does `setChat` + `announce`), and
 * neither reaches an enclosing `try`. Hence the promise arm: sync throw and rejection both land in
 * the same place, and a caller does not have to know which kind of function it is holding.
 */
function bookkeep(what: string, fn: () => void | Promise<unknown>): void {
  const warn = (err: unknown) =>
    console.warn(`concierge: ${what} failed; the send is unaffected`, err);
  try {
    const result = fn();
    if (result instanceof Promise) void result.catch(warn);
  } catch (err) {
    warn(err);
  }
}

export function ConciergeHost({
  feed,
  promptTarget = null,
  promptTargetShown = true,
  width,
  searchSlot,
  onOpenHistory,
}: {
  /** The cross-project status-band feed, built once by Workspace (see the file header). */
  feed: ConciergeFeed;
  /** The SELECTED build agent, whether or not its pane is on screen. Drives the suggestions
   *  engine, which must keep running regardless of what the user is looking at. */
  promptTarget?: ConciergePromptTarget | null;
  /** Whether that agent's pane is actually SHOWN (not the Plan board / Improve Sparkle / a closed
   *  tab). Gates routing and the visibility of the recommended-action row — but NOT the engine.
   *
   *  The two are separate on purpose. This row is the only remaining host of `useSuggestions` for
   *  build agents, and that hook does more than render pills: auto-approve, auto-resume and the
   *  phone push all live inside it. Unmounting it whenever the user glances at the Plan board would
   *  silently stop a running agent from being auto-approved — a background convenience the user
   *  turned on precisely so agents don't stall — and resume on return. So the engine follows the
   *  SELECTION and only the rendering follows the VIEW (roborev 53074). */
  promptTargetShown?: boolean;
  width?: number;
  /** The shell's ⌘K palette trigger, rendered under the scope/vitals line (PRD §4). */
  searchSlot?: ReactNode;
  /** Open the ⌘K command palette — the ONLY live consumer of `historyStore` (the sidebar's
   *  `<HistorySearch>` mount was removed). Without it, "See what it did" on a closed agent's pill
   *  writes a query nothing renders, which is the dead click one level down. Owned by `Workspace`,
   *  which holds `useCommandPalette`. */
  onOpenHistory?: () => void;
}) {
  // Which side the cable is patched into, or "off". Drives the column's flood + lift.
  // THE PROJECTED SIDE, shared with the shell root and the row joints (hooks/useEffectiveWired).
  // This drove the column's own `data-wired`, its flood and its lift off the RAW store value, so a
  // patched pair with nothing selected kept flooding while the shell root already said "off" — the
  // exact consequence roborev 55249 was filed for, surviving in the surface that shows it most
  // (roborev 55386).
  const wired = useEffectiveWired();
  // Latest feed for the event handlers (send/nudge actions), which run after render.
  const feedRef = useRef(feed);
  // THE ASK QUEUE (bead sparkle-yd1ud). Started here because this component is where the founder's
  // messages arrive and where `buildSnapshot` composes the brain's context — the two seams the queue
  // sits between. The module holds one queue per window; starting it twice is a no-op re-wire.
  useEffect(() => {
    return startAskQueue({
      projects: () => useProjectStore.getState().projects,
      pinnedProjectId: () => feedRef.current.pinnedProjectId,
    });
  }, []);
  // The thread's arrival ledger: which message ids have been seen, and in what order. A REF, not
  // state — it records history rather than driving a render, and the memo below reads it while
  // building. Assign-once semantics keep a digest that flickers (a group needs >= 2 agents, so it
  // collapses at 1 and re-forms at 2) from leaping to the bottom of the thread each time.
  const arrivalRef = useRef(createArrivalOrder());
  // A bump counter for the RESOLVED-card ledger, which is module state (`engine/resolvedNudges`) and
  // therefore invisible to React. Every other change to that ledger happens while the view model is
  // being rebuilt for some other reason — a feed tick — so this exists for the one write that does
  // not: the reader pressing [x] on a resolved card. STATE rather than a ref for exactly that
  // reason; a ref would record the removal and never repaint it.
  const [resolvedRev, setResolvedRev] = useState(0);
  // BLOCKERS THE READER HAS ACKNOWLEDGED, kept as SNAPSHOTS so they can still be drawn.
  //
  // The founder's answer for what `[x]` does to a pinned blocker: *collapse to a quiet chip, never
  // vanish.* Both halves are load-bearing and they were in tension. `[x]` stays the app's
  // per-episode acknowledgement — the same transitive `dismissAlert` the inline card wrote, which
  // calms the Build row and is what stopped the rollup whack-a-mole — but acknowledging
  // de-escalates the PUBLISHED band, so the agent drops out of the live set and the row would
  // simply vanish from the one surface built so that it cannot.
  //
  // A snapshot rather than an id set, for the same reason `engine/resolvedNudges` keeps one: the
  // moment the agent leaves the red band it stops being derivable from the feed, so an id alone
  // would name a card nothing can reconstruct.
  //
  // Component state rather than a module ledger, unlike the resolved one, and the difference is
  // deliberate: that ledger holds `raisedAt`, a fact about the episode that must survive a remount.
  // This holds "I have already looked at this one", which is a view preference about right now and
  // SHOULD be forgotten on remount — a blocker acknowledged an hour ago deserves to speak up again
  // in a fresh session.
  const [acknowledged, setAcknowledged] = useState<readonly ConciergeNudge[]>([]);
  // THE RECORD IS RELEASED WHEN THE AGENT IS LOUD AGAIN — i.e. when it opens a NEW episode.
  //
  // Why the record must be released at all (roborev 60209): `acknowledgedIds` is derived from this
  // array and is what stops `noteCardsShown` opening a resolved episode. A record that never goes
  // suppresses every future receipt for that agent — so the release condition IS the correctness
  // property here, and two earlier attempts got it wrong in opposite directions:
  //
  //   • "left the red band" — the one-render lag. Acknowledging DE-ESCALATES the published status,
  //     so the agent reads `idle`/`stopped` the instant the reader clicks; releasing on that drops
  //     the record before it has done its job and re-opens the false-receipt bug.
  //   • "published `working`" — too narrow AND not safe (roborev 60221). Too narrow because a red
  //     epoch re-arms on ANY non-red status, so an `errored` blocker that is acknowledged, restarted
  //     and immediately asks again never passes through `working` — its second episode would earn no
  //     receipt, with no chip on screen to clear because a live blocker outranks its own snapshot.
  //     Not safe because an inherited-red HEAD republishes its own `working` the moment the
  //     transitive dismissal calms the descendant that lent it the red, so the chip would vanish one
  //     tick after the click — the exact opposite of "never vanishes".
  //
  // "SURFACED AGAIN" IS THE EPISODE BOUNDARY, and it needs no stamp of its own: this effect runs
  // only when the FEED changes, and the acknowledgement's own de-escalation is what removes the
  // agent from the surfaced set — so any later feed that surfaces it again is a genuinely new
  // episode, whatever route the status took. (A stamped acknowledgement feed was tried and removed:
  // the effect never runs against the feed the click happened on, so the comparison was always true
  // and the stamp did nothing — a mutation showed the whole suite green without it.)
  //
  // In an EFFECT rather than the view-model memo: this is a write, and a memo that sets state during
  // render is the loop that pattern is famous for. Guarded on a real change for the same reason.
  useEffect(() => {
    setAcknowledged((prev) => {
      // EVERY POPULATION THAT CAN PRODUCE A CARD, not just the row-owning one (roborev 60249-H1).
      // `surfacedAgents` is `topLevel`-filtered and `isTopLevelAgent` excludes every worker, but
      // `cardAgents` in the view model is `[cards, rowless.cards, strandedAgents]` — the last two
      // are by definition NOT top-level. Built from the narrow set, an acknowledged WORKER could
      // never re-enter `loud`, so its record was never released: `acknowledgedIds` suppressed its
      // receipts forever, and the chip that would have let the reader clear it is hidden while the
      // worker is red again. That is roborev 60209 exactly, re-created for the worker population.
      //
      // The PRE-digest populations, deliberately: digesting can withdraw a card while the agent is
      // still red, and releasing too readily only costs a receipt-suppression that should have
      // ended anyway. Under-releasing is the failure that lasts forever.
      const loud = new Set(
        [...surfacedAgents(feed), ...nestedRowlessAgents(feed), ...strandedAgents(feed)].map(
          (a) => a.id,
        ),
      );
      const known = new Set(allAgents(feed).map((a) => a.id));
      // Gone from the fleet goes too — its chip would name an agent nobody can open.
      const next = prev.filter((a) => known.has(a.id) && !loud.has(a.id));
      return next.length === prev.length ? prev : next;
    });
  }, [feed]);
  // Agents seen WORKING during the current away stretch — the recap's evidence that a finish was
  // real rather than an overlay repopulating (services/conciergeRecap.buildRecap sawWorking,
  // roborev 53669-M). Accumulated here because this effect is the only thing that observes the
  // MIDDLE of the stretch: the feed keeps updating while the window is blurred, whereas the
  // presence subscription only ever sees its two ends. Cleared at both edges by the recap effect.
  const sawWorking = useRef<Set<string>>(new Set());
  useEffect(() => {
    feedRef.current = feed;
    if (usePresenceStore.getState().mode !== "away") return;
    // `!a.rolledUpGreen`: a head whose `working` is only its SUBTREE's must not count as having
    // worked. Its status goes idle→working→idle purely because a worker ran, and `buildRecap` reads
    // that shape as the head finishing a job — so one unit of work came back as two "finished" rows,
    // the worker that did it and the orchestrator standing in for it (roborev 53886). The worker's
    // own entry is unaffected, so nothing is lost from the recap.
    for (const a of allAgents(feed)) {
      if (a.status === "working" && !a.rolledUpGreen) sawWorking.current.add(a.id);
    }
  }, [feed]);

  // The thread lives in a persisted store, not component state, so it SURVIVES AN APP RESTART
  // (spec §3 subsystem C2). `setChat` is the module-scoped setter imported above and keeps the same
  // signature, so every `setChat((prev) => …)` below is unchanged — see stores/conciergeThreadStore
  // for what reaches disk (conversation only; digests, nudges and the recap card are feed-derived).
  const chat = useConciergeThread();
  // What the thread's hidden live region says. Written ONLY with finished lines — a completed brain
  // reply, or a status notice — because a value that changed per streamed chunk would hand a screen
  // reader one announcement per delta, the flooding this region exists to avoid (roborev 53010).
  //
  // `{ seq, text }`, not a bare string (roborev 53392): every write must be a DISTINCT write, or an
  // identical repeat is invisible to both React and the assistive technology. See `announce` below.
  const [announcement, setAnnouncement] = useState<ConciergeAnnouncement>({ seq: 0, text: "" });
  /** Say this in the live region — even if it is word-for-word what was just said. The seq bump is
   *  the whole point: `setAnnouncement("Sent to X.")` twice in a row is an `Object.is`-equal
   *  setState React bails out of, so the second send to the same pinned agent was never announced
   *  at all (roborev 53392). Bumping a counter makes the state genuinely new; the column keys the
   *  rendered node on it so the DOM genuinely changes. */
  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => ({ seq: prev.seq + 1, text }));
  }, []);
  // "Copy on selection" (PRD 1 §1) — a PRESENTATION preference, so it lives in uiStore rather than
  // config.toml, and is READ HERE rather than in the column: nothing under components/Concierge
  // touches a store (see Concierge/types' header).
  const copyOnSelection = useUiStore((s) => s.conciergeCopyOnSelection);
  /** A copy landed. Spoken through `announce` — the column's ONE live region — and never from a
   *  second `aria-live` node inside the thread (roborev 52648/53010/53088). Through `announce`
   *  specifically, not `setAnnouncement`, because copying twice in a row is the ordinary case and
   *  an identical repeat must still be a distinct write (roborev 53392). */
  const onCopied = useCallback(
    (what: ConciergeCopyKind) => {
      // ONE LINE PER KIND, exhaustively — the whole reason `onCopied` carries a kind at all is that
      // a screen-reader user has no other way to tell which of the thread's copy affordances just
      // fired, and both sides of the conversation now have a button.
      const said: Record<ConciergeCopyKind, string> = {
        answer: "Answer copied to clipboard.",
        message: "Message copied to clipboard.",
        selection: "Selection copied to clipboard.",
      };
      announce(said[what]);
    },
    [announce],
  );
  const [typing, setTyping] = useState(false);
  /**
   * WHICH user bubble the in-flight turn belongs to, as STATE rather than only as
   * `awaitingBubbleRef`.
   *
   * The ref is the right tool for its own job — the orphan check reads it during a send and must
   * see the value synchronously — but a ref does not re-render, and the per-message status has to
   * MOVE to a new bubble when the user sends again. Kept beside the ref and written at the same
   * three points rather than replacing it, because the ref's synchronous read is load-bearing at
   * the send site and state would be stale exactly there.
   */
  const [awaitingId, setAwaitingId] = useState<string | null>(null);
  /**
   * The turn queue (sparkle-t8wsj). A REF plus mirrored state, and both are load-bearing: the send
   * path reads and writes it synchronously — two sends in the same tick must see each other, which
   * `useState` alone cannot guarantee — while the mirror is what re-renders the per-message status
   * when a message moves from waiting to working.
   */
  const turnQueueRef = useRef<TurnQueueState>(EMPTY_TURN_QUEUE);
  /** The delegation ladder's per-turn state (engine/conciergeDelegation). A ref, not state: it is
   *  folded from the live tool stream on every `concierge:tool` event and must never re-render. */
  const delegationRef = useRef<DelegationState>(initialDelegationState());
  const [turnQueue, setTurnQueue] = useState<TurnQueueState>(EMPTY_TURN_QUEUE);
  /** `dispatchTurn` through a ref: the send path calls it above its definition, and the turn-ended
   *  handlers call it from effects that must not re-subscribe when it changes identity. */
  const dispatchTurnRef = useRef<(entry: QueuedTurn) => void>(() => {});
  /** `drainQueue` through a ref, for the same reason `dispatchTurn` is: the brain subscription
   *  effect must keep its minimal dep array — re-subscribing mid-turn would drop the events still
   *  arriving for it — and `dispatchTurn` is defined below its own callers. */
  const drainQueueRef = useRef<() => void>(() => {});
  /**
   * Bubble ids that were NEVER handed to the brain — queued behind a running turn, or evicted at the
   * cap — so no reply may claim to have answered them.
   *
   * ══ A SET, NOT A LIVE READ OF THE QUEUE (roborev 58223-M1) ═══════════════════════════════════
   * The first cut asked `statusOf(turnQueueRef.current, id) !== "waiting"` at stamp time, and that
   * is defeated by the drain: `drainQueue` runs earlier in the same `done` handler and synchronously
   * promotes the next waiter from `waiting` to `running`, so by the time the anchors are stamped the
   * queued message reports "working" and the filter lets it through. The two fixes silently
   * cancelled — visible only on the no-delta path, where the reply's bubble is created in `done`.
   *
   * Recording membership at ENQUEUE is NOT by itself order-independent, and claiming it was is how
   * the second attempt failed: `dispatchTurn` DELETES the id, so a drain running before the stamp
   * retracted the flag just as surely as the live read did. What actually holds the property is
   * WHERE THE DRAIN RUNS — last in the `done` handler, after the reply has been stamped. This set
   * carries the fact; the drain's position is what stops it being retracted too early. Both are
   * required, and the ordering is asserted by a test rather than left to this comment.
   */
  const neverSentRef = useRef<Set<string>>(new Set());

  /**
   * The running turn ended — release the slot and start the next waiter, if any.
   *
   * A plain function on a ref rather than a `useCallback` dependency of the subscription effect:
   * that effect subscribes once for the life of the host, and giving it a changing identity would
   * tear down and re-establish the brain subscriptions on every render.
   */
  const drainQueue = useCallback(() => {
    const outcome = turnFinished(turnQueueRef.current);
    turnQueueRef.current = outcome.next;
    setTurnQueue(outcome.next);
    if (outcome.dispatch) dispatchTurnRef.current(outcome.dispatch);
  }, []);
  /**
   * Bumped on EVERY send — the turn-boundary signal for `useConciergeTurnFloor`.
   *
   * A counter rather than `awaitingId`, because not every send has a bubble: `relayFollowUp` and
   * the "Also ask Sparkle" replay both send with none, so two of those in a row would leave the id
   * at `null` and the boundary would never re-take (roborev 57914-M1). A counter cannot collide
   * with itself.
   */
  const [sendSeq, setSendSeq] = useState(0);

  /**
   * THE TURN BOUNDARY, and the "Reading your message" phase that opens it — the first thing the
   * column says about a turn, closing the gap between the send and the first tool call.
   *
   * KEYED ON THE SEND (`awaitingId`), not on the `typing` transition, because a send SUPERSEDES the
   * turn in flight rather than queueing behind it and therefore does not move `typing` at all
   * (roborev 57889-M1). The whole rule, and why it cannot live inline here, is in
   * services/conciergeTurnFloor — where a test can reach it.
   */
  const turnFloor = useConciergeTurnFloor(typing, sendSeq);

  // The mic is the dictation hook's now (CM-U9) — it owns armed state, the app-wide dictation
  // target and the live interim transcript, so there is no local micLive to keep in sync.
  const dictation = useConciergeDictation();
  const { registerInsert: dictationRegisterInsert } = dictation;

  // The brain text accumulated for the in-flight turn, keyed by turn id. Kept in a ref rather than
  // re-derived from the rendered thread so the done handler can announce the WHOLE reply into the
  // column's live region at once, rather than per streamed delta.
  const brainTextRef = useRef<Record<string, string>>({});
  // The surfaced-state digest each PUSH was authored against, keyed by its turn id — recorded when
  // the scheduler starts the turn, read when the turn's first event builds the bubble. Bounded for
  // the same reason services/concierge bounds its push-id memory: a turn that never produces an
  // event (webview reload, orphaned child) would otherwise leave an entry for the life of the page.
  const pushDigestRef = useRef<Map<string, string>>(new Map());
  const schedulerRef = useRef<ReturnType<typeof createProactiveScheduler> | null>(null);
  // The newest turn id seen from the brain stream, as a number (see supersededTurn below).
  const latestTurnRef = useRef(-1);
  // Every turn up to and including this id has been superseded by a send. See supersededTurn.
  const retireThroughRef = useRef(-1);
  // Set when a handoff that CHOSE Sparkle lands in the box (the capture window's Chat ❯), and
  // consumed by the next submit. The user already answered the question the auto-router exists to
  // guess at, so the router is skipped rather than allowed to overrule them — see `deliver`.
  // Retired by `onTextEdit` when the box is emptied by hand: a latch that outlived the words that
  // set it would aim an unrelated typed message.
  const forceSparkleRef = useRef(false);

  // The reply linter's policy, read from `[concierge.checks]` and refreshed on `config-changed`.
  //
  // A REF, not state: it is read inside the `concierge:done` handler and never rendered, so holding
  // it in state would re-run the subscription effect (and tear down the three event listeners) every
  // time an unrelated config key changed. It starts DISABLED so the window between mount and the
  // first `getConfig` resolving cannot lint against a policy nobody supplied.
  const lintPolicyRef = useRef<LintPolicy>(DISABLED_POLICY);
  /** The one reply currently held back by a blocking finding, or null. See {@link LintHold}. */
  const lintHoldRef = useRef<LintHold | null>(null);
  /**
   * Turn ids that may never again start a correction turn — every original that has already spent
   * its retry, and every correction turn itself.
   *
   * ══ ONE RETRY. EVER. ══════════════════════════════════════════════════════════════════════════
   * A correction can itself be blocked, and re-prompting THAT is an unbounded loop paid for in
   * model quota — the worst possible failure of this feature, and the one it would be easiest to
   * ship by accident. Two independent things stop it: the correction path never calls the hold
   * branch at all (its exit is `settleHold`), and this set makes a second hold on either id
   * impossible even if a later edit routes a correction back through the main path.
   */
  const lintRetriedRef = useRef<Set<string>>(new Set());
  /**
   * Correction turns whose hold gave up on them while they were still alive — every event they
   * emit from that moment is dropped on the floor.
   *
   * `isCorrectionTurn` is derived from `lintHoldRef`, and giving up CLEARS that ref, so without
   * this set an abandoned correction stops being recognised and falls through to the ORDINARY
   * render path. It is also the newest id the stream has seen, so `supersededTurn` waves it
   * through. The concrete failure (roborev 58805): the backstop fires at 90s and renders the held
   * original, then the still-streaming correction paints its own bubble and `done`s into a second
   * answer — to a prompt the user never sent — appended under the reply it was meant to replace.
   */
  const lintSilencedRef = useRef<Set<string>>(new Set());
  /** `settleHold` through a ref, so `dispatchTurn` — defined outside the brain subscription — can
   *  end a hold before its own turn supersedes the correction. Same shape as `drainQueueRef`. */
  const settleLintHoldRef = useRef<(why: string) => void>(() => {});
  // The last reply the concierge produced, for `restated-state` to compare against. Held here rather
  // than read back out of the thread store because the store holds RENDERED messages — including
  // receipts and restores — and the check's corpus is specifically the previous BRAIN reply.
  const prevReplyRef = useRef<string | null>(null);

  // The compose box's own insert fn, kept so a send that dies AFTER the box already cleared can put
  // the user's words back. See `restoreDraft`.
  const insertRef = useRef<((text: string, opts?: { verbatim?: boolean }) => void) | null>(null);

  /**
   * Put a draft back in the compose box.
   *
   * Arming changed WHEN the box clears relative to when a send actually lands. `deliver` now
   * resolves true the moment an intent is armed, so ComposeBox has cleared long before a countdown
   * is cancelled or its delivery fails — its own "onSend resolved false → restore" path can no
   * longer cover either case, and without this the user silently loses what they typed.
   *
   * Best-effort by construction: an unmounted box simply drops it, and the words are still visible
   * in the thread bubble regardless. Takes the TYPED text, never the payload — restoring quoted
   * attachment temp paths into the box would be the leak roborev 46911/46925 removed.
   */
  // ══ SELECTION-TO-QUOTE, the two refs the restore path needs ═══════════════════════════════════
  // The quote API itself is created further down, where `draftKey` is known (it is keyed per
  // conversation). These refs let the callbacks defined ABOVE that point reach it without hoisting
  // `draftKey` — the same ref-indirection `insertRef` uses one function up.
  const quoteRef = useRef<ConciergeQuoteApi | null>(null);

  // `sentQuote` is REQUIRED, not optional, and that is the guard rather than a style choice: this
  // defect has now been fixed at three different call sites (roborev 59801/59803/59804), each time
  // because some path reached the restore without the sending context. A required parameter makes
  // the compiler ask the question at every call site — `null` is a deliberate "this send carried no
  // quote", which an omitted argument would not be.
  const restoreDraft = useCallback((text: string, sentQuote: SentQuote | null): boolean => {
    if (text.trim() === "") return false;
    // VERBATIM: this is the user's own message coming back, and the box's ordinary insert path is
    // the DICTATION one, which trims. A restored body that contains a collapsed paste would arrive
    // dedented and short its trailing newline (roborev 55793).
    const insert = insertRef.current;
    if (!insert) return false;
    insert(text, { verbatim: true });
    // AND THE QUOTE THAT RODE **THIS** SEND — an argument, exactly like `text` beside it, never a
    // shared slot (roborev 59804). A restored draft that lost its quote is a message the founder has
    // to go re-select the fragment for, which is the same class of silent loss the attachments
    // restore above exists against.
    //
    // A ref could not be correct here however carefully it was written, because several sends can be
    // outstanding at once: `armIntent` keeps a MAP of armed intents, and one held while the founder is
    // Away survives until he returns. A single slot is overwritten by every send in between, so
    // cancelling the older intent would restore the NEWER send's quote — re-staging a fragment that
    // has already gone out, `sourceId` and all — or, in the mirror case, restore nothing and drop the
    // older one silently. Capturing the *binding* per send fixed which DRAFT was written; only
    // passing the quote itself fixes which QUOTE.
    //
    // Conditional on the send having carried one: `restore(null)` is a WRITE that empties the slot,
    // so firing it unconditionally would wipe a quote staged for the NEXT message just because this
    // quote-less send was cancelled.
    if (sentQuote?.quote && !sentQuote.restore(sentQuote.quote)) {
      // DECLINED: the founder selected a quote of his own while this send was armed, and his choice
      // stands (see `useConciergeQuote.restore` — a decline can ONLY mean that now). This send's
      // fragment is therefore gone, recorded rather than dropped in silence, because the restored
      // TEXT is now sitting against his newer quote and a Send without looking would pair these
      // words with a different passage's `sourceId`. Both are on screen, so it is a papercut rather
      // than a hidden misdelivery; telling him in the UI is bead sparkle-ojhnt.
      //
      // BOTH ids are logged: the dropped one alone cannot tell you what the composer actually ended
      // up paired with, which is the question anyone reading this line is asking (roborev 59808).
      log.warn("composer", "cancelled send's quote not restored — the user staged a newer one", {
        droppedSourceId: sentQuote.quote.sourceId,
        keptSourceId: quoteRef.current?.peek()?.sourceId ?? null,
      });
    }
    // RETURNS WHETHER THE WORDS ACTUALLY GOT BACK, which `retractSend` needs (bead sparkle-k5kit).
    // This used to be `void` and best-effort, and the doc above leaned on the thread bubble as the
    // backstop for the drop. A refused send now RETRACTS that bubble, so the backstop and the thing
    // being retracted are the same object: retracting unconditionally would turn "best-effort" into
    // "silently lost". The caller retracts only on `true`.
    return true;
  }, []);

  /**
   * TAKE BACK the optimistic "you" bubble for a send that was REFUSED.
   *
   * ══ WHY A REFUSED SEND MUST NOT LEAVE ONE (bead sparkle-k5kit part 2) ═══════════════════════════
   * `send` appends the bubble SYNCHRONOUSLY, before routing, and that is deliberate — queuing it left
   * a second rapid send with no visible state at all. The cost is that a refusal arrives after the
   * bubble is already on screen, and the refusal path also puts the words back in the composer. So
   * the founder saw his paragraph in TWO places at once: quoted in the thread as though it had been
   * sent, and sitting in the box as though it had not.
   *
   * His words: *"It's also not clearing what I sent out of the Compose box even though it shows up in
   * the Concierge list."* Both halves are one bug. A message that is simultaneously "back in the box"
   * and shown as sent is the worst of both, and it is how he ends up sending the same thing twice.
   *
   * The refusal is still SAID — `terminalRefusalLine` posts a Sparkle-authored line into the thread,
   * and `noteMounted` puts it on the mounted column's notice row. Those are explanations, which is
   * the right shape; the "you" bubble is a RECORD OF A SEND, and no send happened.
   *
   * The receipt goes with it: a receipt annotates a bubble, so it has nothing to attach to once the
   * bubble is gone. That does not re-open roborev 57360 (the two refusal instants must tell the same
   * story) — they still do, because BOTH instants now retract, and both still post the line.
   *
   * Also drops the three remembered renderings. `redirect` replays them, and the button that would
   * have triggered it lived on the bubble — so leaving them is a leak whose only reachable effect
   * would be replaying a message the user was told was not sent.
   */
  const retractSend = useCallback((messageId: string) => {
    setChat((prev) => prev.filter((m) => m.id !== messageId));
    sentTextRef.current.delete(messageId);
    sentPayloadRef.current.delete(messageId);
    sentWireRef.current.delete(messageId);
  }, []);

  const registerInsert = useCallback(
    (append: ((text: string) => void) | null) => {
      insertRef.current = append;
      // NOT the place to retire `forceSparkleRef`, tempting as a null-append looks (roborev 53836).
      // `null` here does NOT mean "the box unmounted" — ComposeBox's effect re-runs on any identity
      // change of this callback, and its cleanup fires first, so a LIVE re-registration arrives as
      // null → non-null (see useConciergeDictation.registerInsert, which documents exactly that
      // sequence). The capture-Chat aim is set ONCE and never again, so clearing it here silently
      // broke Chat mode outright. It is retired from `onTextEdit` instead — the one signal that
      // fires on a real hand edit and not on a re-registration.
      //
      // The dictated-origin latch that used to be cleared here went with voice OUTPUT in §5: with
      // nothing speaking replies back, this host has no reason to know a turn was dictated.
      dictationRegisterInsert(append);
    },
    [dictationRegisterInsert],
  );

  // The capture-Chat aim is retired the moment the user empties the box BY HAND. Emptying it is the
  // user starting over, and the message they type next has nothing to do with the screenshot they
  // discarded — routing it to Sparkle on the strength of a retired handoff would aim a message the
  // user never aimed. Only hand edits report here; a dictated segment does not (see registerInsert).
  const onTextEdit = useCallback((text: string) => {
    if (text.trim() === "") forceSparkleRef.current = false;
  }, []);

  // Files staged for the NEXT send (parity row #21): the compose box's attach buttons, and a file
  // dropped on the box. The four handlers are stable, so the controller memo below can depend on
  // them; only `attachments`/`dropActive` change per render.
  const {
    attachments,
    dropActive,
    attachNotice,
    dismissNotice: dismissAttachNotice,
    attach,
    attachPaths,
    attachReady,
    remove: removeAttachment,
    take: takeAttachments,
    restore: restoreAttachments,
  } = useConciergeAttachments();
  // The agent a send could reach RIGHT NOW, dropped when it no longer exists (closed, deleted, its
  // project removed). The feed carries every project's every agent, so absence from it IS "no
  // longer exists" — routing at a corpse would report a delivery that never happened. Derived
  // rather than cleared in an effect: an effect would paint one frame with the dead target still
  // live, and a send in that frame would route at it.
  //
  // Resolved live at send time, NOT pinned. Pinning was the toggle's job: the user flipped it at a
  // moment they chose, so the aim had to be frozen then. With inference there is no such moment —
  // the message is about whatever the user is looking at when they press Send, which is exactly
  // what promptTarget tracks. The aim is still captured SYNCHRONOUSLY at submit (see `send`), so
  // nothing that moves the selection while a send is queued can redirect it.
  const target = useMemo(
    () =>
      promptTarget && isPromptableTarget(feed, promptTarget.agentId) ? promptTarget : null,
    [promptTarget, feed],
  );
  // What a send may be ROUTED at: the shown agent only (see promptTargetShown). The suggestions row
  // below keys off `target` instead, because its engine must keep running off-screen.
  const routingTarget = promptTargetShown ? target : null;
  // Latest target for the handlers, which are memoized on stable deps and run after render (same
  // pattern as feedRef above).
  const targetRef = useRef(routingTarget);
  useEffect(() => {
    targetRef.current = routingTarget;
  }, [routingTarget]);

  // ══ THE MOUNTED AGENT'S OWN CONVERSATION ══════════════════════════════════════════════════════
  // When the cable is patched to a build agent, the column stops showing the Sparkle conversation and
  // shows THAT AGENT'S — read from the session transcript Claude Code already writes.
  //
  // THIS DELIBERATELY STAYS OUT OF `send`/`deliver`. Routing (where a message GOES) is owned
  // elsewhere and actively worked on; this decides only what the pane SHOWS. The two features meet at
  // exactly one fact — which agent is mounted — and that fact is already computed above, so this
  // reads it and adds nothing to the routing path.
  //
  // Gated on `wired`, not on `target` alone: `target` is non-null whenever the founder has an agent
  // selected, mounted or not, and swapping the thread for an UNMOUNTED selection would replace the
  // Sparkle conversation during ordinary use — the same bug as today's, pointing the other way.
  const mountedAgentId = wired !== "off" ? (target?.agentId ?? null) : null;
  // The worktree is what keys the transcript (Claude Code stores sessions per encoded worktree path,
  // not per agent id). Taken from the roster row the app itself wrote when it CUT the worktree — no
  // id-to-path guessing, and nothing a model said.
  //
  // A SUBSCRIPTION, not a `getState()` read. `worktreePath` is written when the worktree is CUT
  // (projectStore.setAgentWorktree), which for a freshly spawned agent happens after the row already
  // exists — so a one-shot read memoized on the agent id would capture `null` and never see the path
  // arrive, and that agent's transcript would stay permanently unreadable until something unrelated
  // re-rendered this host. The selector returns the AGENT OBJECT, so this wakes when that one agent
  // changes rather than on every write anywhere in the project store.
  const mountedRow = useProjectStore((s) =>
    mountedAgentId
      ? s.projects.flatMap((p) => p.agents).find((a) => a.id === mountedAgentId)
      : undefined,
  );
  // ══ …AND THE ONE MOUNTABLE AGENT THAT HAS NO ROW (bead sparkle-gw8yi) ═══════════════════════════
  // The scan above IS the roster, and the app-owned Improve-Sparkle agent is deliberately never in it
  // (services/knownAgents' header). So `mountedRow` came back `undefined` for the one agent whose row
  // the founder had just clicked, `mountedAgent` below stayed null, and the column went on rendering
  // the SPARKLE CONVERSATION with the cable lit — his report, verbatim: *"when I clicked on the
  // Improve Sparkle Build Agent, it showed a mounted version of Concierge content, which is wrong."*
  // The mount was real (the cable is patched, and the send path routes at it); only the DISPLAY could
  // not see it, which is the mount lying about where he is.
  //
  // TWO FACTS, FROM THE TWO PLACES THAT HOLD THEM, rather than a synthesized `AgentTab`: the NAME is
  // a constant (`SPARKLE_AGENT_NAME`), and the WORKTREE is what `SparkleAgentPane.prepare()` writes
  // to the transcript registry — the same worktree the concierge's own read chain resolves this
  // agent's transcript from (services/sparkleTranscript tier (d)). Faking a row would put a second,
  // partial answer to "what is this agent" in a file that already has one.
  //
  // `isSparkleAgentId` and not `findKnownAgent`: this is not asking whether the id is addressable
  // (that question is `deliver`'s, and it is asked against the live store at send time). It is asking
  // which of two places to read a name and a worktree from, and only the namespace decides that.
  const mountedIsSparkle = !!mountedAgentId && isSparkleAgentId(mountedAgentId);
  const sparkleWorktreePath = useSyncExternalStore(
    subscribeAgentTranscriptWorktrees,
    () => (mountedIsSparkle ? (agentTranscriptWorktree(mountedAgentId!) ?? null) : null),
  );
  // ══ A ROUTABLE MOUNT ALWAYS HAS A NAME — THE FALLBACK BELONGS HERE, NOT AT ONE CONSUMER ════════
  // The third `??` is the whole of roborev 59232, and it is at the SOURCE deliberately. Without it
  // `mountedName` is `undefined` for a mounted, routable agent that has no `projectStore` row and is
  // not the app-owned Sparkle one — a state bead `sparkle-gw8yi` records the app actually producing
  // — and `undefined` there does not degrade one label, it silently unmounts the whole column:
  //
  //   • `mountedAgent` (gated on `mountedAgentId && mountedName`) goes null, so `ConciergeColumn`
  //     drops the "Chatting with ● <Agent>" chip AND renders the SPARKLE conversation…
  //   • …while `send` still aims at that agent's PTY, because routing reads `mountedAgentId`, which
  //     is non-null throughout;
  //   • and the composer's `draftKey` falls back to `"concierge"` while this file stashes and
  //     restores attachments under `agent:<id>`, so the draft and its files part company.
  //
  // That is the founder's original defect exactly — the pane says one thing, the words go somewhere
  // else — so fixing it at `railTargetName` alone (the first cut) left the lie standing on every
  // surface but the rail. `target` is what `mountedAgentId` is derived from and
  // `ConciergePromptTarget` requires `name`, so this resolves whenever the mount routes. Gated on
  // `mountedAgentId` so an UNMOUNTED selection cannot lend its name to a mount that does not exist.
  const mountedName =
    mountedRow?.name ??
    (mountedIsSparkle ? SPARKLE_AGENT_NAME : undefined) ??
    (mountedAgentId ? target?.name : undefined);
  const mountedWorktreePath = mountedRow?.worktreePath ?? sparkleWorktreePath;
  const mountedThread = useMountedThread(mountedAgentId);
  const { pageBack } = useAgentTranscript(mountedAgentId, mountedWorktreePath ?? null);
  // STAGED ATTACHMENTS FOLLOW THE DRAFT THEY WERE STAGED FOR.
  //
  // `ComposeBox.draftKey` swaps the typed text when the conversation changes, but attachments are
  // HOST-owned and global, so without this a screenshot staged for Sparkle stayed staged when the
  // founder mounted an agent — and `canSend` is true on attachments alone, so one Enter delivered
  // the other conversation's file to the agent. That is precisely the harm keyed drafts exist to
  // prevent, and it lives here because only the host can move this state.
  //
  // STASHED, NOT CLEARED. `take()` already returns-and-clears and `restore()` puts a list back — the
  // pair the failed-send path uses — so the founder's staged file is waiting for them when they
  // come back to that conversation rather than silently thrown away.
  const attachmentStashRef = useRef<Map<string, Attachment[]>>(new Map());
  const draftKey = mountedAgentId ? `agent:${mountedAgentId}` : "concierge";
  const prevDraftKeyRef = useRef(draftKey);
  useEffect(() => {
    const previous = prevDraftKeyRef.current;
    if (previous === draftKey) return;
    prevDraftKeyRef.current = draftKey;
    const carried = takeAttachments();
    if (carried.length > 0) attachmentStashRef.current.set(previous, carried);
    const waiting = attachmentStashRef.current.get(draftKey);
    if (waiting && waiting.length > 0) {
      attachmentStashRef.current.delete(draftKey);
      restoreAttachments(waiting);
    }
  }, [draftKey, takeAttachments, restoreAttachments]);

  // THE STAGED QUOTE, keyed by the same `draftKey` the composer keys its text on. It needs no stash
  // effect like the attachments above: `useConciergeQuote` holds one quote PER KEY rather than a
  // single slot, so switching conversations already leaves each one's quote where it was staged.
  const quoteApi = useConciergeQuote(draftKey);
  // Published for the callbacks defined above this point (see `quoteRef`'s declaration). Assigned
  // during render on purpose and idempotently — the value is a stable object from a memo, and the
  // consumers are event callbacks that cannot run before this line has.
  quoteRef.current = quoteApi;

  // ══ THE MOUNT THAT ROUTES *IS* THE MOUNT THE COLUMN NAMES — ONE VALUE, UNGATED ═════════════════
  // The founder's rule, which supersedes the `promptTargetShown` gate that used to stand here:
  // *"It should be sending it to the build agent unless I @mention Sparkle."*
  //
  // WHAT THE GATE DID. This was `promptTargetShown ? mountedAgentId : null`, and `Workspace` sets
  // `promptTargetShown = sparkleActive ? sparkleOpen : !boardActive && activeIsOpen` — false whenever
  // the Plan board or the Improve-Sparkle pane is up, the agent's tab is closed, or (the cross-pair
  // case, since `promptTarget` follows the CABLE via `wiredProject` while this predicate reads the
  // RIGHT column) the cable is patched LEFT while the right column is on its board. In every one of
  // those states the cable is still patched, so the column kept drawing "Chatting with ● <Agent>" and
  // kept the agent's transcript swapped in — while the send fell through to the concierge and posted
  // *"Asked Sparkle — press Esc to unmount and read the reply."* The founder screenshotted the two
  // sentences stacked in one frame. Silently delivering his words to a recipient he did not choose is
  // the most expensive failure this file can have, and it is worse than any refusal.
  //
  // WHY UNGATING IS SAFE, not merely mandated. The gate existed to stop an imperative typed while
  // looking at the Plan board from being written into a terminal the founder cannot see. That hazard
  // is caught ONE LAYER DOWN and caught better: `terminalWriteBlocked` treats a `no-viewport` read as
  // FATAL for a `mount` (see its header — "I cannot read that screen" is not a normal state for a
  // mount), so a send at an unmounted or unreadable pane is REFUSED, the reason is named on the
  // mounted notice row, and the words go back in the box. The gate was a redundant SILENT pre-guard
  // in front of a visible one; deleting it loses no protection and costs no message.
  //
  // WHAT STILL GATES ON `promptTargetShown`: the UNMOUNTED inference path (`routingTarget`, which is
  // what `routeMessage` is told about the agent on screen) and the suggestions row's visibility.
  // Those are inferences from what the user is looking at, and an inference genuinely must not aim at
  // an off-screen pane. A MOUNT is not an inference — it is a gesture the user made and the column
  // reports back to them — which is the same distinction `Concierge/composerRoute`'s header draws
  // between a heuristic verdict and a user gesture. Do not re-gate this on a surface predicate.
  //
  // So one value now answers all three questions that must agree — the send path through
  // `mountedAgentIdRef`, the composer's typeface through the prop the column hands down, and the
  // "Chatting with" chip — and the state where the header named an agent and the words went
  // elsewhere is no longer representable.
  const routableMountedAgentId = mountedAgentId;
  // `send` is memoized on stable deps and runs after render, so it reads this through a ref exactly
  // as it reads the aim through `targetRef` — and for the same reason: the value has to be the one
  // that was true AT SUBMIT. Re-reading a live store inside the queued half would route a message at
  // whatever the founder mounted while it was waiting, which is the misdelivery every other
  // captured-at-submit value in this file exists to prevent.
  const mountedAgentIdRef = useRef(routableMountedAgentId);
  useEffect(() => {
    mountedAgentIdRef.current = routableMountedAgentId;
  }, [routableMountedAgentId]);
  // ══ AND THE MOUNT'S FULL TARGET, WHICH HAS TO BE UNGATED FOR THE SAME REASON ═══════════════════
  // `send`'s `mountRouted` cross-check needs the projectId and name of the terminal it is aiming at,
  // and it used to read them from `targetRef` — that is `routingTarget`, the value `promptTargetShown`
  // STILL gates. Ungating the mount id above while cross-checking it against a gated target would
  // have left the founder's bug exactly where it was, one identifier over: the id would resolve, the
  // cross-check would fail against `null`, and the message would fall through to the concierge again.
  //
  // Derived from the very same `target` that `mountedAgentId` is derived from, so the two cannot
  // disagree about which agent is mounted. That is the property the old comment claimed for
  // `targetRef`, and it only held while both values were gated the same way.
  const mountTarget = mountedAgentId ? target : null;
  const mountTargetRef = useRef(mountTarget);
  useEffect(() => {
    mountTargetRef.current = mountTarget;
  }, [mountTarget]);
  // ══ THE *DISPLAY* MOUNT, WHICH IS THE ONE THE NOTICE ROW KEYS OFF (roborev 57424) ══════════════
  // The notice row exists for exactly one reason — `ConciergeThread` is not rendered while mounted,
  // so anything said with `postSparkle` is off screen — and whether the thread is hidden is decided
  // by the DISPLAY mount (`mountedAgent`, which the column keeps ungated). Gating these writes on the
  // ROUTING mount instead produced two failures, and they are why the split was introduced:
  //
  //   • DISPLAY-MOUNTED BUT NOT ROUTABLE (the Plan board or Improve-Sparkle up, or the tab closed):
  //     the thread is still swapped away, the message falls through to Sparkle, Sparkle answers into
  //     the hidden thread — and the notice was suppressed because the routing id is null there. That
  //     is the very defect this row was added to fix, reintroduced one state over.
  //   • NOT MOUNTED AT ALL: the two refusal writes were unconditional, so an ADDRESSED send refused
  //     with the cable unplugged painted a banner in a column whose thread is perfectly visible —
  //     saying the same thing a third time — and it could never clear, because the clearing effect
  //     keyed on a routing id that stays `null` throughout. A stale "Not sent" row for the rest of
  //     the session, sitting over later successful sends.
  //
  // ══ AND AS OF THE MOUNTED-SEND FIX, THE TWO MOUNTS HOLD THE SAME VALUE ═════════════════════════
  // This used to end "routing and the typeface take `routableMountedAgentId`; the notice takes this",
  // and that distinction is GONE: `routableMountedAgentId` is now `mountedAgentId` unmodified, so
  // this ref and `mountedAgentIdRef` mirror one value. Both are kept because their NAMES are the
  // documentation at ~12 call sites — "is the thread hidden" and "where do the words go" are still
  // two different questions, and a reader at either call site should not have to know they currently
  // share an answer.
  //
  // WHAT MUST NOT HAPPEN IS THE TWO DRIFTING APART AGAIN. The first bullet above is precisely the
  // founder's bug seen from the notice's side: the split existed because routing was gated and
  // display was not, and the response at the time was to make the NOTICE tell him about the
  // divergence rather than to remove it. If you find yourself narrowing either of these with a
  // surface predicate, you are re-opening "the header names an agent and the send goes elsewhere" —
  // read `routableMountedAgentId` above first.
  const displayMountedRef = useRef(mountedAgentId);
  useEffect(() => {
    displayMountedRef.current = mountedAgentId;
  }, [mountedAgentId]);
  // …AND ITS NAME, so the notice can say WHO DID NOT GET the message and not only who did.
  //
  // From `mountedName` — the very value the "Chatting with ● <Agent>" chip renders — rather than from
  // `target.name`, and that is the whole point: a notice naming an agent the chip does not would
  // reintroduce the header-disagrees-with-the-truth defect this branch exists to remove, in one line
  // of prose instead of in the router.
  const displayMountedNameRef = useRef(mountedName);
  useEffect(() => {
    displayMountedNameRef.current = mountedName;
  }, [mountedName]);
  // The mounted column's notice row — state, writer and the release effect that retires a notice
  // with the mount it describes — in one hook (hooks/useMountedNotice). CALLED HERE, where the
  // release effect used to be declared rather than where the state was: that keeps the effect at its
  // exact position among this component's effects. Nothing between the old two positions reads
  // `mountedNotice` or calls `noteMounted`, so nothing moves relative to its producer.
  const { mountedNotice, noteMounted } = useMountedNotice(mountedAgentId);

  // Gated on the NAME rather than on the row, because a name is what this needs and the roster is
  // only one of the two places one can come from (see `mountedName`). Keeping `mountedRow` as the
  // gate is what made the app-owned agent unmountable in the column while being mounted everywhere
  // else.
  // ══ THE CHIP'S DOT IS LIVE, NOT A SNAPSHOT (bead sparkle-wj3ya) ═══════════════════════════════
  // A SUBSCRIPTION, deliberately, not `useRuntimeStore.getState()`. The bead is explicit: *"The dot
  // must reflect LIVE state, not the state at mount time. An agent that goes red while he is
  // composing should show red."* A one-shot read would paint the status the agent had when the
  // cable was patched and then never move — which is worse than no dot, because a stale green over
  // an agent that has stopped and needs him is an indicator that lies in the reassuring direction.
  //
  // Selected down to the ONE agent's status rather than the whole map, so this re-renders when that
  // agent changes rather than on every status write anywhere in the fleet.
  const mountedStatus = useRuntimeStore((s) =>
    mountedAgentId ? s.status[mountedAgentId] : undefined,
  );
  const mountedAgent = useMemo<ConciergeMountedAgent | null>(
    () =>
      mountedAgentId && mountedName
        ? {
            agentId: mountedAgentId,
            name: mountedName,
            thread: mountedThread,
            onReachTop: pageBack,
            status: mountedStatus,
          }
        : null,
    [mountedAgentId, mountedName, mountedThread, pageBack, mountedStatus],
  );

  // ══ @-MENTIONS ═══════════════════════════════════════════════════════════════════════════════
  // Who the compose box's "@" picker may offer, and — the same list, which is the point — the roster
  // a typed mention is RESOLVED against. One list, so an agent that is offerable and an agent that
  // is addressable can never be two different populations.
  //
  // DECLARED ABOVE THE RAIL rather than below it, because the rail's own label is derived from this
  // list now (see `railTargetName`). Physical order in a component body is a real dependency edge.
  //
  // UNORDERED AND UNLABELLED, deliberately: `ComposeBox` runs `mentionRoster` on this once and uses
  // the result for its picker, its resolve and its Backspace alike. This host briefly did the
  // ordering instead, on a contract stated in a comment — which is not a contract (roborev 54555),
  // and it left the consumer free to resolve against a list that had skipped the step. Ordering and
  // duplicate-name labelling belong at the single place that turns text into an aim.
  //
  // EVERY agent in the feed, including the ones that cannot take a message: the picker lists those
  // disabled with a reason rather than hiding them, because "no such agent" and "that one is a
  // cloud agent" are different answers. `canAcceptInput` here is a snapshot for the LIST; the
  // authoritative check is the one `deliver` makes at send time against the live store.
  const mentionAgents = useMemo(
    () =>
      allAgents(feed).map((a) => ({
        id: a.id,
        name: a.name,
        projectId: a.projectId,
        projectName: a.projectName,
        band: a.band,
        since: a.since,
        canAcceptInput: agentCanAcceptPrompt(a.id),
      })),
    [feed],
  );
  // …and the same list for the handlers, which are memoized on stable deps and run after render
  // (the feedRef/targetRef pattern above). `send` resolves a mention off this rather than closing
  // over a render-time value, so a message submitted after the fleet changed resolves against the
  // fleet as it is NOW.
  const mentionAgentsRef = useRef(mentionAgents);
  useEffect(() => {
    mentionAgentsRef.current = mentionAgents;
  }, [mentionAgents]);

  // ══ THE AUTO-SEND RAIL (PRD 1 §4) ════════════════════════════════════════════════════════════
  // The tray's POSITION is a persisted presentation preference, read here rather than in the column
  // for the same reason `copyOnSelection` is: nothing under components/Concierge touches a store.
  // `useSendMode` also drives the MICROPHONE from that position and owns the push-to-talk hold, so
  // the tray and the mic glyph cannot end up telling different stories about the same microphone.
  // It is declared BELOW `composerSubmitRef`, since a push-to-talk release sends through it.
  // What the compose box currently holds, whatever wrote it. The box owns the text; the rail needs
  // to see it to pick a tier, and dictated text is the only kind it ever fires on.
  const [composedText, setComposedText] = useState("");
  const onComposedText = useCallback((t: string) => setComposedText(t), []);

  // The compose box hands us its own submit, so an expired countdown fires the SAME path the button
  // does — clearing the box, resolving mentions, restoring the draft on failure. Sending the text
  // from out here instead would leave the words sitting in the textarea behind the message.
  const composerSubmitRef = useRef<(() => boolean) | null>(null);
  const registerSubmit = useCallback((fn: (() => boolean) | null) => {
    composerSubmitRef.current = fn;
  }, []);

  // THE TRAY. A push-to-talk RELEASE sends through the box's own submit for exactly the reason the
  // countdown does (above): sending from out here would leave the dictated words sitting in the
  // textarea behind the message they were supposed to be.
  //
  // A RELEASE IS A SEND, FULL STOP — it is `submit`, the same call the Send button makes, and it is
  // made on EVERY clean release rather than only on the ones that produced a transcript. Letting go
  // of the talk key means "send this message"; what the message turns out to be made of is the box's
  // business. So all three of these are one path, not a case and two edge cases:
  //   spoke only  → the box holds the transcript dictation inserted, and that goes out;
  //   typed only  → a silent hold sends the typed draft, exactly as pressing Send would (⌘↩ sends it
  //                 here too since sparkle-u81cz, so the hold is one of two paths, not the only one);
  //   both        → `submit` sends what the box holds, which is the typed text with the transcript
  //                 appended after it (ComposeBox's `append` adds dictated segments at the caret,
  //                 which follows the text) — the typed words were there first, so they lead.
  // useSendMode's `endHold` owns the one thing that is NOT the box's business: not calling this
  // until the words he just spoke have finished arriving.
  const sendTray = useSendMode({
    onSend: useCallback(() => composerSubmitRef.current?.() ?? false, []),
  });

  /**
   * True only for the instants inside an auto-fire.
   *
   * Both paths reach `send` through the box's submit, so without this the rail's own fire would
   * look like a manual press and cancel the countdown it is currently completing. Set and cleared
   * synchronously around the call — `submit` invokes `onSend` synchronously, so nothing else can
   * interleave.
   */
  const autoFiringRef = useRef(false);

  /**
   * WHO THE RAIL SAYS THIS MESSAGE IS FOR — derived from the COMPOSE BOX'S OWN TEXT, and from
   * nothing else.
   *
   * ══ THE BUG THIS REPLACES ══════════════════════════════════════════════════════════════════════
   * This was `routingTarget?.name ?? "Concierge"`: the build agent whose pane happens to be on
   * screen. That is an INHERITED target — the user never chose it, they just navigated. The user was
   * answering the concierge's own design questions in this box while a build agent's pane was up,
   * and their answers went into that agent's terminal; they noticed only because the concierge's
   * replies stopped making sense. The rail is the surface that was supposed to warn them, and it was
   * naming the wrong destination confidently, because it read the same inherited target the misroute
   * came from. With auto-send armed that is worse still: an inherited target plus a countdown means
   * dictated speech reaches a PTY with no deliberate act at all.
   *
   * The router half of the fix is in services/conciergeRouter (it can no longer return `agent` at
   * all), so the only two things that can aim a send at a terminal are an explicit `@Name` in the
   * text and the CABLE — a MOUNT, which is a gesture the user made and the column reports back to
   * them, never an inherited target. This is that same fact, rendered.
   *
   * ══ THE CONTRACT ═══════════════════════════════════════════════════════════════════════════════
   * THE LABEL AND THE DESTINATION MUST BE COMPUTED THE SAME WAY, or the rail goes back to lying —
   * quietly this time, since a label that is merely stale looks identical to a correct one. So this
   * does not restate the rule, it CALLS it: `classifyComposerRoute`, the same pure function `send`
   * routes by, over the same inputs. Mentions resolve exactly as the send resolves them —
   * `mentionRoster(mentionAgents, preferredAgentId)` over the SAME two inputs `ComposeBox` is handed
   * below (its `mentionAgents` / `preferredAgentId` props), then `scanMentions` over the live text —
   * and the mount handed in is the one `send` reads through `mountedAgentIdRef`. If you change
   * either input here, change it in the JSX below too.
   *
   * `scanMentions` rather than `mentionsIn` is not a detail: `mentionRoster` returns the SAME object
   * to both this memo and `ComposeBox`, and the scan is cached on that object plus the text, so the
   * rail's reading of a draft and the composer's are one computation. Sharing the reading is also
   * what makes "the label and the destination are computed the same way" structural rather than a
   * pair of calls that happen to agree.
   *
   * THE BUG THAT MADE THIS A SHARED CALL RATHER THAN A SECOND COPY OF THE RULE: while mounted, a
   * plain message goes to the mounted agent's terminal, and this said "Concierge" — so the founder
   * dictated hands-free, read "Sending to Concierge shortly", let it fire, and his words went to a
   * PTY. That is the original damage above with the destinations swapped. Deriving the label from
   * the verdict also retired a second disagreement for free: a name that does not LEAD is the
   * sentence's SUBJECT, so "why is @Kraken Auth just sitting there?" no longer announces Kraken
   * Auth over a message the send delivers elsewhere.
   *
   * The mention's `name` is the ADDRESS the user typed, which for two same-named agents is the
   * disambiguated `@Docs (web)` rather than a bare "Docs" that names neither (Concierge/mentions,
   * `withMentionLabels`). Naming the destination ambiguously is exactly the failure this rail exists
   * to catch, so it shows the address.
   */
  //
  // ══ THE ROSTER IS NOT A FUNCTION OF THE DRAFT, SO IT IS NOT REBUILT PER CHARACTER ══════════════
  // This used to sit INSIDE the memo below, whose deps necessarily include `composedText`. So every
  // keystroke re-ran `orderMentionAgents` — a full sort of the fleet with a `matchScore` per agent —
  // and `withMentionLabels` — another full pass plus a Map — to produce a list that had not changed,
  // because none of its inputs had. Split out, it rebuilds when the FLEET changes, which is what it
  // actually depends on.
  //
  // Its identity matters as much as its cost: `mentionRoster` hands the same object to `ComposeBox`
  // for the same inputs (see that function's note), which is what lets the composer's reading of a
  // draft and this one be a single scan rather than two.
  const railRoster = useMemo(
    () => mentionRoster(mentionAgents, routingTarget?.agentId ?? null),
    [mentionAgents, routingTarget?.agentId],
  );
  const railTargetName = useMemo(() => {
    // The SHARED scan: `ComposeBox` read this exact draft against this exact roster in the same
    // commit, so this costs a pointer comparison. Its spans go to `classifyComposerRoute` so the
    // classifier does not re-derive the addressing position from the mentions it was just handed.
    const { spans, mentions } = scanMentions(composedText, railRoster);
    const route = classifyComposerRoute({
      text: composedText,
      mentions,
      spans,
      mountedAgentId: routableMountedAgentId,
    });
    if (route.kind === "sparkle") return "Concierge";
    // `mentions[0]` IS the addressing mention: `addressingSpan` can only ever qualify the FIRST
    // span (every later one has an earlier literal to its left), and the scan's `mentions` — the
    // spans de-duplicated in place — keep that order.
    if (route.via === "address") return mentions[0]?.name ?? "Concierge";
    // ══ AN AGENT-BOUND VERDICT MUST NEVER RENDER AS "Concierge" (roborev 59212 / 59232) ═══════════
    // The `?? "Concierge"` that used to close this expression restored the exact defect the commit
    // above it exists to remove: hands-free, `voice/autoSendTimer` says *"Sending to Concierge
    // shortly."* over words about to land on a command line.
    //
    // The RESOLUTION of the name now lives at `mountedName` rather than here (59232) — fixing it at
    // this one consumer left the chip, the transcript swap and the draft key still reading a mount
    // with no name as "not mounted". So all this arm owes is the terminal placeholder, and that is a
    // truthful non-destination rather than a fallback: `mountedName` resolves whenever the mount
    // routes, so reaching it would mean a routable mount with no target at all.
    return mountedName ?? "the mounted agent";
  }, [composedText, railRoster, routableMountedAgentId, mountedName]);

  const autoSendRail = useAutoSend({
    // ARMED IS NOW A TRAY POSITION, not a switch: only `speak` counts down, and only while the
    // tray is being addressed (see voice/useSendMode — an inert tray must not count invisibly and
    // then fire when colour returns).
    armed: sendTray.armed,
    // ── THE TOGGLE, AND IT IS A DIFFERENT QUESTION FROM `armed` ─────────────────────────────────
    // `armed` decides whether a countdown RUNS; this decides what it does when it EXPIRES. Passing
    // the toggle as `armed` instead would switch the countdown itself off — deleting the silence
    // countdown, its visible sweep, and the type-during-it pause, all of which the founder asked
    // for separately and which must keep working with auto-send off. See useAutoSend's own doc.
    autoSend: sendTray.autoSend,
    // OWNERSHIP GATE, and it is load-bearing rather than defensive. `speechEndSeq` is GLOBAL —
    // bumped for every utterance in the focused window whichever surface owns the mic — while the
    // cancel signal is not: `useConciergeDictation` returns interim `""` unless the concierge owns
    // dictation. Ungated, the rail counts down on speech dictated into an AGENT composer, with a
    // "keep talking and it waits" cancel that can never arrive, and three seconds later dispatches
    // whatever half-finished draft happens to be sitting in this box (roborev, High).
    micLive: dictation.micLive,
    composedText,
    interim: dictation.interim,
    // THE MIS-ROUTE SAFETY NET: the rail's only label is where this send would land, so the
    // countdown is also the moment you can notice you are about to dictate into the wrong agent.
    // Computed by the same function that routes the send — the agent the user NAMED, or the one the
    // cable is patched to, never one merely on screen. See `railTargetName` for both misroutes that
    // made this load-bearing, and for the resolve-it-the-same-way contract it keeps with the send.
    targetName: railTargetName,
    // Returns whether a send actually went out (see UseAutoSendArgs.onFire), and BOTH ways of not
    // sending are reported rather than just the first:
    //
    //  • no submit registered — the compose box renders only when `!aiLock`, so a lock engaging
    //    mid-countdown unmounts it and `registerSubmit(null)` leaves nothing to call;
    //  • the box was empty when the clock expired — `submit()` early-returns `false`.
    //
    // Both used to return `true` here, which the rail announced as "Sent to …" and recorded as a
    // tuning sample. A phantom sample does not merely miscount: it trains the thresholds.
    //
    // HOW NARROW THE SECOND CASE IS, since the next reader will look for a test of it and not find
    // one: `evaluate` already refuses to fire on an empty transcript (autoSendTimer — it drops back
    // to `listening` instead), and the rail's transcript IS this box's text, so the ordinary
    // "cleared mid-countdown" story never reaches `submit()` at all. What is left is the one-commit
    // gap between the box's `text` changing and `onComposedText` reporting it from an effect: a
    // fire landing inside that window sees a stale non-empty transcript and an already-empty box.
    // That is not reproducible from the host's public surface without faking the lag, so the guard
    // is pinned where it IS observable — `ComposeBox.autoSendSeam.test.tsx` asserts submit's own
    // return, both ways. Do not "fix" this by writing a host row that empties the composer and
    // watches for silence: it passes on `evaluate`'s guard and proves nothing about this line.
    onFire: useCallback(() => {
      const submit = composerSubmitRef.current;
      if (!submit) return false;
      autoFiringRef.current = true;
      try {
        return submit();
      } finally {
        autoFiringRef.current = false;
      }
    }, []),
    // The rail's fill is aria-hidden and the toggle's accessible name never changes, so without
    // this the whole feature is SILENT to a screen reader: no notice that a countdown started, none
    // that a message went, and the target name — the mis-route safety net the design rests on —
    // never spoken. Through `announce`, the column's ONE live region, exactly like onCopied.
    onAnnounce: announce,
  });

  /** A pill in one of the concierge's OWN replies was clicked: reveal that agent.
   *
   *  Stable identity (no deps) because it feeds a context value — a fresh closure per render would
   *  invalidate that context every render and re-render every pill in the thread, defeating the
   *  point of memoizing it. `openProjectTab` reads the stores itself, so nothing needs closing over.
   *
   *  Unlike a MENTION SEND, this is a pure navigation: no intent is armed, no countdown runs, and
   *  nothing is written to a PTY. Revealing an agent is reversible in a way a delivery is not, so
   *  it needs no gate. */
  const openAgentFromPill = useCallback(
    ({
      agentId,
      projectId,
      anchorY,
    }: {
      agentId: string;
      projectId: string;
      anchorY?: number;
    }) => {
      // Destructured by NAME on both sides, so the order flip into `openProjectTab(projectId,
      // agentId)` — two strings, silently swappable — cannot happen here (roborev 54894).
      // ASK FIRST, THEN ACT. `openProjectTab` reports the miss only AFTER it has opened and
      // selected the project (and possibly dropped the Sparkle pane), so calling it blind would
      // yank the reader to another tab and then tell them the click accomplished nothing — a
      // notice that contradicts what just happened on screen (roborev 55548). Checking up front is
      // also the established pattern for this exact decision (paletteJump, useAttentionNotifications).
      //
      // IT ALSO HAS TO BE ASKED FIRST, not merely SHOULD (bead sparkle-ixsb3). The question is no
      // longer just "is it there" but "would revealing it CHANGE anything", and that one is
      // unanswerable afterwards: every write on the reveal path is idempotent, so once it has run,
      // "the tab was already selected" and "I just selected it" look identical from the store. The
      // prediction has to be taken before the writes collapse the difference. `revealOutcomeFor`
      // subsumes the `agentExists` check this line used to make — a missing agent is `"gone"`.
      const planned = revealOutcomeFor(projectId, agentId);
      if (planned === "gone") return "gone";
      // RETURNED, not discarded: both of that path's early exits are silent, and the pill turns a
      // `"gone"` into "…is closed" rather than leaving the reader looking at an unchanged screen.
      const landed = openProjectTab(projectId, agentId);
      // SELECTING IS NOT FINDING. `openProjectTab` selects the agent — which highlights its row and
      // opens its pane — but the builder column is longer than a screen, so the row that answered
      // the click can be anywhere in it, including off screen. The reader who just clicked then has
      // to hunt for the thing they asked for, which is the half of "the pill works" that was
      // missing.
      //
      // Asked for ONLY on a landed open: a reveal for an agent that did not open would scroll the
      // column toward a row that is not going to be there.
      //
      // The anchor rides along so the row comes to the CURSOR (see components/anchoredScroll). A
      // keyboard activation sends no anchor and keeps the old get-it-on-screen behaviour.
      if (landed) useUiStore.getState().requestRevealAgent(agentId, { anchorY });
      // THE PREDICTION IS ONLY TRUSTED ONCE THE ATTEMPT AGREES WITH IT. `landed === false` means the
      // agent went away between the read above and the write — the race this path has always had to
      // believe the OUTCOME over the roster for — and it outranks a `"already-showing"` prediction
      // taken a microtask earlier.
      //
      // `requestRevealAgent` above is deliberately NOT counted as "something moved". It scrolls the
      // agent's row into view in ITS OWN column's sidebar, which is (a) nothing at all when the row
      // is already on screen, and (b) on the other pair entirely from the reader whenever the pill's
      // project is not the one they are watching. Treating it as a visible result is exactly the
      // over-claim that let this click be invisible.
      if (!landed) return "gone";
      return planned;
    },
    [],
  );

  /**
   * The destination that replaces a dead pill: a closed agent's PROMPTS outlive the agent.
   *
   * `history_search` is FTS over every recorded prompt and response, retained independently of the
   * agent record (services/history), and it returns the agent's name alongside each hit — which is
   * exactly how the discarded BYOK agent ids were recovered after none of them appeared in the
   * roster.
   *
   * IT OPENS THE PALETTE, and that is not optional garnish. Seeding `historyStore.query` alone
   * renders nothing: the sidebar's `<HistorySearch>` mount was REMOVED (see AgentSidebar — "the
   * full-text search bar that used to sit here is GONE"), and the only live consumer of that store
   * is `<CommandPalette>`, which renders nothing while closed and clears the query on its next
   * close. Writing the query without opening the palette would have been this very bug relocated
   * one level down — an affordance that looks live and produces no visible change (roborev 55522).
   *
   * By NAME rather than by id: the id is an internal uuid that appears in no recorded prompt text,
   * so searching it would reliably return nothing.
   */
  const seeAgentHistory = useCallback(
    ({ name }: { agentId: string; name: string }) => {
      useHistoryStore.getState().setQuery(name);
      onOpenHistory?.();
    },
    [onOpenHistory],
  );

  // ══ HANDOFFS INTO THIS BOX ═══════════════════════════════════════════════════════════════════
  //
  // Drafts and files produced somewhere that ISN'T the compose box — the capture takeover's
  // Build ❯ / Chat ❯, and a file drop on "+ New Build Agent". Both used to be consumed by the
  // terminal Composer inside AgentPane. That composer was deleted in db29f0a48 and this box became
  // the input surface for a build agent, but neither handoff followed it here, so both wrote into
  // stores with no reader: an island capture created the agent and then threw the user's words and
  // screenshot away, silently, with no log output whatsoever. That silence is the reason it
  // survived — so both consumers below LOG what they delivered, and the compose-handoff one logs
  // an ERROR in the single remaining case where it cannot.
  //
  // This host is the right home for them precisely because the concierge column is always mounted:
  // the old consumer had to wait for a specific agent's composer to exist, which is what made the
  // handoff droppable in the first place.

  // Files dropped on "+ New Build Agent" were queued for the agent that drop SPAWNED, before any
  // surface existed to hold them (hooks/useNewBuildAgentDrop). The drop also selects that agent, so
  // it arrives here as the target; drain its entry and stage the files. Keyed on `target`, not
  // `routingTarget`, so glancing at the Plan board doesn't strand them. Draining is idempotent (the
  // entry empties), so re-running on a target change is harmless.
  const dropTargetAgentId = target?.agentId ?? null;
  // SUBSCRIBE, don't just read on target change (roborev 55403).
  //
  // The drop path always CHANGED the target (the drop spawns and selects an agent), so an effect
  // keyed only on `dropTargetAgentId` was enough for it. `attachments.attach_to_message` is the
  // other writer and it does not: in the dominant case the human is already talking about agent X,
  // so the target never moves, the effect never re-runs, and the queue is never drained. The tool
  // meanwhile replied "Staged. 1 file(s) … they ride along with the next message" — the file
  // reaching nobody while the user is told it is attached. Subscribing makes an ADD a re-render,
  // which is the trigger the imperative read was missing.
  const queuedForTarget = usePendingAttachmentsStore((s) =>
    dropTargetAgentId ? s.pending[dropTargetAgentId] : undefined,
  );
  useEffect(() => {
    if (!dropTargetAgentId) return;
    // Still drained imperatively inside: the read empties the entry, so this stays idempotent
    // whether it re-runs from a target change or from a queue write.
    const paths = usePendingAttachmentsStore.getState().drain(dropTargetAgentId);
    if (paths.length === 0) return;
    // Kinds, never paths — this log ships with support tickets (services/logSafePaths).
    log.info("composer", `staging ${paths.length} handed-off file(s) on the compose box`, {
      agentId: dropTargetAgentId,
      ...describePaths(paths),
    });
    attachPaths(paths);
    // `queuedForTarget` is a dependency for its EDGE, not its value — the drain above reads the
    // store directly. Without it, a write to the queue for an already-aimed agent never re-runs this.
  }, [dropTargetAgentId, attachPaths, queuedForTarget]);

  // The capture takeover's draft: text plus the shot, staged as chips, NEVER auto-sent.
  const composeHandoff = useComposeHandoffStore((s) => s.handoff);
  useEffect(() => {
    if (!composeHandoff) return;
    // Re-read through `take()`, which reads AND CLEARS. That is the idempotency guard, not a
    // stylistic re-read: a StrictMode double-mount or an HMR replay runs this body twice, and the
    // second run gets null instead of pasting the narration twice and staging the screenshot
    // twice. The subscribed value above serves only as the trigger.
    const h = useComposeHandoffStore.getState().take();
    if (!h) return;
    // Already resolved by the capture window — no disk read, so the chip cannot arrive late (or
    // not at all) after the text has already landed. See useConciergeAttachments.attachReady.
    const staged = h.attachments.map((a) => screenshotAttachment(a.path, a.dataUrl));
    if (staged.length > 0) attachReady(staged);
    const insert = insertRef.current;
    if (h.text.trim()) {
      if (insert) insert(h.text);
      else {
        // The one way this can still lose text, and it is now LOUD. Nothing in the shipping app
        // unmounts the compose box while the column is up, so this firing means that changed.
        log.error("composer", "capture handoff arrived with no compose box mounted — text dropped", {
          origin: h.origin,
          projectId: h.projectId,
          chars: h.text.length,
        });
      }
    }
    // Chat named its destination; Build leaves the aim to the router, which the dispatch has
    // already pointed at the agent it selected.
    forceSparkleRef.current = h.route === "sparkle";
    // ══ THE WRONG-AGENT GUARD ═══════════════════════════════════════════════════════════════════
    // A Build handoff NAMES the agent the capture was for, and `dispatchBuild` selects that agent
    // synchronously before queueing the draft — so by the time this effect runs, the box's live aim
    // should already BE that agent. The predecessor's guard matched on project + kind and not on
    // agentId at all, which is exactly how a draft meant for a freshly created agent could be
    // delivered against a different build agent in the same project.
    //
    // This does NOT override the aim, and must not. `target` is resolved live at send time on
    // purpose (see the memo above), and conciergeRouter's header rules out a `forceAgent` latch —
    // typing a paragraph into a live PTY on the strength of a stale flag is a worse failure than
    // the one being guarded. So the enforcement lives where it can be enforced (dispatchBuild's
    // explicit select) and this end asserts the invariant LOUDLY instead of silently disagreeing.
    // BOTH failure shapes are reported, because the quieter one is the more likely (roborev 53843).
    // An earlier cut only compared ids, which said nothing in the state that most reliably means
    // "the selection did not land": no live target at all. In that state a Build draft carrying an
    // agentId goes to the auto-router with no trace whatsoever.
    //
    // …but "no live aim" is NOT always a fault, and a guard that cries wolf is a guard people learn
    // to scroll past (roborev 53856). `decidePromptTarget` returns null for a CLOUD build agent BY
    // DESIGN — it has no local PTY, so the box is deliberately Sparkle-only for it — and a cloud
    // agent is `kind: "build"`, so both the capture menu and dispatchBuild's reuse branch can land
    // on one. There the selection did land and nothing is wrong, so it is an INFO. The warnings are
    // kept for the two states that really are faults: the named agent is gone from this window's
    // project, or a local, promptable agent somehow isn't the aim.
    if (h.agentId) {
      const live = targetRef.current;
      const named = useProjectStore
        .getState()
        .projects.find((p) => p.id === h.projectId)
        ?.agents.find((a) => a.id === h.agentId);
      if (live && live.agentId === h.agentId) {
        // Agreed — the ordinary path. Say nothing.
      } else if (live) {
        log.warn("composer", "capture handoff aim disagrees with the compose box's live target", {
          origin: h.origin,
          projectId: h.projectId,
          handoffAgentId: h.agentId,
          liveAgentId: live.agentId,
        });
      } else if (!named) {
        log.warn("composer", "capture handoff names an agent this window no longer has", {
          origin: h.origin,
          projectId: h.projectId,
          handoffAgentId: h.agentId,
        });
      } else if (named.runtime === "cloud") {
        log.info("composer", "capture handoff targeted a cloud agent — the draft stays with Sparkle", {
          origin: h.origin,
          projectId: h.projectId,
          handoffAgentId: h.agentId,
        });
      } else {
        // A local, promptable agent that dispatchBuild selected — and yet the box has no aim at it.
        // That IS the drift: the selection did not reach the compose box, and the next Enter will
        // be routed at whatever the router decides rather than at this capture's agent.
        log.warn("composer", "capture handoff names a local agent but the compose box has no live aim", {
          origin: h.origin,
          projectId: h.projectId,
          handoffAgentId: h.agentId,
        });
      }
    }
    // Put the caret where the draft is, so Enter is the only thing left to do.
    useUiStore.getState().requestComposeFocus();
    log.info("composer", `capture handoff staged in the compose box (${h.origin})`, {
      projectId: h.projectId,
      agentId: h.agentId,
      chars: h.text.length,
      attachments: staged.length,
      route: h.route ?? "auto",
    });
  }, [composeHandoff, attachReady]);
  // Latest thread, for redirect (which needs a message's current receipt without re-memoizing the
  // controller on every streamed delta).
  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  // The message text behind each routed bubble, so a redirect can re-send the ORIGINAL words
  // rather than reconstructing them from the rendered bubble. Keyed by message id; a ref because
  // nothing renders from it and it must survive without re-rendering the column.
  const sentTextRef = useRef<Map<string, string>>(new Map());
  // The agent-bound form of the same messages (text with attachment paths prefixed). Capped through
  // the SAME helper as sentTextRef so the two evict together — a bare set() left this one growing
  // for the whole session while every entry past the cap was already unreachable, since redirect
  // bails as soon as sentTextRef has evicted the id.
  const sentPayloadRef = useRef<Map<string, string>>(new Map());
  // ══ THE PTY-BOUND REPLAY, SEPARATE FROM THE BRAIN-BOUND ONE ABOVE ═══════════════════════════
  // Same message, `@…` addresses stripped, for the ONE redirect arm that writes into a terminal
  // (`promptAgent`). These have to be two maps because the two consumers want opposite things and a
  // single value cannot serve both (roborev 55765):
  //
  //   • the PTY needs the sigil GONE — a leading `@` opens the Claude Code CLI's file-reference
  //     autocomplete and strands the instruction behind a picker (bead sparkle-kaz1l);
  //   • the BRAIN needs the NAMES KEPT — `askSparkle(replay)` is the "Also ask Sparkle" arm, and
  //     `mentionFreeText` deletes a LEADING addressing span wholesale rather than just its sigil.
  //     Stripping for that consumer asked Sparkle "ship the DMG" about a message the user aimed at a
  //     named agent, contradicting this file's own invariant that Sparkle should see who it was
  //     aimed at. (A mention that does NOT lead now survives as its plain name, so the two
  //     renderings coincide for those — the split is still required for the addressed case, which is
  //     the common one.)
  //
  // Capped through the same helper as the other two so all three evict together.
  const sentWireRef = useRef<Map<string, string>>(new Map());
  // Redirects currently in flight, so a double-tap can't deliver twice (see redirect).
  const redirectingRef = useRef<Set<string>>(new Set());
  // Approves currently in flight, per agent. Approve is deferred behind the send queue now, so a
  // click during a still-routing send produces no immediate delivery — and with no feedback the
  // natural reaction is to click again. A second queued approve lands AFTER the picker has already
  // been answered, where it answers whatever prompt comes next or is typed as free text
  // (roborev 53119). One in flight per agent, and the thread acknowledges the click immediately.
  const approvingRef = useRef<Set<string>>(new Set());
  // Serializes sends. Routing is ASYNC now (tier 2 is a network round trip), so two messages sent
  // in quick succession race: the second can classify faster than the first and reach the PTY
  // first, silently reordering the user's instructions. The toggle-era send had no await before
  // delivery and so couldn't do this. Each send chains onto the previous one's completion, which
  // guarantees delivery in SUBMIT order.
  const sendChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Hydrate the reply linter's policy, and keep it fresh.
  //
  // GLOBAL config deliberately — `getConfig()` with no project root. `config.rs` already ignores
  // `[concierge]` in a per-project file as a security boundary (a cloned repo must not grant itself
  // authority), and that applies with more force to the checks: a repo must not be able to switch
  // OFF the linter that governs replies about it.
  //
  // Separate from the stream effect below so a config change re-reads the policy without tearing
  // down the three event listeners — and so a slow or failed `getConfig` cannot delay them.
  useEffect(() => {
    let alive = true;
    const apply = (eff: EffectiveConfig) => {
      if (!alive) return;
      lintPolicyRef.current = toLintPolicy(eff?.config?.concierge?.checks);
    };
    let unlisten: (() => void) | undefined;
    // ══ ONE async FUNCTION, NOT TWO PROMISE CHAINS — AND THAT IS NOT A STYLE CHOICE ═════════════
    // Both calls fail whenever Tauri is absent, which is EVERY jsdom test that does not mock
    // `services/config` — most of them. Getting the handling wrong here does not fail a test; it
    // fails the CI COVERAGE SHARDS, with every test green and, under the blob reporter, a single
    // word of diagnostic ("undefined"). That cost two full CI rounds to find.
    //
    // THE PROPERTY THIS SHAPE HOLDS, stated as a property because the exact trigger was never
    // reproduced locally and a mechanism nobody proved is not worth asserting: NEITHER CALL'S
    // FAILURE ESCAPES THIS EFFECT — not a rejection, and not a synchronous throw from a call that
    // returns a non-promise. The second half is the one a promise chain gets wrong and this does
    // not: `onConfigChanged(apply).then(…)` throws `Cannot read properties of undefined (reading
    // 'then')` right there when the call returns `undefined` (a mock whose implementation
    // `vi.resetAllMocks()` stripped is exactly that), which matches the one-word diagnostic far
    // better than an unhandled rejection does — a `.catch` attached in the same tick is never
    // unhandled at any timing, so the original explanation for this rewrite was probably wrong.
    //
    // `await` inside try/catch covers both: `await undefined` is fine, and a rejection is handled
    // where it is produced rather than by a handler on a floating promise. `run()` cannot throw, so
    // `void run()` cannot reject.
    //
    // WHAT IS ACTUALLY TESTED, stated precisely because an earlier version of this comment claimed
    // more than existed: `ConciergeHost.lint.test.tsx` pins the TWO REJECTION arms (and the
    // `onConfigChanged` one fails against the catch-in-cleanup shape it replaced). The non-promise
    // arm is covered by CONSTRUCTION — `await undefined` — and by a note in that file, NOT by a
    // test; it was measured to be unobservable from that harness, so a row for it could not fail.
    const run = async () => {
      try {
        apply(await getConfig());
      } catch (e) {
        // Leaves the policy DISABLED. A config we could not read must not be guessed at: the linter
        // staying off is a visible non-event, whereas a fabricated policy could block replies from
        // rules the user never configured.
        console.warn("conciergeLint: getConfig failed; linter stays disabled", e);
      }
      try {
        const fn = await onConfigChanged(apply);
        // Unmount-before-resolve: without this the listener outlives the component that made it.
        if (alive) unlisten = fn;
        else fn();
      } catch (e) {
        console.warn("conciergeLint: config-changed subscribe failed", e);
      }
    };
    void run();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Index the conversation for search. Mounted once, deliberately SEPARATE from the brain
  // subscription below: it watches the thread (what the human ends up seeing) rather than the turn
  // events, so a reply held by the lint policy — which never reaches the normal render path — is
  // still captured. See services/conciergeHistoryCapture for why that seam and not `onConciergeDone`.
  useEffect(() => startConciergeHistoryCapture(), []);

  // Stream the brain into the thread: deltas append to a bubble keyed by the turn id; done finalizes.
  useEffect(() => {
    // The prefix is SHARED, not spelled here: `conciergeHistoryCapture` has to recognise a bubble
    // built by this line as one that is still streaming, and a second copy of the literal is how the
    // two drift. See BRAIN_ID_PREFIX's own note.
    const key = (id: string) => `${BRAIN_ID_PREFIX}${id}`;
    // TRUE when this event belongs to a turn the user has already moved past. NOT a pure
    // predicate: on the way to `false` it also adopts a newer turn (advancing `latestTurnRef`) and
    // retires its predecessors' accumulated text. Named for what it RETURNS — an `admitTurn` that
    // returned true for "rejected" made every call site read backwards, which is the kind of thing
    // the next handler gets silently wrong (roborev 53051).
    //
    // DEFENCE IN DEPTH, not the primary guard (roborev 53088/53105/53130). concierge.rs retires a
    // superseded turn at the SEND — before the replacement child is even spawned — and its reader
    // goes silent at the source, so these events should not arrive at all. This keeps the frontend
    // honest about ids anyway: it is the layer that knows which bubble is which.
    //
    // Turn ids ARE the backend's monotonic token (`token.to_string()`), so "newer" is a numeric
    // comparison, not a guess. A straggler from an older turn is dropped whole: it must not
    // accumulate, must not wipe the live turn's text, and must not clear its typing indicator.
    // Ids that aren't numbers are local errors (CONCIERGE_LOCAL_ERROR_ID) and always surface.
    const supersededTurn = (id: string): boolean => {
      // Strictly a token, not "anything Number() will swallow" (roborev 53004): Number("") is 0 and
      // Number(" 5 ") is 5, so a malformed id would quietly become a turn number instead of taking
      // the local-error path it resembles.
      if (!/^\d+$/.test(id)) return false;
      const n = Number(id);
      // `retireThrough` is what closes the straggler WINDOW (roborev 53004/53051). Advancing only when a
      // newer turn's event arrives leaves exactly the wrong gap open: the backend kills the old
      // child at send time and its reader flushes buffered stdout immediately, while the new turn
      // still has to spawn `claude` and wait on the model. Those late events carry the OLD id, so
      // "newer than anything I've seen" would call them live. Sending retires everything up to and
      // including the newest id seen so far, which is the old turn by construction.
      if (n <= retireThroughRef.current) return true;
      if (n < latestTurnRef.current) return true;
      if (n > latestTurnRef.current) {
        latestTurnRef.current = n;
        // A genuinely newer turn retires its predecessors' accumulated text. Doing it HERE rather
        // than at send time is what keeps a turn that is still streaming from being truncated
        // before it is announced (roborev 49293/49294).
        for (const k of Object.keys(brainTextRef.current)) if (k !== id) delete brainTextRef.current[k];
      }
      return false;
    };
    // WHAT MARKS A BUBBLE AS A PUSH (roborev 54166-M5). A proactive turn streams over the same
    // events as a reply, so without this its `done` produces an ordinary sparkle bubble — an
    // append-only "You have 3 P1s" that keeps asserting a resolved count with no way to retract it
    // (PRD §2a). `proactive` is what the thread renders differently; `digest` is what makes the
    // retraction decidable (see markStaleProactive below). Stamped from the FIRST delta, not at
    // `done`, so a push that dies mid-stream is still identifiable as one.
    const pushFields = (id: string): { proactive?: true; digest?: string } =>
      isProactiveTurn(id) ? { proactive: true, digest: pushDigestRef.current.get(id) } : {};
    // WHICH OF THE USER'S MESSAGES THIS REPLY IS ANSWERING (see Concierge/replyAnchors).
    //
    // Stamped at BUBBLE CREATION, from the thread as it stands at that instant, and both halves of
    // that are load-bearing. At creation, because the outstanding set is only correct before this
    // reply is in the array — a moment later the reply itself is the thing that ends the burst.
    // From `prev` inside the updater, because the answer depends on the array being written to, and
    // reading a ref beside it is how two sources of one truth start to disagree.
    //
    // A PUSH ANCHORS NOTHING. Nobody asked for it (services/conciergeProactive), so it answers
    // nothing, and quoting the user's last message over an unprompted line would be a claim the
    // channel exists to avoid making.
    const answerFields = (prev: ConciergeMessage[], id: string): { answers?: ReplyAnchor[] } => {
      if (isProactiveTurn(id)) return {};
      // ══ A QUEUED MESSAGE IS NOT ANSWERED BY THE TURN AHEAD OF IT (probe 2 on PR #1235) ══════════
      // `pendingAnchors` walks back to the last settled reply and claims every user message since.
      // That was exactly right when a send superseded — the newest message WAS the one being
      // answered. With a queue it over-claims: if B is sent while A is still running, B's bubble is
      // already in the thread, so A's reply would carry an "Answered below" anchor for a question
      // that was never in A's prompt (`buildSnapshot` carries one message).
      //
      // Filtered on the QUEUE rather than on the thread, because the thread cannot tell the
      // difference — both bubbles look identically sent. `statusOf` is the reducer's own answer to
      // "has this message's turn started", which is precisely the question being asked here.
      const answers = pendingAnchors(prev).filter((a) => !neverSentRef.current.has(a.id));
      return answers.length ? { answers } : {};
    };
    // `lint` IS ONLY EVER PASSED BY THE `done` PATH, and the omission is load-bearing on the delta
    // path rather than merely tidy: the field is spread from `cur`, so leaving it out PRESERVES what
    // is already on the bubble. Passing `undefined` on every streamed token would erase a mark the
    // moment a straggling delta landed after `done`.
    /** `answers` OVERRIDES the anchors this bubble would compute for itself, and only the block
     *  path passes it: a held reply's bubble can be created long after `answerFields` stopped being
     *  able to answer honestly (see {@link LintHold.answers}). Ignored when the bubble already
     *  exists, exactly as the computed form is. */
    const upsert = (
      id: string,
      text: string,
      replace: boolean,
      lint?: MessageLintMark[],
      answers?: ReplyAnchor[],
    ) => {
      const prior = brainTextRef.current[id] ?? "";
      brainTextRef.current[id] = replace ? text : prior + text;
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1)
          return [
            ...prev,
            {
              id: k,
              kind: "sparkle",
              text,
              ...(lint ? { lint } : {}),
              ...pushFields(id),
              ...(answers?.length ? { answers } : answerFields(prev, id)),
            },
          ];
        const next = prev.slice();
        const cur = next[i]!;
        next[i] = {
          ...cur,
          kind: "sparkle",
          // `cur` is always the sparkle bubble for this turn — it was found by the turn's own key —
          // but the union now contains a variant with no `text` at all (the recap card), so the
          // narrowing has to be explicit rather than a defensive `?? ""`.
          text: replace ? text : (cur.kind === "sparkle" ? cur.text : "") + text,
          // THE SAME NARROWING, for the same reason. A `you` message's `collapsed` is an ARRAY of
          // the user's own pastes; a sparkle bubble's is the ONE brief it relayed. Spreading `cur`
          // blind would carry the wrong shape across, so the field is restated from the narrowed
          // side — which preserves this turn's own payload and can never graft a user's pills onto
          // a reply.
          collapsed: cur.kind === "sparkle" ? cur.collapsed : undefined,
          // A HOLD ENDS THE MOMENT REAL TEXT LANDS HERE. `held` is spread in from `cur`, so without
          // this the placeholder would outlive the rewrite it announces and the winning reply would
          // render underneath "rewriting…" forever. `settleHold` is the only writer of the text that
          // ends a hold, and it goes through this upsert, so clearing it here covers every exit —
          // corrected, retry-also-blocked, errored, superseded, abandoned, timed out.
          held: undefined,
          ...(lint ? { lint } : {}),
          ...pushFields(id),
        };
        return next;
      });
    };
    /** Record that this turn reached `done`. Returns `prev` untouched when there is nothing to mark,
     *  so a `done` for a turn that never produced a bubble does not rebuild the array and re-render a
     *  transcript of memoised rows for no reason. */
    const markSettled = (id: string) => {
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return prev;
        const cur = prev[i]!;
        if (cur.kind !== "sparkle" || cur.settled) return prev;
        const next = prev.slice();
        next[i] = { ...cur, settled: true };
        return next;
      });
    };
    /** Record that this turn's stream is OVER WITHOUT an answer — it failed, or a newer send
     *  superseded it mid-stream. The partial text stays on screen either way, so something has to
     *  say it has stopped growing; `settled` cannot, because it means "the previous real ANSWER" and
     *  a dead fragment claiming that role is a defect `replyAnchors` already fixed (roborev 62935).
     *
     *  Same no-op discipline as `markSettled`: returns `prev` untouched when there is no bubble
     *  (a correction streams silently, and a turn can fail before any delta), and never overwrites a
     *  bubble that did settle. */
    const markStreamEnded = (id: string) => {
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return prev;
        const cur = prev[i]!;
        if (cur.kind !== "sparkle" || cur.settled || cur.streamEnded) return prev;
        const next = prev.slice();
        next[i] = { ...cur, streamEnded: true };
        return next;
      });
    };
    /** Take one turn's violating TEXT off screen while its correction runs — WITHOUT moving its row.
     *
     *  ONLY the block path uses this, and it is not optional there. Deltas paint live into the same
     *  bubble the `done` handler replaces, so by the time a reply is judged blocked it is already
     *  fully on screen — and a hold that only declines to re-render leaves it there for the whole
     *  correction turn (roborev 58805). That is precisely what `severity = "block"` exists to
     *  prevent: the founder can read "Say go and I'll spawn the worker", answer `go`, and act on a
     *  sentence the linter is in the middle of rejecting. The reply is not lost — it is in
     *  `LintHold.text`, its anchors are in `LintHold.answers`, and `settleHold` puts back whichever
     *  text finally wins.
     *
     *  ══ BLANKED IN PLACE, NEVER SPLICED OUT (roborev 58971, High) ═══════════════════════════════
     *  The first version removed the row. `upsert`'s not-found branch APPENDS, so the held reply came
     *  back at the BOTTOM of the thread — below anything that landed during the up-to-90s hold. The
     *  sharp case is the one `dispatchTurn` is written around: `send()` appends the new `you` bubble
     *  BEFORE `dispatchTurn` settles the hold, so a user who sent again got
     *  `[you Q1, you Q2, sparkle A1]` — the answer to Q1 sitting under Q2, reading as Q2's answer,
     *  with Q2's real reply arriving beneath it as a second one. Any `postSparkle` during the window
     *  (relay receipts, promise-ledger nags, feed notices) relocated it the same way.
     *
     *  Blanking keeps the index, so `settleHold`'s `replace: true` upsert finds the row where it has
     *  always been. `held: true` is what the renderer keys the placeholder off — an empty bubble with
     *  no marker would read as a lost turn, which is the other half of what this must not do. */
    const blankHeldBubble = (id: string) => {
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return prev;
        const cur = prev[i]!;
        if (cur.kind !== "sparkle") return prev;
        const next = prev.slice();
        next[i] = { ...cur, text: "", held: true };
        return next;
      });
    };

    // ══ THE BLOCK PATH — WHAT `severity = "block"` ACTUALLY DOES ════════════════════════════════
    //
    // `lintReply` has always computed `LintResult.blocked` and, until this, NO caller read it: the
    // mount consumed `.text` and `.violations` and dropped the flag on the floor. So the strictest
    // tier the config offers behaved exactly like `"warn"` — `config.rs` documented
    // `ask-without-action` as "re-prompts the concierge once for a corrected reply" while nothing
    // re-prompted, and the check therefore shipped at `"warn"` for want of this code.
    //
    // What happens now: a blocked reply is HELD rather than rendered, ONE correction turn is
    // dispatched naming the checks that fired, and the correction replaces the held reply in the
    // ORIGINAL turn's bubble.
    //
    // ══ THE THREE PROPERTIES THAT MATTER, IN ORDER OF WHAT THEY COST IF BROKEN ══════════════════
    //  1. NEVER LOSE A REPLY. `services/conciergeLint`'s header: "a linter that can destroy one is
    //     worse than no linter." Every exit below — corrected, retry-also-blocked, correction
    //     errored, superseded, abandoned, dispatch rejected, timed out, column unmounted — ends in
    //     `settleHold`, which renders something. There is no path that merely drops the hold.
    //  2. ONE RETRY, EVER. A correction that is itself blocked renders MARKED; it does not re-prompt.
    //     An unbounded loop here spends the founder's model quota, silently, on a reply nobody is
    //     reading. `lintRetriedRef` and the fact that the correction path never touches the hold
    //     branch are two independent guards on the same thing.
    //  3. THE COUNT STAYS HONEST. `"revised"` is only written when a correction actually replaced
    //     the held text on screen. A reply that was never corrected counts `"rendered_marked"`.
    //
    // ══ WHY THE CORRECTION IS DISPATCHED DIRECTLY AND NOT THROUGH THE QUEUE ═════════════════════
    // `dispatchTurn` is the USER-send path: it owns a `you` bubble, `awaitingBubbleRef`,
    // `neverSentRef`, a receipt, and it advances `retireThroughRef`. A correction has none of those
    // — nobody typed it, no bubble is waiting on it, and taking a queue slot would make the reply a
    // user IS waiting on queue behind a rewrite they never asked for. So it is a bare
    // `startConciergeTurn`, and `canHoldFor` refuses the hold outright when anyone is queued: a
    // waiting user turn would dispatch on the drain below and `concierge.rs` would kill the
    // correction child, which is a paid turn spent to reach the same rendered original.

    /** Stop the backstop timer and drop the hold. Never renders — see `settleHold` for that. */
    const clearHold = () => {
      const held = lintHoldRef.current;
      if (held?.timer) clearTimeout(held.timer);
      lintHoldRef.current = null;
    };

    /**
     * Render a held reply, count it, and close the hold. THE ONLY EXIT FROM A HOLD.
     *
     * `held.done` is latched first because two exits genuinely race — a `done` that lands in the
     * same tick as the backstop timer, a supersede that lands beside a rejected dispatch — and the
     * second one through must not render a second bubble or double-count a violation.
     */
    const settleHold = (
      held: LintHold,
      text: string,
      violations: readonly Violation[],
      reports: readonly { violations: readonly Violation[]; turnId: string; action: LintAction }[],
      toolCalls: readonly ConciergeToolCall[] | undefined,
    ) => {
      if (held.done) return;
      held.done = true;
      clearHold();
      // Each report guarded on its own: telemetry is the byproduct and the reply is the product, so
      // a broken counter must not be able to stop the render three lines below it.
      for (const r of reports) {
        try {
          reportLintOutcome({
            violations: r.violations,
            turnId: r.turnId,
            action: r.action,
            policy: lintPolicyRef.current,
          });
        } catch (err) {
          console.warn("conciergeLint: reporting a held reply's outcome failed", err);
        }
      }
      // The hold raised the indicator (a rewrite really was in flight); this is where it comes down.
      // Safe against stealing a NEWER turn's indicator because the only way a new turn starts during
      // a hold is `dispatchTurn`, which settles the hold as its FIRST statement and raises typing
      // afterwards — so this always runs before that, never after it.
      setTyping(false);
      const marks = toLintMarks(violations);
      upsert(held.turnId, text, true, marks, held.answers);
      const lintLine = lintMarkText(marks);
      if (lintLine && displayMountedRef.current) noteMounted(lintLine, "info");
      // AFTER the upsert, which is what creates the bubble when a hold was taken before one existed:
      // `markSettled` returns `prev` untouched for a turn with no bubble, so the other order would
      // silently never stamp it and every later reply would claim this one's questions.
      markSettled(held.turnId);
      // NOT indexed here (sparkle-yd1ud × sparkle-s7rfc). A reply the founder read is a reply he may
      // later ask about, whichever path produced it — and that is exactly why the capture is no
      // longer a call on each path: `startConciergeHistoryCapture` observes the thread store, which
      // is downstream of this settle, of the plain `done` handler, and of `finishCorrection` alike.
      // See the import block's note.
      // THE LEDGER READS WHAT THE USER WAS ACTUALLY TOLD. Running it at `done` on a reply that was
      // then replaced would record a promise out of text nobody ever saw — and the ledger's whole
      // value is that the founder can check it against what he read.
      try {
        for (const p of noteConciergeTurnForPromises({
          id: held.turnId,
          text,
          toolCalls: toLintToolCalls(toolCalls),
          at: Date.now(),
        })) {
          postSparkle(line`You said you'd ${plain(promiseVerbPhrase(p.family))} — ${plain(oneLine(p.sentence))} — and that hasn't happened.`);
        }
      } catch (err) {
        console.warn("concierge: promise ledger failed; the reply is unaffected", err);
      }
      // The RENDERED form, like the non-blocked path: `restated-state` asks whether the human is
      // being told the same thing twice, and a correction they never saw is not what they were told.
      prevReplyRef.current = text;
      if (text) announce(text);
    };

    /** Give up on the correction and render the HELD ORIGINAL, marked. Every failure path lands
     *  here, and `why` is logged rather than shown: the user asked a question and got an answer,
     *  and a notice about the linter's own plumbing is not something they can act on.
     *
     *  `owner` scopes the give-up to ONE hold, and a caller that is a continuation of a specific
     *  hold — a timer, a settled dispatch promise — must pass it. Without that check a stale
     *  continuation tears down whatever hold is current NOW (roborev 58805): hold A's rejection
     *  arriving after A was settled by a new send would render hold B's original and strand B's
     *  correction, spending B's one retry on A's failure. The event-driven callers (an error, an
     *  abandon, a new send, unmount) legitimately mean "whatever is held", and pass nothing. */
    const giveUpOnCorrection = (why: string, owner?: LintHold) => {
      const held = lintHoldRef.current;
      if (!held || held.done) return;
      if (owner && owner !== held) return;
      console.warn(`conciergeLint: ${why}; rendering the held reply marked`);
      // The correction turn may still be ALIVE — nothing here kills the child. From this moment its
      // events must reach nothing, and `isCorrectionTurn` is about to stop recognising them because
      // `settleHold` clears the ref they are matched against.
      if (held.correctionTurnId) rememberSilenced(held.correctionTurnId);
      settleHold(
        held,
        held.text,
        held.violations,
        [{ violations: held.violations, turnId: held.turnId, action: "rendered_marked" }],
        held.toolCalls,
      );
    };
    settleLintHoldRef.current = giveUpOnCorrection;

    /** Is this event the correction turn's? Null-safe on `correctionTurnId`, which is null for the
     *  window between dispatch and the invoke resolving a token. */
    const isCorrectionTurn = (id: string): boolean => {
      const held = lintHoldRef.current;
      return !!held && held.correctionTurnId !== null && held.correctionTurnId === id;
    };

    /** Add to a bounded id set, oldest-first eviction, so a long session cannot grow it forever. */
    const remember = (set: Set<string>, id: string) => {
      set.add(id);
      if (set.size > 500) for (const k of set) { set.delete(k); if (set.size <= 400) break; }
    };
    /** Remember a turn id as having spent its one retry. */
    const rememberRetried = (id: string) => remember(lintRetriedRef.current, id);
    /** Remember a correction turn id as abandoned — its events reach nothing from here. */
    const rememberSilenced = (id: string) => remember(lintSilencedRef.current, id);
    /** Is this an abandoned correction turn, whose events must all be dropped? */
    const isSilencedTurn = (id: string): boolean => lintSilencedRef.current.has(id);

    /** May this turn's blocked reply take the one correction turn it is allowed? */
    const canHoldFor = (id: string): boolean => {
      // One hold at a time. A second would need a second bubble, a second timer and a second
      // never-lose guarantee, to buy nothing: the first is about to settle either way.
      if (lintHoldRef.current) return false;
      // ONE RETRY, EVER — for the original and for the correction alike.
      if (lintRetriedRef.current.has(id)) return false;
      // Nobody is waiting on a push, so it does not get to spend a turn on a rewrite.
      if (isProactiveTurn(id)) return false;
      // See the header: a queued user turn will dispatch on this handler's drain and kill the
      // correction child, so the correction would be paid for and never arrive.
      if (turnQueueRef.current.waiting.length > 0) return false;
      return true;
    };

    /** Hold this reply and dispatch its one correction turn. Returns false when nothing was held,
     *  in which case the caller renders normally. */
    const takeHold = (
      e: { id: string; text: string; toolCalls?: readonly ConciergeToolCall[] },
      linted: LintResult,
    ): boolean => {
      // Assembled from CHECK IDS ONLY — no reply prose leaves this subsystem, the same rule
      // `Violation.span` (a character count) exists for. Empty means the violations named nothing
      // actionable, and a paid turn on an empty instruction list is worse than rendering marked.
      const prompt = buildLintCorrectionPrompt(linted.violations);
      if (!prompt) return false;
      rememberRetried(e.id);
      const held: LintHold = {
        turnId: e.id,
        text: linted.text,
        violations: linted.violations,
        toolCalls: e.toolCalls,
        answers: answerFields(chatRef.current, e.id).answers,
        prevReply: prevReplyRef.current,
        correctionTurnId: null,
        timer: null,
        done: false,
      };
      held.timer = setTimeout(
        () => giveUpOnCorrection("the correction turn never produced a terminal event", held),
        LINT_CORRECTION_TIMEOUT_MS,
      );
      lintHoldRef.current = held;
      // ══ AND TAKE THE VIOLATING TEXT OFF SCREEN ═══════════════════════════════════════════════
      // It is already painted — deltas stream into this same bubble — so declining to re-render is
      // not the same as not rendering. The indicator goes back up because a rewrite genuinely is in
      // flight, and because a reply that vanishes with nothing in its place reads as a lost turn.
      blankHeldBubble(e.id);
      setTyping(true);
      void startConciergeTurn(prompt).then(
        (id) => {
          // ══ A LATE ID MUST STILL BE SILENCED (roborev 58971, Medium) ═════════════════════════
          // `correctionTurnId` is null for the whole window between dispatching and this resolving,
          // and `giveUpOnCorrection` can only silence an id it has. So a hold that settles inside
          // that window — the 90s backstop firing on a slow invoke is the ordinary way — used to
          // return here and DISCARD the id, leaving the correction turn unrecognised by
          // `isCorrectionTurn` (the ref is cleared), absent from `lintSilencedRef`, and not
          // superseded (it is the newest id the stream has seen). Its deltas then painted a fresh
          // bubble and its `done` rendered a SECOND answer to a prompt the user never sent — the
          // exact failure `lintSilencedRef` was added to prevent, surviving through the null window.
          if (held.done) {
            if (id !== null) rememberSilenced(id);
            return;
          }
          // A turn with no token cannot be recognised when it finishes, so there is nothing to wait
          // for — render now rather than burn the whole backstop window first.
          if (id === null) {
            giveUpOnCorrection("the correction turn returned no id", held);
            return;
          }
          held.correctionTurnId = id;
          // The correction may never itself be held: this is the second of the two guards on the
          // retry ceiling, and the one that survives a later edit routing corrections elsewhere.
          rememberRetried(id);
        },
        (err) => {
          // ══ NO QUEUE SURGERY HERE (contrast `dispatchTurn`'s rejection handler) ═══════════════
          // That one clears the queue on `ConciergeAiDisabledError` because a STICKY rejection
          // would otherwise cascade through every waiting user message. A correction has no queue
          // entry and no waiters — `canHoldFor` refused the hold if anyone was queued — so the
          // sticky/transient distinction has nothing to decide here. The one correct response to
          // either is the same: the user gets the reply that was held.
          //
          // SCOPED TO `held`, like the timer above. A rejection can land long after its own hold
          // settled, and an unscoped give-up would then tear down the hold that is current now.
          if (held.done) return;
          console.warn("conciergeLint: the correction turn failed to start", err);
          giveUpOnCorrection("the correction turn failed to start", held);
        },
      );
      return true;
    };

    /** The correction turn finished. Renders the correction, or falls back to the held original. */
    const finishCorrection = (e: {
      id: string;
      text: string;
      toolCalls?: readonly ConciergeToolCall[];
    }) => {
      const held = lintHoldRef.current;
      if (!held) return;
      const corrected = e.text || brainTextRef.current[e.id] || "";
      delete brainTextRef.current[e.id];
      // A correction that said nothing is not a correction. The held reply is strictly better than
      // an empty bubble, and this is one of the paths that would otherwise lose a reply outright.
      if (!corrected.trim()) {
        giveUpOnCorrection("the correction turn came back empty");
        return;
      }
      // The correction is linted too — a re-prompt that produced a worse reply must still be
      // marked. This result CANNOT start another hold: the only exit from here is `settleHold`.
      const retry = runReplyLint({
        text: corrected,
        turnId: e.id,
        toolCalls: e.toolCalls,
        // The corpus the HELD reply was linted against, not the held reply itself: `restated-state`
        // would otherwise fire on every correction, since a corrected reply says the same thing.
        prevReply: held.prevReply,
        policy: lintPolicyRef.current,
      });
      const text = retry?.text ?? corrected;
      const retryViolations = retry?.violations ?? [];
      // THE HELD REPLY WAS REVISED — a correction actually replaced it on screen. That is true
      // whether or not the correction is itself clean, and it is the ONLY condition under which
      // this word is written: `giveUpOnCorrection` writes `rendered_marked` for every reply that
      // was never corrected, so the rollup counts revisions that happened, not ones intended.
      const reports: { violations: readonly Violation[]; turnId: string; action: LintAction }[] = [
        { violations: held.violations, turnId: held.turnId, action: "revised" },
      ];
      // `runReplyLint` already reported a clean-or-warning retry itself; only a BLOCKED one is still
      // owed a report, and its action is the give-up word because no third turn is coming.
      if (retry?.blocked && retryViolations.length) {
        reports.push({ violations: retryViolations, turnId: e.id, action: "rendered_marked" });
      }
      settleHold(held, text, retryViolations, reports, e.toolCalls);
    };

    const offDelta = onConciergeDelta((e) => {
      // AN ABANDONED CORRECTION REACHES NOTHING. Above the supersede gate because it cannot help:
      // the correction is the NEWEST id the stream has seen, so `supersededTurn` returns false and
      // these deltas would paint a fresh bubble under the reply they were meant to replace.
      if (isSilencedTurn(e.id)) return;
      if (supersededTurn(e.id)) return;
      // ══ A CORRECTION TURN STREAMS SILENTLY ═════════════════════════════════════════════════════
      // Its text is accumulated (so a `done` carrying none — "the turn whose deltas said
      // everything" — still has a reply to render) but it paints NO bubble of its own and narrates
      // nothing. A second bubble growing under the reply it is replacing, for a turn the user never
      // sent, would be worse than the brief glimpse of the unlinted reply this file already accepts.
      if (isCorrectionTurn(e.id)) {
        brainTextRef.current[e.id] = (brainTextRef.current[e.id] ?? "") + e.text;
        return;
      }
      // A SIGN OF LIFE, and specifically the kind that ANSWERS the user. Recorded before the text
      // lands, and only for a turn that passed the supersede gate above — a straggler from a turn
      // the user already displaced proves nothing about the one they are waiting on now.
      noteConciergeProgress("text");
      // THE REPLY IS ARRIVING — say so. This closes the second of the two dead zones in every turn
      // (the first is the gap before the first tool call, closed by `reading_message` at send): once
      // the last tool has run, the concierge can spend a long stretch writing, and until now the
      // column's most recent line was whatever tool it happened to finish with. That line is stale
      // the moment text starts flowing, and a stale line rendered as live is precisely the class of
      // lie this feature exists to remove.
      //
      // Called on EVERY delta rather than only the first, which means this handler needs no "have I
      // already said this" flag to get wrong across supersedes, retries and the proactive path.
      //
      // THE COST IS PAID IN THE STORE, NOT HERE, and it had to be: deltas arrive roughly per token
      // chunk (Rust passes `--include-partial-messages`), so this fires hundreds of times a turn.
      // `noteConciergePhase` is idempotent — a repeat of the phase already recorded is dropped
      // before it writes — so the indicator re-renders once when composing BEGINS and not again.
      // An earlier version of this comment claimed the repeat was free because "the rendered line
      // is identical"; that was false, since each write was a fresh object literal and the
      // indicator selects `latest` under `Object.is` (roborev 57845).
      noteConciergePhase("composing");
      upsert(e.id, e.text, false);
    });
    // WHAT THE CONCIERGE IS ACTUALLY DOING, tool by tool, while it does it.
    //
    // This is the channel that carries `Bash`/`Read`/`Grep`/`Task` — everything that is NOT a
    // `concierge_tool` control call, which is to say the majority of what a turn spends its time
    // on. Control calls keep their own richer path (services/controlListener → resolved agent names
    // and clickable pills) and are DROPPED here by the phrasing module, so a call cannot be
    // reported twice or have its good line replaced by a generic one.
    const offTool = onConciergeTool((e) => {
      if (isSilencedTurn(e.id)) return;
      // Silent for the same reason its deltas are: narrating a rewrite the user never asked for
      // puts "Read", "Grep" into the column under a reply that already finished.
      if (isCorrectionTurn(e.id)) return;
      // The same supersede gate every other handler in this effect applies. `services/concierge`
      // has already filtered on `turnIsCurrent` and Rust refuses to emit for a dead turn at all;
      // this is the third guard, kept for the reason the delta path keeps its own — the failure it
      // prevents (a displaced turn narrating the column the user is now watching) is exactly the
      // ambiguity that made the founder ask "are you there".
      if (supersededTurn(e.id)) return;
      noteConciergeNativeToolCall(e.name, e.input);

      // ══ THE DELEGATION LADDER (bead sparkle-6vool) ════════════════════════════════════════════
      // The founder, 2026-08-13: "I have eight queued props that you're not responding to. Because
      // you're not using concierge agents but should be." This is the mechanical backstop: count
      // consecutive investigative calls and push back when the concierge is grinding through them
      // instead of dispatching `sparkle_research`.
      //
      // FOLDED HERE because this is the only channel that reports a tool call WHILE THE TURN RUNS.
      // The `done` event carries the same list, but it arrives after the founder has already done
      // the waiting the ladder exists to prevent.
      //
      // The queue depth is what makes it hair-trigger: 6 calls normally, 2 when messages are
      // stacked up behind this turn (the founder's own threshold choice).
      const fold = noteDelegationToolCall(delegationRef.current, e, {
        turnId: e.id,
        queuedCount: waitingCount(turnQueueRef.current),
      });
      delegationRef.current = fold.state;
      if (fold.decision.action === "nudge") {
        const { rung, text, serial } = fold.decision.nudge;
        // DELIVERY IS NOT INSTANT, AND THE COMMENT SAYS SO RATHER THAN IMPLYING OTHERWISE. There is
        // no channel that interrupts a `claude -p` turn already in flight, so the notifier's push
        // lands at the next turn boundary. A refusal (`false`) means it went nowhere at all — worth
        // a line, for the same reason `notifyConcierge` logs its own refusals.
        const delivered = notifyConcierge(text);
        log.warn(
          "concierge",
          `delegation nudge #${rung}: ${serial} investigative call(s), 0 delegations` +
            (delivered ? "" : " — push refused, nudge not delivered"),
        );
      }
    });
    // ══ EVERY EXIT FROM `done` ENDS THE BUBBLE'S LIFE — ONE PLACE, NOT FOUR (roborev 62936) ═══════
    // `offError` marks above every gate for a stated reason ("a fifth exit added later cannot
    // silently miss it"), and this handler has FOUR early returns that can each leave a painted
    // bubble on screen forever. Marking them one by one repeats the miss-prone shape, and the first
    // attempt did exactly that — it covered the supersede return and left the silenced one, which is
    // reachable with a bubble: `isCorrectionTurn` reads a ref that is `null` for the whole window
    // between dispatching a correction and `startConciergeTurn` resolving, and the correction's
    // deltas paint during it.
    //
    // AFTER the body, never before — this is the ordering the whole fix turns on. `markStreamEnded`
    // no-ops on a bubble that settled, so on the normal path the `markSettled` below wins and the
    // capture indexes the FINAL text. Running it first would mark the bubble final while it still
    // held its streamed text, which is the exact defect (roborev 62934) this sequence exists to fix.
    const onDoneEvent = (e: { id: string; text: string; toolCalls?: ConciergeToolCall[] }) => {
      // A correction its hold already gave up on. Dropped whole — rendering it now would append a
      // SECOND answer, to a prompt the user never sent, under the reply that replaced it.
      if (isSilencedTurn(e.id)) {
        // NOTHING REACHED THE FOUNDER, so nothing is claimed: this reply is discarded whole, and
        // any research finding it carried is still owed. `abandon` releases the staging and the
        // next turn names the finding again.
        researchDrain.abandon(e.id);
        delete brainTextRef.current[e.id];
        return;
      }
      // ══ THE CORRECTION TURN ENDS HERE AND NOWHERE ELSE ═════════════════════════════════════════
      // ABOVE the supersede gate deliberately. If the user has sent again, the correction IS
      // superseded — and dropping this event on that ground would strand the held reply until the
      // backstop timer, leaving the violating text on screen for a minute and a half. The reply the
      // user is waiting on now comes through its own turn regardless; this only settles the one
      // that was already answered.
      if (isCorrectionTurn(e.id)) {
        // A correction DELIVERS — `finishCorrection` renders the held reply — so a finding this
        // turn carried has reached the founder and is claimed like any other.
        researchDrain.settle(e.id);
        finishCorrection(e);
        return;
      }
      if (supersededTurn(e.id)) {
        // THE CASE THE WHOLE SPLIT EXISTS FOR. The user sent again, `concierge.rs` killed this
        // child, and its text is dropped here without ever being rendered — so this turn told the
        // founder nothing, and its findings must survive it. Claiming at prompt-build time would
        // have destroyed them at exactly this moment, which is the ordinary outcome of two fast
        // sends rather than an edge case.
        researchDrain.abandon(e.id);
        // NOTE the comment above is about the ACCUMULATOR, which really is dropped unrendered. The
        // BUBBLE is a different object and may already hold text: `offDelta`'s supersede gate only
        // stops deltas from the moment the displacement is KNOWN, so anything earlier is painted and
        // stays. It is marked ended by this handler's `finally`, not here — and for the ordinary
        // double-send, where no `done` arrives at all, by `endStreamsThrough` at send time.
        delete brainTextRef.current[e.id];
        return;
      }
      // The turn spoke. THIS is the only place a user turn's findings are claimed.
      researchDrain.settle(e.id);
      // A push owns no typing indicator — nobody is waiting on it. The Rust command stands down
      // for any user turn so the two should never overlap, but if that ever changes, clearing here
      // would take the indicator away from the reply the user IS waiting on.
      if (!isProactiveTurn(e.id)) {
        setTyping(false);
        // DRAIN THE QUEUE (sparkle-t8wsj). The turn that was holding the slot is over, so the next
        // waiting message may start. Reads the ref rather than the mirrored state: several turn-ended
        // events can land in one tick, and state would still show the queue as it was.
        // The turn is over and it answered. Clears every liveness escalation, including a latched
        // UNAVAILABLE — "recovering must clear the state promptly", and this is the recovery.
        // A push is excluded for the same reason it does not own the typing indicator: it is not
        // the thing anyone is waiting on.
        noteConciergeSettled();
        // This bubble got its answer, so the NEXT send has nothing to orphan. Without this, every
        // message would be stamped "never answered" by whatever the user typed after it.
        awaitingBubbleRef.current = null;
        setAwaitingId(null);
      }
      // ══ THE LINTER RUNS HERE ═══════════════════════════════════════════════════════════════════
      // The reply is COMPLETE at `done`, which is what the checks need: mid-stream, `[@Left Pai` is
      // not yet a pill and every check would false-positive at per-token cost.
      //
      // This lands on the `replace: true` upsert that already existed — the final text overwrites
      // the streamed bubble wholesale today, so a linted rewrite needs no new render mechanism.
      //
      // ONE HONEST LIMITATION, ACCEPTED: deltas paint live, so a violation CAN be briefly visible
      // before this replaces it. The durable record — thread store, clipboard, persistence, and the
      // next turn's context — is always linted. Closing the glimpse would mean suppressing live
      // streaming or reimplementing every check in Rust (which never sees the roster), and neither
      // is worth it.
      const linted = e.text
        ? runReplyLint({
            text: e.text,
            turnId: e.id,
            toolCalls: e.toolCalls,
            prevReply: prevReplyRef.current,
            policy: lintPolicyRef.current,
          })
        : null;
      // ══ AND ITS FINDINGS RIDE ONTO THE BUBBLE (bead sparkle-kr2jz, part A) ═════════════════════
      // Until now `runReplyLint`'s `violations` were dropped here — only `.text` was read — so every
      // finding reached an in-memory counter nothing displays and a JSONL only a CLI reads. The
      // detection worked and was invisible, which for the founder is the same as absent.
      //
      // Attached to the `replace: true` upsert that already existed, exactly as the linted text is:
      // the final text overwrites the streamed bubble wholesale, so the marks need no new render
      // mechanism and cannot land on a bubble other than the one they were found in. They inherit
      // the SAME accepted limitation the comment above states — deltas paint live, so an unmarked
      // reply is briefly visible before this replaces it.
      //
      // `toLintMarks` narrows each violation to metadata (check / severity / detail) and drops
      // `span`; see Concierge/lintMarks for why that boundary is enforced by the type.
      // ══ AND A BLOCKING FINDING HOLDS IT BACK, ONCE (bead sparkle-ugohl) ════════════════════════
      // Nothing below runs for a held reply: it is not rendered, not marked, not stamped settled,
      // and does not become `prevReply`, because none of those are true of it yet. `settleHold`
      // does every one of them against the text that actually lands. The queue still drains — the
      // turn is over as far as `concierge.rs` is concerned — and `canHoldFor` has already refused
      // the hold if anything was waiting behind it.
      if (linted?.blocked && e.text && canHoldFor(e.id) && takeHold(e, linted)) {
        delete brainTextRef.current[e.id];
        if (!isProactiveTurn(e.id)) drainQueueRef.current();
        return;
      }
      // A blocked reply that could NOT take a correction turn still has to be counted:
      // `runReplyLint` deferred its violations precisely because the outcome was unknown, and this
      // is the outcome — rendered, marked, no revision. Without this they would be the one class of
      // violation the counters never see, which is worse than the miscount the deferral prevents.
      if (linted?.blocked && linted.violations.length) {
        try {
          reportLintOutcome({
            violations: linted.violations,
            turnId: e.id,
            action: "rendered_marked",
            policy: lintPolicyRef.current,
          });
        } catch (err) {
          console.warn("conciergeLint: reporting an unretried blocked reply failed", err);
        }
      }
      const marks = toLintMarks(linted?.violations);
      if (e.text) upsert(e.id, linted?.text ?? e.text, true, marks);
      // ══ AND THE MOUNTED COLUMN, WHICH CANNOT SHOW A THREAD ROW AT ALL (roborev 57360's problem) ═
      // Display-mounted, `ConciergeColumn` renders the agent's transcript and does NOT render
      // `ConciergeThread` — so the mark, which lives inside a thread row, is written off screen
      // along with the reply it annotates. That is the same hole `MountedNotice` was added for, so
      // it gets the same compensation rather than a second mechanism.
      //
      // `info`, never `warn`: `warn` is reserved for a refusal, where nothing was sent and the
      // founder's words are back in the box waiting on him. A lint finding is an observation about a
      // reply that was delivered — it asks for a glance, not an action — and borrowing the refusal's
      // register would cry wolf over the one tone that must stay urgent.
      //
      // Keyed on the DISPLAY mount (`displayMountedRef`), not the routing one, for the reason that
      // ref's own comment gives: whether the thread is hidden is what decides this, and gating on
      // routing both suppresses the notice in the display-mounted-but-unroutable state and paints a
      // banner over a perfectly visible thread when nothing is mounted at all.
      const lintLine = lintMarkText(marks);
      if (lintLine && displayMountedRef.current) noteMounted(lintLine, "info");
      // THE TURN FINISHED — recorded on the bubble, because "a left-aligned bubble exists" and "the
      // brain finished answering" are different facts and the reply-anchor rule needs the second one
      // (see Concierge/types `ConciergeSparkleMessage.settled`). Kept OUT of the upsert above: that
      // one is skipped entirely for a `done` carrying no text, which is exactly a turn whose deltas
      // said everything — the case where the flag would silently never be set.
      markSettled(e.id);
      // ══ DRAIN LAST — AFTER THE TEARDOWN *AND* AFTER THE REPLY IS STAMPED (roborev 58223-M1) ═════
      // Two earlier positions were both wrong, and the second is the instructive one.
      //
      // Before the teardown: dispatch raises the new turn's state and the teardown then cleared it
      // (probe 3). Moved after the teardown but still ABOVE the stamp: `dispatchTurn` removes the
      // newly-started message from `neverSentRef`, so by the time the reply's anchors were computed
      // the queued message no longer looked unsent and the filter let it through — the SAME
      // cancellation the set was introduced to prevent, one level down. A set recorded at enqueue is
      // only order-independent if nothing mutates it in between, and dispatch does.
      //
      // Last is the only position where both hold: the teardown has run, the reply has been stamped
      // against the queue as it stood while that turn was the one being answered, and only then does
      // the next turn start.
      //
      // ══ AND STILL ONLY FOR A USER TURN (roborev 58503) ═══════════════════════════════════════
      // Moving this to "last" also moved it OUT of the `!isProactiveTurn` block above, which made it
      // unconditional — and `turnFinished` is deliberately id-agnostic: it releases whatever is in
      // `running` and dispatches the next waiter, without checking that the ending turn is the one
      // holding the slot. So a PUSH's terminal event released a USER turn's slot.
      //
      // The damage is the thing the queue exists to prevent. A push whose reply arrives in one chunk
      // emits no delta, so `latestTurnRef` stays below it; the user then sends M1 (running) and M2
      // (queued); the push's buffered `done` passes the supersede gate, skips the teardown because
      // it is proactive, and — unguarded — drained: M2 dispatched while M1 was still streaming, and
      // `concierge.rs` killed M1's child. The error handler kept its own proactive guard, so the two
      // terminal paths were also asymmetric.
      if (!isProactiveTurn(e.id)) drainQueueRef.current();
      // ══ THE PROMISE LEDGER (sparkle-gfume) ═══════════════════════════════════════════════════
      // Measured across all 1,490 logged turns: 45 first-person promises made, 9 kept, 35 dropped.
      // The linter above cannot see this — it compares a claim against THIS turn's calls and
      // deliberately ignores future tense, because "I'll do that next" is the honest form. A promise
      // is about a LATER turn, so it needs a ledger.
      //
      // Same seam as the linter and the receipt path, so "a turn happened" is decided in one place.
      // Guarded: a bookkeeping module must never be able to cost the user their reply.
      // The FULL reply, not just `e.text` (roborev 58101). This handler documents twelve lines above
      // that a `done` can carry no text — "exactly a turn whose deltas said everything" — and the
      // reply for such a turn lives in `brainTextRef`. Reading only `e.text` silently skipped promise
      // DETECTION for every one of those turns, which is a promise the ledger can never later report.
      const replyText = e.text || brainTextRef.current[e.id] || "";
      // The reply is indexed for `search_history` — but by the thread-store subscriber, not from
      // here (sparkle-yd1ud × sparkle-s7rfc; see the import block). The subscriber reads THE TEXT
      // THE FOUNDER WAS ACTUALLY SHOWN by construction, including turns whose `done` carries no text
      // of its own, because it reads the bubble rather than the event.
      try {
        for (const p of noteConciergeTurnForPromises({
          id: e.id,
          text: replyText,
          toolCalls: toLintToolCalls(e.toolCalls),
          at: Date.now(),
        })) {
          // Quotes the sentence back, which is what makes it checkable rather than abstract —
          // "You said you'd …" is the founder's own complaint, answered in his terms.
          postSparkle(line`You said you'd ${plain(promiseVerbPhrase(p.family))} — ${plain(oneLine(p.sentence))} — and that hasn't happened.`);
        }
      } catch (err) {
        console.warn("concierge: promise ledger failed; the reply is unaffected", err);
      }
      // Recorded AFTER this turn is linted, so `restated-state` compares against the previous reply
      // rather than against itself. Stores the text as RENDERED (autofixes included): the check asks
      // whether the human is being told the same thing twice, and what they were told is the
      // rendered form.
      if (e.text) prevReplyRef.current = linted?.text ?? e.text;
      const full = brainTextRef.current[e.id] ?? "";
      delete brainTextRef.current[e.id];
      // The reply is FINISHED here — announce it once, rather than per delta. Via `announce`, so
      // the SAME reply twice in a row is still announced twice (roborev 53392).
      //
      // This carries the LINTED text, and it matters that it does: this is the column's single
      // aria-live region, so a screen-reader user gets THIS and not the visual thread. For them the
      // announcement is not the "mid-stream glimpse" the mount above accepts — it is the delivery.
      //
      // It works through a two-step coupling rather than by saying so here (roborev 55981 read it
      // as a bug for that reason, and it is not one): `full` is `brainTextRef.current[e.id]`, and
      // the replace-upsert immediately above has already overwritten that ref with exactly the text
      // it rendered. Re-deriving `linted?.text ?? full` here would be the same value by a second
      // route. Pinned instead by a test on the live region, so the coupling cannot quietly break.
      if (full) announce(full);
    };
    const offDone = onConciergeDone((e) => {
      try {
        onDoneEvent(e);
      } finally {
        // EXCEPT A HELD REPLY, whose text is the one thing here that is NOT decided yet (roborev
        // 62937). `takeHold` returns without rendering precisely because the correction turn may
        // still replace this bubble's words, and `settleHold` is its real terminal marker — it
        // renders whichever text finally wins and calls `markSettled`. Stamping `streamEnded` here
        // would tell the history capture the VIOLATING draft is final, which is the exact defect
        // (roborev 62934) the marker exists to prevent, on the exact path its header names as worst.
        //
        // NOT left to `blankHeldBubble`'s empty text to save us. That works today only because a
        // blank bubble yields no entry, which is an invariant of a DIFFERENT function — and one
        // straggling delta landing on `brain-<n>` between this stamp and `settleHold` (a shape this
        // file codes for elsewhere, and which `offDelta` does not gate for the original turn) would
        // record the draft and dedupe the correction away forever.
        if (lintHoldRef.current?.turnId !== e.id) markStreamEnded(e.id);
      }
    });
    const offError = onConciergeError((e) => {
      // ══ AN ERRORED TURN CLAIMS NOTHING ═════════════════════════════════════════════════════════
      // Every branch below ends the turn without a reply — a real failure, a superseded sentinel, a
      // declined push, an abandoned correction. None of them told the founder what came back, so
      // the findings stay unread and ride the next turn. One call above every gate, because there
      // is no error path on which claiming would be correct.
      researchDrain.abandon(e.id);
      // AND NEITHER DOES ONE GROW ANY FURTHER — same reasoning, same placement (roborev 62935).
      // Whatever a failed turn had already painted is the last text that bubble will ever hold, on
      // every branch below, so the marker goes above every gate rather than being repeated at the
      // four exits that can leave one on screen (superseded, superseded-detail, proactive, and the
      // real failure). A fifth exit added later would otherwise silently miss it — and what it would
      // miss is a reply the founder can still scroll back to never becoming searchable. No-op where
      // there is no bubble, which is the silenced and correction cases.
      markStreamEnded(e.id);
      // Likewise for an abandoned correction's failure: there is no hold left to settle, and it must
      // not raise the user-facing failure bubble below.
      if (isSilencedTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      // ══ A CORRECTION TURN'S FAILURE IS NOT THE USER'S FAILURE ══════════════════════════════════
      // Above every gate below, for the reason the `done` interception is: superseded or not, the
      // held reply has to render. And it must NOT take the failure path underneath — no failure
      // bubble, no liveness escalation, no auth report. The user asked a question and the concierge
      // answered it; that a private rewrite of that answer did not work out is plumbing, and a
      // "your concierge isn't answering" strip over a reply that is right there would be a lie.
      if (isCorrectionTurn(e.id)) {
        delete brainTextRef.current[e.id];
        giveUpOnCorrection(`the correction turn errored (${e.detail || "no detail"})`);
        return;
      }
      if (supersededTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      // A sentinel detail is never a failure to TELL the user about — it means their own newer send
      // (or cancel) displaced this turn, and that newer turn is the one streaming (roborev 53460).
      // `startConciergeTurn` already silences these on the invoke-rejection path; this closes the
      // EVENT path, which was unfiltered by detail and whose only guard was `supersededTurn` above —
      // and that guard misses a turn which failed before streaming anything, because the send-time
      // floor can only retire ids an event has been seen for.
      //
      // Deliberately does NOT clear typing, exactly as the superseded branch above doesn't: the
      // turn that displaced this one is still talking and owns the indicator.
      if (isSupersededDetail(e.detail)) {
        delete brainTextRef.current[e.id];
        return;
      }
      // NOT FOR A PUSH (roborev 55442-M2, placement corrected in 55468-M2). `offDone` above already
      // stands down for the proactive channel and this must match it: nobody asked for that turn, so
      // its failure is not a question that went unanswered, and three failed pushes must not raise a
      // sticky "your concierge isn't answering" strip over a conversation the user never started.
      //
      // ABOVE `setTyping(false)`, not below it — which is where this guard first landed, and that
      // placement did not buy the parity the paragraph above claims. `offDone` wraps its own
      // `setTyping(false)` in this same condition precisely because clearing it "would take the
      // indicator away from the reply the user IS waiting on", and services/concierge names the
      // identical consequence for the error path. A push failing while a user turn streams would
      // still have killed that user turn's indicator — the one effect this guard exists to prevent.
      //
      // services/concierge filters pushes before the fan-out today, so this is defence in depth
      // rather than a live bug — but engine/conciergeLiveness's header states the property as an
      // invariant of THIS call site, and a header that asserts what the code does not enforce is how
      // the last three rounds of findings happened.
      //
      // The partial-text drop stays UNCONDITIONAL: a push's failed turn leaks the same way a user
      // turn's does, so it is done on both sides of the return.
      if (isProactiveTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      setTyping(false);
      // DRAINED ON FAILURE TOO, and that is deliberate: if a failed turn did not release the slot,
      // one quota rejection would strand every question queued behind it — the 2026-07-29 burst
      // turned into a permanent stall instead of a recoverable one.
      // A failed turn never reaches the done handler, so drop its partial text here rather than
      // retaining every failed reply for the life of the session.
      delete brainTextRef.current[e.id];
      // THE SWALLOW THIS FIXES. `e.detail` used to die on this line: every failure there has ever
      // been rendered the same fixed sentence, and on 2026-07-29 that sentence stood in for fifteen
      // quota rejections carrying a reset time and a settings URL — "You've hit your session limit ·
      // resets 8:40am (America/Bogota)". The human spent the day assuming a 529 overload, and the
      // advice they were given ("try me again in a moment") is the one thing that could not work.
      //
      // `conciergeFailureNotice` is TOTAL and always carries the evidence, including for a failure
      // it cannot classify — a classifier that only spoke for recognised errors would re-create this
      // exact bug one unknown failure at a time.
      noteConciergeFailed(e.detail);
      // A failure is an ANSWER — the user was told what happened. Not an orphan, so the next send
      // must not stamp this bubble "never answered" on top of the error it already carries.
      awaitingBubbleRef.current = null;
      setAwaitingId(null);
      // ══ DRAINED AFTER TEARDOWN, NEVER BEFORE (probe 3) ═══════════════════════════════════════════
      // `drainQueue` DISPATCHES the next turn, and dispatch sets the awaited bubble, starts the
      // liveness clock and raises the typing indicator. Every one of those is state about the turn
      // that just STARTED — so running it before this handler's teardown meant the teardown then
      // cleared them: `noteConciergeSettled` stopped the new turn's clock and the null-out dropped
      // its bubble association, leaving turn N+1 running with no message attached to it.
      drainQueueRef.current();
      const notice = conciergeFailureNotice(e.detail);
      setChat((prev) => [
        ...prev,
        {
          id: nextId("err"),
          kind: "failure",
          headline: notice.headline,
          evidence: notice.evidence,
          // The headline for an auth failure now says "sign in again", so the bubble must carry the
          // control that does it — a remedy string is an instruction the user will follow, and one
          // naming an action the UI does not offer is how the previous copy sent desktop users to a
          // terminal.
          canReauth: notice.kind === "auth",
        },
      ]);
      // TELL THE GATE. The founder's case was a FOCUSED app: he typed a question and the concierge
      // child was the thing that discovered the session was dead. ReadinessGate's focus re-probe
      // cannot see that — the window never lost focus — so without this the app would keep serving
      // the last healthy probe while every turn failed.
      //
      // This reports EVIDENCE, not a verdict: the gate re-runs its own live `claude auth status` and
      // decides. So a misclassified failure costs one cheap probe and changes nothing, which is why
      // it is safe to fire on the classifier's word.
      if (notice.kind === "auth") reportClaudeAuthFailed();
      // Through the column's ONE live region, like every other bookkeeping line. The HEADLINE only:
      // the evidence can be a multi-line stderr dump, and a screen reader reading forty lines of
      // warnings aloud buries the sentence that says what to do.
      announce(notice.headline);
    });
    // THE TURN STATE THAT `done`/`error` OWN, WHEN NEITHER IS COMING (roborev 55813).
    //
    // services/concierge gates the fan-out on identity, so a turn the previous human started has its
    // terminal event DROPPED — right for the content, and it would strand every teardown above. This
    // component stays mounted across sign-out, `typing` is plain `useState`, and `noteConciergeSettled`
    // is the only thing that unlatches UNAVAILABLE; none of it is store state
    // `resetConciergeIdentityState` can reach. Without this the spinner keeps running for the next
    // human over an empty column, a latched "your concierge isn't answering" can arrive about a turn
    // they never sent, and their first send is stamped "never answered" on the previous human's bubble.
    //
    // A lifecycle signal rather than a synthesised `done`, because "your turn finished" and "the turn
    // was abandoned" are different claims — this one carries no id and no text, so there is nothing of
    // the previous human's left to render.
    const offReset = onConciergeTurnsAbandoned(() => {
      // BEFORE the wipe below, which clears `brainTextRef` wholesale. A held reply is one the user
      // already watched stream in; abandoning the turns must not be the thing that finally deletes
      // it, and no correction is coming for it now.
      giveUpOnCorrection("the concierge's turns were abandoned");
      setTyping(false);
      // DISCARD, never drain. The conversation was thrown away; starting a queued turn here would
      // resurrect a question the user just discarded — which is why `clearQueue` is a separate
      // entry point from `turnFinished` rather than a flag on it.
      turnQueueRef.current = clearQueue();
      setTurnQueue(turnQueueRef.current);
      // `clearConciergeLiveness`, not `noteConciergeSettled`: the turn did not settle, and an identity
      // boundary must not preserve a field a turn boundary would.
      clearConciergeLiveness();
      awaitingBubbleRef.current = null;
      setAwaitingId(null);
      // Every partial reply, not just the abandoned turn's — the ids belong to the previous human and
      // no `done` is coming for any of them to drain the map.
      brainTextRef.current = {};
    });
    return () => {
      // The thread store is module-scoped and persisted, so `settleHold` still lands after this
      // component is gone — which makes rendering the held reply on the way out strictly better
      // than clearing the timer and dropping it. Losing a reply is the one failure this design does
      // not accept, and "the column unmounted" is not an exception to that.
      giveUpOnCorrection("the concierge column unmounted");
      settleLintHoldRef.current = () => {};
      offDelta();
      offDone();
      offError();
      offTool();
      offReset();
    };
    // `noteMounted` is `useCallback(…, [])`, so naming it here satisfies the lint rule without
    // making the brain subscription tear down and re-listen — which is the thing this array has to
    // keep true, since a resubscribe mid-turn would drop the events still arriving for it.
  }, [announce, noteMounted]);

  // ══ AN INHERITED TURN IS DISCARDED, NOT MERELY SILENCED ══════════════════════════════════════
  //
  // The liveness store is module-level and outlives this host, which unmounts whenever no project is
  // open (App.tsx). The listeners above are this host's — a turn in flight when the project closes
  // loses them, so no `done` and no `error` will ever reach the detector again and `silentSince`
  // stays set for the rest of the session. Whatever that turn's state was, NOBODY IS WAITING FOR IT.
  //
  // Muting it is not enough (roborev 56194). An earlier version guarded only the announcement, with
  // a per-mount ref, and left the state itself in place — so the row still painted RED on frame one
  // of a brand-new question the app had zero silence evidence about, and, because the ref had been
  // seeded with `stalled` and nothing but observed output unlatches, the announcer could then stay
  // mute for the whole mount in exactly the degraded case the feature exists for. Silencing the
  // words while keeping the wrong colour is the worst of both.
  //
  // So the wait is DISCARDED at mount. The first reading is then a genuine `idle`, the latch never
  // fires for an abandoned turn, and every real escalation afterwards speaks through the ordinary
  // transition rule.
  //
  // MOUNT-ONLY, and safe to be unconditional: a send is user-driven and cannot have happened between
  // this host's first render and its first effect, so there is never a live turn of its own to
  // discard. (A remount mid-turn — a key change rather than a project close — would drop the
  // accumulated silence and read gray until the next delta restores the clock. That is a mild,
  // self-healing degradation in a rare case, against a permanent wrong state in a case that happens
  // whenever someone closes a project mid-question.)
  useEffect(() => {
    clearConciergeLiveness();
  }, []);

  // ══ THE PROACTIVE PUSH CHANNEL ═══════════════════════════════════════════════════════════════
  //
  // The brain speaking FIRST, with no user message behind it (services/conciergeProactive, PRD
  // §2a). The trigger and every cost control are pure and live in that module; this is the whole of
  // the wiring — a clock, the browser's timers, and the transport.
  //
  // WHY IT MOUNTS HERE. This host is the only thing that both observes the feed on every roster
  // tick and owns the thread the push has to land in. It is also mounted unconditionally for the
  // life of the window, so the channel neither restarts nor duplicates as the user moves around.
  useEffect(() => {
    const s = createProactiveScheduler({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h),
      // The research drain's second seam (§3.3's free improvement). Consulted by `fire` only once
      // it has already decided to speak, so a finding never buys a push of its own.
      peekResearch: () => researchDrain.peek(),
      startTurn: async (prompt, digest, researchTaskIds) => {
        const id = await startProactiveConciergeTurn(prompt);
        // Null means no turn ran — the user owns the conversation, or the bridge failed. Reporting
        // that honestly is what keeps the change pending instead of silently swallowed.
        //
        // The findings go with it: nothing is staged, so nothing can be claimed, and the next turn
        // (push or send) carries them again.
        if (id === null) return false;
        // Staged, not claimed — this push can still be superseded before it renders, and `offDone`
        // / `offError` above are what decide which of those two happened.
        researchDrain.stage(id, researchTaskIds);
        pushDigestRef.current.set(id, digest);
        const oldest = pushDigestRef.current.keys().next();
        if (pushDigestRef.current.size > 16 && !oldest.done) pushDigestRef.current.delete(oldest.value);
        return true;
      },
    });
    schedulerRef.current = s;
    // THE PUSHER'S ROUTE TO THE CONCIERGE (sparkle-4cd0x). Registered here rather than exposed as a
    // transport because this host is what makes a push retractable — it records each turn's digest
    // so `markStaleProactive` can strike the message when the state moves past it. A caller reaching
    // `concierge_proactive_turn` directly would get an unretractable push, which the scheduler's own
    // header warns about. Handing over `s.notify` keeps every cost control and that guarantee here.
    const notify = (text: string) => s.notify(text);
    setConciergeNotifier(notify);
    return () => {
      clearConciergeNotifier(notify);
      s.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // ══ WATCH THE RESEARCH TASKS ═════════════════════════════════════════════════════════════════
  //
  // Two jobs, both cheap. One refresh at mount so a window opened after a task finished still knows
  // about it — the store is a cache and the disk is the truth, so an empty store means "we have not
  // looked", never "there is nothing". And a subscription so `research_completed` is recorded when
  // a task actually reaches its terminal state rather than whenever a turn happens to start.
  //
  // The event log used to be the ONLY thing carrying a FAILED or CANCELLED task to the concierge,
  // because the prompt preamble was `done`-only (`isUnread`). It is not any more: those tasks now
  // get their own preamble section, which is also what lets their rows retire. This subscription
  // still earns its place as the replayable account of how each task ended — but it is no longer
  // the thing standing between a failure and silence. `observe` is idempotent per task — it reports
  // each id once — so a subscription that fires on every store write is safe.
  // ── AND A POLL, WITHOUT WHICH THE WHOLE FEATURE IS INERT ────────────────────────────────────
  //
  // The store is written by the mount refresh and by the refresh that follows a claim — and a claim
  // only happens for a finding ALREADY in the cache. Nothing re-listed while the window stayed open.
  // So the primary scenario this bead exists for — the concierge dispatches research, it finishes
  // minutes later, the next turn reports it — could never fire: the task stayed `running` with
  // `findings: null`, `isUnread` was false, the preamble stayed empty, and `observe` never saw a
  // terminal status so no `research_completed` was recorded either. The feature was dead for the
  // whole session unless the window happened to remount after a task finished.
  //
  // A poll is the honest fix while the runner has no change event to listen on. THE POLL ITSELF NOW
  // LIVES IN `ConciergeAgentsRow` — see the long comment on its mount effect. It was here first, and
  // that was wrong in both directions: this component paints no row, and the row is rendered in
  // windows where this component is not mounted at all (a torn-off satellite) — so those windows
  // never refreshed while this one polled for a row it does not own (roborev 61724).
  //
  // What stays here is the DRAIN's view of the store. `observe` has to watch every task the cache
  // learns about, whoever refreshed it, so it subscribes rather than polling; the mount refresh is
  // kept so a host that opens before any row exists still sees what is already on disk.
  useEffect(() => {
    void refreshResearch();
    const unsubscribe = useResearchStore.subscribe((s) =>
      researchDrain.observe(Object.values(s.byId)),
    );
    return unsubscribe;
  }, []);

  // Feed the trigger, and retract any push the state has moved past.
  //
  // BOTH ON THE SAME TICK, deliberately. A push is an append-only thread entry, so the moment its
  // sentence stops being true it is the app volunteering something false — worse than having said
  // nothing. `markStaleProactive` returns the SAME array when nothing needed marking (the
  // overwhelmingly common case), so this costs one string build and one identity comparison per
  // roster tick and re-renders nothing.
  useEffect(() => {
    schedulerRef.current?.observe(feed);
    const digest = surfacedDigest(feed);
    setChat((prev) => markStaleProactive(prev, digest));
  }, [feed]);

  const resolveAgent = useCallback(
    (id: string) => allAgents(feedRef.current).find((a) => a.id === id) ?? null,
    [],
  );

  /**
   * Reveal an agent in column two, ENFORCING the two gates that can otherwise leave a reveal
   * pointing at nothing. The reveal path for column one's NUDGE AND DIGEST surfaces — not for the
   * command palette, which still bypasses it; see SCOPE below.
   *
   * `openProjectTab` selects and mounts, but two pieces of pre-existing UI state decide whether a
   * row is actually DRAWN — and for an agent with no row of its own, both default to hiding it:
   *
   *   1. `collapsedOrchestrators` reads a missing entry as COLLAPSED, and no path opens a subtree on
   *      the APP'S OWN initiative — so on a fresh launch the head's subtree is shut and the reveal
   *      lands on a terminal pane above zero worker rows. (This used to read "and
   *      `expandOnWorkerAttention` skips first sighting"; that function is gone with app-driven
   *      expansion, which makes the gate STRONGER, not weaker. Note the claim is about INITIATIVE,
   *      not about being the sole writer: several user-initiated reveals still call
   *      `expandOrchestrators` — see the note at the digest-click site below.)
   *   2. The sidebar applies `statusFilter` to heads, so a `running` orchestrator is not drawn at
   *      all when `running` is off — which a prior rows-variant digest click turns off by design.
   *
   * SCOPE: every reveal on COLUMN ONE'S NUDGE/DIGEST PATH — the digest line's click, a singleton's
   * card click, and that card's "Show me" (roborev 53734 fixed the first; 53737 caught the other
   * two). It is deliberately not claimed to be the app's only reveal path, because it is not:
   * `Concierge/paletteJump.ts` still wires `focusAgentElsewhere`/`openInWindow` to a bare
   * `openProjectTab` and `selectAgentHere` to the runtime/project stores, so a command-palette jump
   * onto a nested worker lands in exactly the state described above. That gap predates this helper
   * and is tracked as bead `sparkle-bel2` (raised by roborev 53740) — stated here rather than left
   * for the docstring to imply it is closed, which would be worse than leaving it undocumented.
   *
   * A top-level agent owns its row, so there is nothing to EXPAND for it — but there is very much a
   * filter to clear, and an earlier version of this sentence said otherwise and was wrong
   * (roborev 58713). Top-level rows are exactly what `groupAgentsByStage` band-filters
   * (engine/buildSections — `if (!visibleBands[bandOf(agent.id)]) continue`), so skipping the clear
   * for them left a `done` agent undrawn while the caller announced it was already open.
   */
  const revealAgent = useCallback((a: ConciergeAgent): RevealOutcome => {
    // TAKEN FIRST, before anything below writes. Same reason `openAgentFromPill` takes it first:
    // every write on this path is idempotent, so afterwards "it was already like that" and "I just
    // made it so" are indistinguishable from the store (bead sparkle-ixsb3).
    const planned = revealOutcomeFor(a.projectId, a.id);
    // …AND THE ROW-SURFACING COUNTS AS A VISIBLE CHANGE. `revealOutcomeFor` models the reveal
    // path's writes, not these two, so a worker whose band was filtered out or whose orchestrator
    // was collapsed would otherwise be reported as "already showing" while a row the reader could
    // not see a moment ago appears. Measured rather than assumed: both setters are no-ops when the
    // state already holds, so this is only true when something really was hidden.
    const ui = useUiStore.getState();
    // ── WAS THE ROW THE READER ASKED FOR ACTUALLY DRAWABLE? ────────────────────────────────────
    //
    // THE BAND THAT GATES A ROW IS NOT ALWAYS THAT AGENT'S OWN. The sidebar band-filters exactly
    // ONE population — the TOP-LEVEL rows — and does it by the head's ROLLED-UP band
    // (AgentSidebar's `groupAgentsByStage(topLevelOf(...), …, statusFilter, rowBandOf)` →
    // engine/buildSections `if (!visibleBands[bandOf(agent.id)]) continue`). Workers are never in
    // that list: they render from `childrenByParent` under any head that is drawn and expanded. So
    // a worker's drawability is its HEAD's band plus the head's collapse state, and using the
    // worker's own band was wrong in both directions (roborev 58713):
    //
    //   • SILENT CLICK — isolate `needs_you`; a head with a waiting worker rolls up red, so it is
    //     drawn and expanded and every worker under it is on screen. Clicking a `done` worker there
    //     read `!statusFilter["done"]` as "its row was hidden" and swallowed the sentence, though
    //     nothing moved. That is the very defect this branch exists to remove.
    //   • FALSE SENTENCE — isolate `running`; a head rolling up red is filtered OUT, so its
    //     `working` worker is not drawable. Clicking it read `!statusFilter["running"]` as false,
    //     so the host announced "…is already open" immediately after `showAllStatusBands()` had put
    //     the head and its whole subtree on screen.
    //
    // Resolved through `feedRef` rather than a closed-over helper so this callback keeps its empty
    // dep list — a fresh identity here would invalidate the context value every render.
    const head =
      a.parentRowId != null
        ? allAgents(feedRef.current).find((x) => x.id === a.parentRowId)
        : undefined;
    // A nested agent whose head is not in the feed has no row to be drawn under at all, so it
    // cannot have been showing — `undefined` reads as hidden rather than as visible.
    const rowBand = a.parentRowId != null ? head?.band : a.band;
    const surfaced =
      rowBand === undefined ||
      !ui.statusFilter[rowBand] ||
      (a.parentRowId != null && (ui.collapsedOrchestrators[a.parentRowId] ?? true));
    // UNCONDITIONAL, because top-level rows are band-filtered too — that is the population
    // `groupAgentsByStage` filters. Guarding this behind `parentRowId != null` left a `done`
    // top-level agent undrawn while the caller said it was already open (roborev 58713).
    ui.showAllStatusBands();
    // …whereas EXPANDING only means anything for a row that nests under another one.
    if (a.parentRowId != null) ui.expandOrchestrators([a.parentRowId]);
    // NO UP-FRONT BAIL ON A `"gone"` PREDICTION, unlike `openAgentFromPill`. That guard exists there
    // because a doomed `openProjectTab` would yank the reader to another project's tab and only then
    // report the miss (roborev 55548) — a notice contradicting what just happened on screen. This
    // path has never had it, its callers report the miss from the boolean below, and adding one here
    // would change which of the two sources of truth decides an agent is gone. The prediction is
    // consulted for ONE thing: telling `"already-showing"` apart from a real reveal.
    //
    // RETURNED, not discarded. `openProjectTab` reports a miss (unknown project, or an agent that
    // closed between the render and the click) by returning false, silently — and every caller that
    // suppresses the pill's own live notice on the grounds that "the caller reports the outcome" is
    // relying on this value existing (roborev 56068). The ATTEMPT outranks the prediction in both
    // directions: a `false` here is `"gone"` whatever was predicted, and a reveal that landed while
    // the prediction said `"gone"` is reported as `"revealed"` — never as a claim that nothing moved.
    if (!openProjectTab(a.projectId, a.id)) return "gone";
    return !surfaced && planned === "already-showing" ? "already-showing" : "revealed";
  }, []);



  /** Is this agent still reachable? Feed membership — absence IS "closed / deleted / project
   *  unloaded" — plus the app-owned Sparkle agent, whose live mount is never a feed member
   *  (isPromptableTarget / bead sparkle-0rf5). Unchanged for every other id. */
  const agentStillExists = useCallback(
    (id: string | undefined) => isPromptableTarget(feedRef.current, id),
    [],
  );

  /**
   * Run `fn` after every user-initiated delivery already queued, and resolve to its result.
   *
   * EVERY path that can write to a PTY on the user's behalf goes through here — compose sends,
   * redirects, recommended-action clicks, and nudge Approves. Serializing only the compose path
   * would make "delivery follows submit order" true of one surface and false of the app: a
   * recommended-action tap or a redirect click while a send was still routing would land ahead of
   * the earlier message.
   *
   * `.catch(() => onFailure)` is not decoration. Without it a rejecting delivery leaves a rejected
   * promise parked in the chain (an unhandled rejection if no further send follows) and hands that
   * rejection to ComposeBox, whose `.then(ok => …)` has no rejection arm — so the draft would NOT
   * be restored and the user's text would be lost, which is the exact failure the restore logic
   * exists to prevent. The chain therefore always settles fulfilled.
   */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>, onFailure: T): Promise<T> => {
    // BOUNDED. The chain is global, so one delivery that never settles (a hung invoke) would block
    // every subsequent write for the session — including Approve, whose entire job is unsticking a
    // blocked agent (roborev 53119). A task that overruns resolves to its failure value and the
    // queue moves on; the abandoned promise settles unobserved.
    const run = () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Clear the timer when the task settles — otherwise every delivery pinned a 30s timer for its
      // full duration, including after the host unmounted.
      const task = fn().catch(() => onFailure).finally(() => clearTimeout(timer));
      return Promise.race([
        task,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(onFailure), QUEUE_TASK_TIMEOUT_MS);
        }),
      ]);
    };
    const queued = sendChainRef.current.then(run, run);
    sendChainRef.current = queued;
    return queued;
  }, []);

  // Every postSparkle line is BOOKKEEPING — a send outcome, a refusal, a deferred reconciliation —
  // never a brain reply.
  //
  // `collapsed` is a long payload the line is ABOUT (a relayed brief), carried as a block so the
  // thread can draw it as a pill instead of inlining it — see ConciergeSparkleMessage.collapsed for
  // why the sentence and the payload are two fields.
  // TAKES A `Line`, NOT A STRING — and that is the whole enforcement, so it must not be widened.
  //
  // Every line here names an agent, and a name the reader cannot click is a dead end: the same agent
  // named by the concierge's BRAIN one line above IS a pill, because the persona is instructed to
  // emit `[@Name](sparkle-agent:<id>)` and the app was instructed nothing. A `string` parameter is
  // what let twenty-five call sites interpolate `${a.name}`; a `Line` cannot be built without going
  // through `line`, and `line` will not interpolate anything but a `Slot`. See Concierge/conciergeLine.
  //
  // `actionReceipt` MARKS THIS LINE AS AN ACTION RECEIPT and carries what it recorded — see
  // Concierge/types `ConciergeReceiptMark`. Without it a receipt row is indistinguishable from every
  // other app-authored line (no kind, no status, no marker survives this function), which is why the
  // column could show sixteen copies of one fact and nothing could tell they were the same fact. It
  // is stamped from the receipt, never inferred from `l`: the folding rule turns on `ok`, and a mark
  // that guessed it could fold a refusal into a success count.
  //
  // NAMED `actionReceipt`, NOT `receipt`, and the collision was real rather than stylistic:
  // `ConciergeUserMessage.receipt` is the ROUTING receipt (where a message the USER sent went), a
  // different type on a different kind. Reusing the word made a spread across the message union fail
  // to typecheck, which was the honest signal that two unrelated things were being called one name.
  const postSparkle = useCallback((l: Line, collapsed?: TextBlock, actionReceipt?: ConciergeReceiptMark) => {
    setChat((prev) => [
      ...prev,
      { id: nextId("sparkle"), kind: "sparkle", text: l.md, collapsed, actionReceipt },
    ]);
    // A send outcome is exactly what a screen-reader user needs told, and it arrives whole. Two
    // sends to the same pinned agent produce the same line twice; both must be announced.
    //
    // THE RECEIPT SENTENCE ONLY, never `collapsed`. This is the accessibility half of the same bug
    // the pill fixes: a screen reader handed the forty rows of a relayed brief has to sit through all
    // of them to learn that a message went out, and there is no scrolling past a live region. The
    // payload is reachable on demand (the pill's modal); it is never spoken on arrival.
    //
    // `.spoken`, NOT `.md` — the announcer is the "third consumer" agentRefs.ts warns about, and it
    // is paid here. A live region handed `[@Kraken Auth](sparkle-agent:9f3c…)` reads the uuid aloud
    // and cannot be scrolled past. `.spoken` is exactly the sentence this announced before pills, so
    // nothing a screen-reader user hears changes.
    announce(l.spoken);
  }, [announce]);

  /**
   * Reveal an agent BY ID and say so when it cannot be revealed.
   *
   * This is what `AgentPill`'s `onOpen` contract actually requires: supplying `onOpen` suppresses
   * the pill's own `role="status"` notice, so whatever is supplied has to take over the reporting or
   * the click becomes the silent dead end the pill was built to eliminate. Two ways to miss, and
   * before this they were both silent — the id no longer resolving in the feed, and the reveal
   * itself not landing because the agent closed between the render and the click.
   *
   * `postSparkle` rather than a bare `announce`: the line lands in the transcript AND is spoken, so
   * the outcome is visible to a reader who is looking at the column rather than only to one using a
   * screen reader.
   */
  const revealAgentById = useCallback(
    (agentId: string, fallbackName?: string) => {
      const a = resolveAgent(agentId);
      const outcome = a ? revealAgent(a) : "gone";
      if (outcome === "revealed") return;
      // THE THIRD OUTCOME, WHICH THIS FUNCTION USED TO HAVE NO WORDS FOR. A card pill IS a wired
      // surface, and `AgentPill` deliberately renders no notice of its own when a caller supplies
      // `onOpen` — on the stated grounds that the caller reports the outcome. That grounding
      // enumerated only "resolved" and "did not land", so an agent whose column was already showing
      // it produced `true` here and silence everywhere: the founder's exact bug, on the surfaces
      // (NudgeCard, RecapCard) that name freshly-spawned agents and therefore hit the
      // already-showing state most often (roborev 58643).
      //
      // NOT the "isn't open any more" line, which would be a false claim about a live agent — the
      // same false-claim direction roborev 55548/55590 fixed twice in the pill itself.
      if (outcome === "already-showing" && a) {
        postSparkle(line`${ref(a)} is already open in ${plain(a.projectName)}.`);
        return;
      }
      const named = a ?? (fallbackName ? { id: agentId, name: fallbackName } : null);
      postSparkle(
        named
          ? line`${ref(named)} isn't open any more, so there's nothing to show you.`
          : flat("That agent isn't open any more, so there's nothing to show you."),
      );
    },
    [resolveAgent, revealAgent, postSparkle],
  );

  // ── Return-from-Away recap (design §3 A5) ────────────────────────────────────────────────────
  // Snapshot the fleet's statuses the moment presence goes Away; on the way back, diff and post one
  // card. Subscribed imperatively rather than through the `usePresenceStore` hook because this is an
  // EDGE, not a value we render: a hook would re-run the effect on every unrelated store write and
  // would give us the new mode without the old one.
  const awaySnapshot = useRef<AwaySnapshot | null>(null);
  useEffect(() => {
    const onPresence = (mode: PresenceMode, prevMode: PresenceMode) => {
      if (mode === prevMode) return;
      if (mode === "away") {
        awaySnapshot.current = { ...feedStatuses(feedRef.current), at: Date.now() };
        // A fresh stretch starts with no evidence — anything seen working during the LAST one
        // would otherwise vouch for a finish in this one.
        sawWorking.current = new Set();
        return;
      }
      // The user is back — start draining any sends the precedence rule held while they were out.
      // BEFORE the recap's early return below: a held send must come back whether or not anything
      // else changed in the fleet, and `resumeQueuedIntents` presents only the HEAD (the next
      // follows as each resolves), so this can never stack countdowns nobody is watching.
      resumeQueuedIntents();

      const snapshot = awaySnapshot.current;
      awaySnapshot.current = null;
      const worked = sawWorking.current;
      sawWorking.current = new Set();
      if (!snapshot) return; // came back Here without ever having gone Away through this host
      // Names come from the LIVE feed, not the snapshot: a rename while the user was out should
      // show the name they'll actually see when they go looking.
      const info: Record<string, RecapAgentInfo> = {};
      for (const a of allAgents(feedRef.current)) {
        info[a.id] = { name: a.name, projectName: a.projectName, statusLabel: a.statusLabel };
      }
      const recap = buildRecap({
        snapshot,
        // The SAME map, rebuilt from the feed on the return edge — see feedStatuses.
        next: feedStatuses(feedRef.current).status,
        info,
        // Middle-of-the-stretch evidence, so an agent that started AND finished while you were out
        // is reported even though both its endpoints look resting.
        sawWorking: worked,
        // NO_GATE_DECISIONS — the integration seam. The gate that logs sent/queued/cancelled while
        // Away lives on the sibling A1 branch; wiring it is replacing this literal with that log
        // filtered to `at >= snapshot.at`. See services/conciergeRecap.GateDecision.
        decisions: [],
        now: Date.now(),
        id: nextId("recap"),
      });
      // Null when nothing happened — no card at all. A recap that always appears is chrome the user
      // learns to skip, and we'd lose the one time it matters.
      if (!recap) return;
      setChat((prev) => [...prev, recap]);
      // Through the column's EXISTING single role="status" node — never a live region on the card.
      // A second region double-announces (learned during the auto-routing work).
      announce(recapSummary(recap));
    };
    return usePresenceStore.subscribe((s, prev) => onPresence(s.mode, prev.mode));
  }, [announce]);

  // Files that rode a QUEUED send, per agent, oldest first. A queued send resolves ok:TRUE (it is
  // held, not lost), so the synchronous restore below never runs for it — and if the hold later
  // ages out or the terminal dies, the thread says "Send it again" while the attachments have
  // already been consumed and would have to be re-picked from disk (roborev 51594). Held here,
  // and handed back by the deferred-outcome handler on any non-delivery. One entry per queued
  // send, because an agent can have several waiting and each gets its own outcome.
  const heldAttachments = useRef<Map<string, Attachment[][]>>(new Map());
  /** Record what rode a QUEUED send — including NOTHING, which is the whole point of the queue
   *  being 1:1 (roborev 52969). Skipping the empty pushes made this a FIFO of batches popped by a
   *  FIFO of outcomes that counted differently: a queued Approve (or any queued send with no
   *  files) would pop — and drop — the batch belonging to a LATER send, losing the user's files
   *  exactly as before, or hand them back while their send was still held, so the next send
   *  delivered the same file twice. */
  const holdAttachments = useCallback((agentId: string, staged: Attachment[]) => {
    const q = heldAttachments.current.get(agentId) ?? [];
    q.push(staged);
    heldAttachments.current.set(agentId, q);
  }, []);
  /** Take back the oldest batch held for this agent (empty when it carried no files). */
  const takeHeldAttachments = useCallback((agentId: string): Attachment[] => {
    const q = heldAttachments.current.get(agentId);
    if (!q || q.length === 0) return [];
    const batch = q.shift()!;
    if (q.length === 0) heldAttachments.current.delete(agentId);
    return batch;
  }, []);

  // Relay an Approve into the agent's terminal and ALWAYS give the user feedback — a silent failure
  // (dead terminal, an ambiguous prompt) would leave them waiting. Also swallows the throwing path.
  //
  // userPrompt: FALSE — "approve" is machine-authored. When the picker has scrolled off this falls
  // through to the free-text path, and a one-word non-prompt must not enter the prompt history,
  // debit a free-trial prompt, or become the agent's auto-name (see services/conciergeDispatch).
  const approve = useCallback(
    async (a: ConciergeAgent) => {
      if (approvingRef.current.has(a.id)) return; // already approving this agent
      approvingRef.current.add(a.id);
      // Acknowledge the click NOW. The dispatch may sit behind a routing send for seconds, and a
      // button that does nothing visible invites the second click the guard above just swallowed.
      postSparkle(line`Approving ${ref(a)}…`);
      try {
        // Through the SAME queue as every other user-initiated PTY write. Approve is one click away
        // at all times, so an un-queued Approve while a compose send was still routing wrote
        // "approve" into that agent's terminal AHEAD of the earlier-submitted message — exactly the
        // reordering enqueue exists to prevent, on the most reachable surface in the app.
        //
        // A THROW is caught INSIDE the queued function, not left to `enqueue`'s own catch. Both
        // produce "no result", but they mean different things to the user — a throw is a terminal
        // that could not be reached, while `null` is the queue giving up on a task that overran
        // its bound — and folding them together would silently downgrade the honest, specific line
        // main has always shown for the throwing path to the generic refusal.
        const r = await enqueue<ConciergeDispatchResult | "threw" | null>(
          () =>
            // The user clicked Approve on a nudge card — the gesture IS the authorization.
            dispatchConciergeAnswer(a.id, "approve", {
              authority: { kind: "nudge-approve", agentId: a.id },
              userPrompt: false,
            }).catch(
              () => "threw" as const,
            ),
          null,
        );
        if (r === "threw") {
          postSparkle(line`I couldn't reach ${ref(a)}'s terminal to approve.`);
          return;
        }
        if (!r) {
          postSparkle(line`I couldn't send the approval to ${ref(a)}.`);
          return;
        }
        // "queued" is ok:true but NOT delivered — say so rather than claiming it was sent. The `ok`
        // conjunct is load-bearing: an ok:false queued result must NOT get the "I'll approve when
        // it's ready" promise, which would be the same lie the refusal paths exist to avoid — and
        // it must not take a hold slot either, since no deferred outcome is coming to pop it.
        if (r.ok && r.path === "queued") {
          // Carries no files, but DOES emit a deferred outcome — so it takes a slot in the hold
          // queue, or its outcome would pop the batch belonging to a later send (roborev 52969).
          holdAttachments(a.id, []);
          postSparkle(line`${ref(a)} is still starting up — I'll approve as soon as it's ready.`);
        } else if (r.ok) postSparkle(line`Approved — sent to ${ref(a)}.`);
        else postSparkle(refusalCopy(refusedPath(r), a, "approval"));
      } catch {
        postSparkle(line`I couldn't reach ${ref(a)}'s terminal to approve.`);
      } finally {
        approvingRef.current.delete(a.id);
      }
    },
    [postSparkle, holdAttachments, enqueue],
  );

  // The composer's job, re-homed: deliver a USER-authored prompt into the PINNED agent's terminal,
  // with every side-effect the old AgentPane composer had (history, the pinned breadcrumb's
  // marker, ghost suggestions, the auto-name ladder, the trial meter) — that's what
  // `userPrompt: true` turns on. Every outcome is reported back into the thread, because this box
  // is the only place the user can see that a send didn't land.
  //
  // Resolves TRUE when the text is safely in the agent's hands (delivered or held) and FALSE when
  // it isn't, so the compose box can put the user's draft back rather than making them retype it —
  // exactly what the removed composer's restoreDraft did.
  const promptAgent = useCallback(
    async (
      target: ConciergePromptTarget,
      text: string,
      renderings: { display: string; namingBasis: string },
      /** What rode this send. REQUIRED (roborev 52969): a default would let a future call site
       *  silently hold nothing and re-introduce the lost-files bug with no type error. */
      staged: Attachment[],
      /** Whether a PLAIN success ("Sent to X.") says so in the thread. FALSE for the two paths that
       *  post a routing receipt — the receipt already reads "→ Sent to Kraken Auth", and saying it
       *  twice made every successful prompt report itself twice. Every FAILURE still reports
       *  regardless: silence on a non-delivery is the thing this whole surface exists to prevent.
       *  REQUIRED, so a future call site has to decide rather than inherit a default that is wrong
       *  for it. */
      announceSuccess: boolean,
      /** WHY this text may reach the agent's terminal (services/dispatchAuthority). REQUIRED and
       *  non-defaulted — that requirement IS the forwarding-bug fix, so a default here would undo
       *  the whole gate at the one call site that matters most. Appended rather than inserted so
       *  the diff against a branch that also edits this file stays as small as possible. */
      authority: DispatchAuthority,
      /** Forbid this text being collapsed into a picker keystroke — see
       *  conciergeDispatch's `neverPickerAnswer`.
       *
       *  A DISPOSITION, not a synonym for "addressed". TWO call sites set it (roborev 55400):
       *    • an @-ADDRESSED send — the user wrote a message to this agent by name;
       *    • a REDIRECT of a message that CARRIED FILES — the replay is the wire payload with the
       *      attachments' quoted paths prefixed, and no such string is a keystroke.
       *  Both are "the user composed a message", which is the thing this flag actually asserts.
       *
       *  The mirror check in `send` cannot enforce it, because the gate lives inside the dispatcher
       *  (roborev 54569). REQUIRED, so a future call site has to decide rather than inherit a
       *  default that is wrong for it. */
      neverPickerAnswer: boolean,
    ): Promise<boolean> => {
      try {
        const r = await dispatchConciergeAnswer(target.agentId, text, {
          authority,
          userPrompt: true,
          neverPickerAnswer,
          ...renderings,
        });
        // As in `approve`, `ok` gates the held branch: an ok:false queued result must not be
        // promised ("I'll send it when ready") NOR keep the draft-discarding `return true` — and
        // it must not hold the files either, since the refusal below restores them synchronously.
        if (r.ok && r.path === "queued") {
          // Held, not delivered: keep the files with the promise, so a hold that never lands can
          // give them back instead of quietly costing the user the picking (roborev 51594).
          holdAttachments(target.agentId, staged);
          postSparkle(line`${ref(asAgent(target))} is still starting up — I'll send that the moment it's ready.`);
          return true;
        }
        // `matchedLabel` is OPTIONAL on the result, so interpolating it unguarded would render the
        // literal `I answered "undefined".` — the same untrue report this ladder exists to avoid.
        // Today's only picker-option return always sets it; the type doesn't promise that, and a
        // second return site would ship the bad string silently (roborev 53097).
        //
        // Degrade WITHIN the branch rather than falling through: on picker-option the user's text
        // was NOT sent — dispatch matched it to a live option and wrote that option's keystroke —
        // so "Sent to X." would report the one thing that definitely didn't happen. Losing the
        // option's name is not the same as losing the fact that a question got answered
        // (roborev 53111).
        if (r.ok && r.path === "picker-option") {
          postSparkle(
            r.matchedLabel
              ? line`${ref(asAgent(target))} was asking something — I answered "${plain(r.matchedLabel)}".`
              : line`${ref(asAgent(target))} was asking something — I answered it.`,
          );
          return true;
        }
        if (r.ok) {
          if (announceSuccess) postSparkle(line`Sent to ${ref(asAgent(target))}.`);
          return true;
        }
        postSparkle(refusalCopy(refusedPath(r), asAgent(target), "prompt"));
        return false;
      } catch {
        postSparkle(line`I couldn't reach ${ref(asAgent(target))}'s terminal.`);
        return false;
      }
    },
    [postSparkle, holdAttachments],
  );

  // Reconcile the promise made when a prompt was QUEUED: the pane flushes it later (or the hold
  // ages out), and without this the user is told "I'll send it when it's ready" and then never
  // hears another word. Names the agent from the feed so the message reads like the others.
  useEffect(
    () =>
      onDeferredSendOutcome((r) => {
        // THE RECEIPT NAMES THE AGENT AS A PILL — this is the line the founder caught. It reads
        // "<Name> is up — I sent your message (…)", and until now that name was bare text while the
        // very same agent, named by the concierge's brain a line above, was clickable.
        //
        // Resolved from the feed, so the id travels with the name. When the agent is NO LONGER in
        // the feed there is no id to carry and the copy falls back to the words it always used —
        // "that agent" — rather than inventing a reference. A pill carrying a guessed id opens the
        // wrong agent and the reader cannot tell, which is strictly worse than no pill.
        const found = allAgents(feedRef.current).find((a) => a.id === r.agentId);
        const who = found ? ref(found) : plain("that agent");
        // The files that rode this held send: handed back when it never landed, dropped when it
        // did. Taken either way so the queue can't outlive the promise it belongs to.
        const held = takeHeldAttachments(r.agentId);
        if (!r.ok) restoreAttachments(held);
        // Quote the DISPLAY rendering, never `sent` — `sent` is the wire payload and carries the
        // attachments' temp paths (roborev 46925). Falls back to `sent` only when the dispatch
        // carried no separate display, i.e. nothing was attached.
        const shown = r.display ?? r.sent;
        // THE PAYLOAD RIDES AS A PILL, NOT AS PROSE — the whole point of this arm's rework.
        //
        // A relayed brief is routinely forty rows. Interpolated into the sentence it pushed the entire
        // conversation off screen (the founder's screenshot) and made the standing rule — the
        // concierge must never paste relayed text back at the user — unenforceable, because the APP
        // was doing the pasting whatever the concierge did. Past the threshold the block travels on the
        // message and the thread draws one row for it, full text one click away.
        //
        // The sentence keeps a BOUNDED quote either way. `oneLine` collapses newlines and bounds
        // nothing, which is the defect itself: it turns a paste into one enormous wrapped line rather
        // than removing it. So the quote is elided here for the same reason `relayFollowUp` slices to
        // RELAY_QUOTE_CHARS and the countdown banner elides to MAX_QUOTED_CHARS. Short payloads —
        // every one this arm was written for — come through byte-identical, so the wording the tests
        // pin is untouched; what changes is that a long one can no longer run away with the column.
        // Named `flattened`, not `line` — `line` is the concierge line-builder imported above, and a
        // local of that name shadows it for the rest of this closure, which is exactly where the
        // receipt sentence is composed.
        const flattened = shown ? oneLine(shown) : "";
        const quoted = shown ? ` ("${elideQuote(flattened)}")` : "";
        // ONE DECISION, NOT TWO. The elide threshold and the pill threshold are independent numbers, and
        // read as two decisions they leave a band between them where the quote is CUT and nothing rides
        // along: a three-line, 300-character relayed instruction is under `shouldPasteAsPill` but well
        // over `OUTCOME_QUOTE_CHARS`, so the user would be left with `("<119 chars>…")` and no way back
        // to the rest — text that was fully present before this change. That is worst exactly on the
        // `expired`/`abandoned` arms, whose copy tells them to send it again (roborev 55746).
        //
        // So the rule is: A QUOTE THAT WAS ELIDED ALWAYS HAS THE FULL TEXT BEHIND IT. `shouldPasteAsPill`
        // still governs the case the pill was designed for (a paste that would flood the column); this
        // second clause is what makes the invariant hold with no gap.
        const collapsed =
          shown && (shouldPasteAsPill(shown) || flattened.length > OUTCOME_QUOTE_CHARS)
            ? collapseText(nextId("pill"), shown)
            : undefined;
        // Each non-delivery says what actually happened; a wrong reason is its own small lie
        // (roborev 46485-M — `abandoned` used to be reported as "the terminal closed", which is
        // false when the spawn failed and no terminal ever opened).
        //
        // `pty-gone` is its OWN arm rather than the catch-all: the terminal-closed wording is a
        // specific claim, and letting any future path fall into it (say abandonPendingSends grows
        // an `agent-failed` emit) is how 46485-M happened the first time. An unknown path gets a
        // reason it can always stand behind (roborev 53162).
        if (r.ok) postSparkle(line`${who} is up — I sent your message${plain(quoted)}.`, collapsed);
        else if (r.path === "expired") postSparkle(line`${who} never came up, so I dropped the message I was holding${plain(quoted)}. Send it again when it's running.`, collapsed);
        else if (r.path === "abandoned") postSparkle(line`${who} couldn't take the message I was holding${plain(quoted)}. Send it again once it's running.`, collapsed);
        else if (r.path === "pty-gone") postSparkle(line`${who}'s terminal closed before I could send the message I was holding${plain(quoted)}.`, collapsed);
        // LEXICALLY distinct from the `abandoned` arm — "didn't", not "couldn't". Identical copy
        // silently un-pinned that arm once (roborev 53187), and merely dropping its remedy clause
        // left this string a strict PREFIX of it, so the two were separable only by a `$` anchor in
        // one test: any unanchored assertion written later would match both and lose the guarantee
        // again (roborev 53198). Different words cost nothing and don't depend on regex discipline.
        //
        // Reason only, no remedy: the paths that could land here need DIFFERENT next steps —
        // `agent-failed` wants a Retry, and a `cloud-agent` is never "running" locally at all — so
        // "send it again once it's running" would be an instruction that never comes true. Those
        // two are the known paths still routed here; neither reaches this listener today, and if
        // one starts to, it should get its own arm with its own remedy rather than this bare line.
        else postSparkle(line`${who} didn't take the message I was holding${plain(quoted)}.`, collapsed);
      }),
    [postSparkle, takeHeldAttachments, restoreAttachments],
  );

  // ══ ACTION RECEIPTS — the concierge's OWN actions, posted where the founder can check them ═════
  //
  // `controlListener` mints a receipt for every write-tier `concierge_tool` call (see
  // services/conciergeReceiptClassifier); this is the subscriber that turns one into a line. Without
  // it the whole path is inert — the receipt is emitted into an empty listener set and nothing is
  // drawn, which is precisely the state this feature exists to end.
  //
  // WHY IT POSTS TO THE THREAD AND NOT A NEW SURFACE: the founder's complaint is that "I sent it"
  // and "I imagined sending it" look identical the moment a turn ends. `ThinkingIndicator` already
  // narrates a call WHILE it runs and then erases it. The durable answer has to live where he is
  // already reading, next to the claim it corroborates — and the ABSENCE of a receipt beside a
  // claim is then itself the evidence.
  //
  // MOUNT-SCOPED, and that is the correct lifetime: a listener belongs to this component, and the
  // returned unsubscribe is what `useEffect` tears down. It is deliberately NOT cleared on identity
  // change — see the note on `_resetConciergeReceiptsForTests`, which exists so nobody wires this
  // set into the sign-out reset and silently stops every later receipt from rendering.
  useEffect(
    () =>
      onConciergeActionReceipt((receipt) => {
        // DEDUPE ON THE RECEIPT ID — this is what `ConciergeActionReceipt.id` exists for, and it is
        // load-bearing rather than defensive. `onConciergeActionReceipt` REPLAYS recent receipts to
        // every new subscriber (roborev 57866: this host unmounts whenever no project is open, and a
        // receipt fanned out to an empty listener set was lost permanently — which manufactures
        // false "it never happened" evidence in a feature whose contract is that a missing receipt
        // IS evidence). Replay means a remount re-delivers lines this thread may already show, so
        // the id is what stops one action becoming two.
        //
        // OUTLIVES THIS MOUNT, and a test caught why. It was a `useRef` first — per component
        // INSTANCE — so the unmount/remount cycle the replay exists to serve rebuilt it empty and
        // posted every replayed line twice.
        // Dedupe lives in the SERVICE (roborev 57905) so the sign-out reset can clear it without a
        // service importing this React module. `claimReceiptForDisplay` returns false for an id
        // already drawn — which is what makes the replay safe on remount.
        if (!claimReceiptForDisplay(receipt.id)) return;
        // Resolved through the FEED, exactly as the deferred-outcome arm above does, so a pill's id
        // is one the app can actually open. `actionReceiptLine` degrades to words on its own when
        // the agent is gone, rather than inventing a reference.
        const l = actionReceiptLine(receipt, resolveAgent);
        // `null` means "this receipt has no sentence the app can stand behind" — an unknown kind.
        // Posting nothing is the safe failure: a receipt line means the thing happened.
        //
        // THE MARK RIDES WITH THE LINE so a run of identical receipts can fold to one row
        // (Concierge/receiptRuns). The SUBJECT is stamped from the same `resolveAgent` call the
        // sentence above just used — resolved, not re-resolved later — so a folded row can only
        // name an agent the row it replaced already named, and can only make it a pill if that
        // row's pill was real.
        if (l) postSparkle(l, undefined, receiptMark(receipt, resolveAgent));
      }),
    [postSparkle, resolveAgent],
  );

  /** The `you` bubble whose answer is currently outstanding, or null. Paired with the liveness
   *  detector's `sawOutput` to decide whether a message the next send is about to displace was ever
   *  answered — see {@link askSparkle}. A ref, not state: it is read inside a callback and must be
   *  the value as of NOW, not as of the last commit. */
  const awaitingBubbleRef = useRef<string | null>(null);

  // PUBLISH THE AWAITING BUBBLE AS RECEIPT PROVENANCE, so a call that starts during this turn can be
  // attributed to the message that caused it when it settles — possibly long afterwards, possibly
  // when a different bubble is awaiting. `handleConciergeTool` reads it at call ENTRY; see
  // `setConciergeTurnOrigin` in services/conciergeReceipts for why a read at settle time is wrong.
  //
  // DRIVEN OFF `awaitingId` RATHER THAN MIRRORED AT EACH ASSIGNMENT. There are five sites that move
  // the awaiting bubble, and every one of them already sets this state beside the ref — so keying on
  // it makes the module impossible to leave stale, where five hand-placed calls would be one
  // forgotten edit away from attributing a send to the wrong message. The commit-time delay is
  // immaterial: a turn's tool calls are network round-trips behind it.
  //
  // AND IT IS CLEARED ON UNMOUNT. `turnOrigin` is MODULE state, so without this the last bubble id
  // this column ever awaited outlives the column itself — and a call that settles afterwards would
  // be stamped with it. That is not merely stale: message ids survive rehydration, so a remounted
  // thread can contain the very id left behind, and the receipt would mark a message whose turn
  // ended long ago. Clearing is the same fail-closed rule the reader end follows.
  useEffect(() => {
    setConciergeTurnOrigin(awaitingId);
    return () => setConciergeTurnOrigin(null);
  }, [awaitingId]);

  /** Start a Sparkle chat turn for `text`. Never fails visibly, so it reports no outcome.
   *
   *  `bubbleId` is the user bubble this turn answers. It is what lets a displaced message say so —
   *  see the orphan stamp below. Optional because the proactive-relay and redirect paths call this
   *  with text that has no bubble of its own. */
  const askSparkle = useCallback((text: string, bubbleId?: string) => {
    // THE DROPPED-MESSAGE BUG, made visible (Concierge/types ConciergeReceipt.unanswered).
    //
    // Sending KILLS whatever turn is in flight: concierge.rs kills the old child and its reader goes
    // silent — no `done`, no `error`, no log line. So the previous question simply never gets an
    // answer, and its bubble sits in the thread looking answered-by-silence. On 2026-07-29 that
    // happened to 149 of 378 turns, and to 12 of the 14 in the 20:18-20:31 burst.
    //
    // Detected LOCALLY, before the new turn starts: nothing arrives to detect it with. The condition
    // is "a bubble was awaiting an answer and the brain never said a WORD for it" — a turn that
    // streamed a partial answer the user then interrupted is not this, and is left alone.
    //
    // `conciergeSawAnswerText`, never the liveness flag: a tool call is a sign of life but not an
    // answer, and reading a terminal before replying is the concierge's normal first move — so the
    // liveness flag would exempt the most common shape of a dropped question (roborev 55442-M1).
    const orphan = awaitingBubbleRef.current;
    if (orphan && !conciergeSawAnswerText()) {
      setChat((prev) =>
        prev.map((m) =>
          m.kind === "you" && m.id === orphan && m.receipt
            ? // ══ `unanswered`, NEVER `refused` (roborev 58638-M2) ══════════════════════════════
              // This is the DISPLACED-TURN path: the message reached the brain and was being worked
              // on — it simply had no answer text yet. `refused` means "never left this app", and
              // `receiptText` renders it as "Not sent — <agent> couldn't take it" whenever the
              // receipt carries an agentName, fabricating an agent refusal for a message no agent
              // was ever offered.
              //
              // It is also UNWITHDRAWABLE: ConciergeMessageRow's seam strips only `unanswered` when
              // a later reply names the message, and the concierge answering a displaced question a
              // couple of messages later is the documented common case — so `refused` here would
              // render "Not sent" directly above an "Answered below" marker, the exact two-opposite-
              // claims state that seam exists to prevent.
              { ...m, receipt: { ...m.receipt, unanswered: true, redirectable: false } }
            : m,
        ),
      );
    }
    // ══ QUEUE, DO NOT SUPERSEDE (sparkle-t8wsj) ═══════════════════════════════════════════════
    //
    // The decision is the reducer's; this only carries it out. With nothing running the entry is
    // dispatched immediately and everything below behaves exactly as it always has. With a turn
    // already in flight the send WAITS — and that is the whole defect being fixed: dispatching
    // here is what makes `concierge.rs` kill the running child, destroying the answer the user is
    // waiting on (149 of 378 turns on 2026-07-29).
    const queued: QueuedTurn = { bubbleId: bubbleId ?? `pending-${Date.now()}`, text };
    const outcome = enqueueTurn(turnQueueRef.current, queued);
    turnQueueRef.current = outcome.next;
    setTurnQueue(outcome.next);
    // ══ A DROPPED MESSAGE IS SAID OUT LOUD (probe 3 on PR #1235) ══════════════════════════════════
    // At the cap the reducer evicts the OLDEST waiter. That is the right message to lose — the user
    // has moved on from it, and the alternative is refusing the one they are still looking at — but
    // losing it SILENTLY is not acceptable: the whole point of this feature is that a question the
    // user asked is never quietly destroyed, which is precisely the defect the queue replaced.
    // `SendOutcome.dropped` exists for this, and until now nothing read it.
    if (!outcome.dispatch) neverSentRef.current.add(queued.bubbleId);
    if (outcome.dropped) {
      const lost = outcome.dropped;
      // ══ A MARK THAT ACTUALLY RENDERS (roborev 58517-M2) ═════════════════════════════════════════
      // This used to stamp `unanswered`, and that was a comment asserting a rendering that does not
      // exist: `receiptText` deliberately does NOT read that flag (it was withdrawn on 2026-07-31
      // because "never answered" is unknowable), and nothing in `conciergeMessageStatuses` reads it
      // either. So the bubble was RECORDED as lost and still rendered exactly like a delivered one —
      // the defect was written down rather than fixed.
      //
      // `refused` IS read, and renders "→ Not sent". It is also the honest claim here in a way
      // `unanswered` never was: "never left this app" is OBSERVABLE at this moment, whereas "never
      // answered" is a prediction about a reply that may still arrive.
      neverSentRef.current.add(lost.bubbleId);
      setChat((prev) =>
        prev.map((m) =>
          m.kind === "you" && m.id === lost.bubbleId && m.receipt
            ? {
                ...m,
                // NO `agentName` ON A NEVER-SENT MESSAGE (knightwatch, PR #1288). Spreading the
                // original receipt preserves it, and `receiptText`'s refused branch renders
                // "Not sent — <agent> couldn't take it" whenever one is present — fabricating a
                // refusal by an agent that was never offered this message. A sparkle-targeted
                // receipt routinely carries a name, so this is the common path, not an edge.
                // `undefined` gives the bare, true "→ Not sent".
                receipt: { ...m.receipt, refused: true, agentName: undefined },
              }
            : m,
        ),
      );
      setChat((prev) => [
        ...prev,
        {
          id: nextId("err"),
          kind: "failure",
          headline: "One queued message was dropped",
          // The TEXT, so the user can see which question went and re-send it if it still matters.
          // A count alone ("1 message dropped") would tell them something was lost and give them no
          // way to recover it.
          evidence: lost.text,
        },
      ]);
    }
    // ══ THE QUEUE REACHES A SCREEN READER TOO ═════════════════════════════════════════════════════
    // The per-message status line is deliberately NOT a live region: this column owns exactly ONE
    // announcer and a second in the subtree double-announces (Concierge/MessageStatus's header, and
    // ConciergeThread.roleLabels asserts it). That placement is justified on the AT reader getting
    // the same information through the column's announcer — true while the line only repeated things
    // announced elsewhere, and FALSE the moment it carries a queue POSITION, which nothing else says.
    //
    // ONE WRITE CARRYING BOTH FACTS, LOSS FIRST. The region is a single `{ seq, text }`, so two
    // writes in one send means saying only the second — and the eviction above is by far the more
    // important. Its `failure` bubble lives in the THREAD, which is not a live region, so this is the
    // only channel it has: announcing the position alone would hand the reader a reassuring receipt
    // for the new message while an older question disappeared without a word.
    if (!outcome.dispatch) {
      const position = `Queued — ${waitingLine(waitingCount(outcome.next))}.`;
      announce(
        outcome.dropped
          ? `One queued message was dropped: ${anchorQuote(outcome.dropped.text)}. ${position}`
          : position,
      );
    }
    if (!outcome.dispatch) {
      // WAITING. The turn in flight keeps the typing indicator, the liveness clock, the activity
      // floor and the awaited-bubble pointer — every one of those describes the turn being
      // ANSWERED, and this message is not it. The per-message status is what says this one is
      // queued (engine/conciergeTurnQueue.statusOf), which is the surface the founder asked for.
      return;
    }
    dispatchTurnRef.current(outcome.dispatch);
    // `announce` only — it is a `useCallback(…, [])` and therefore stable, so this keeps `askSparkle`
    // stable too. Everything else here is a ref or a module function, deliberately, because it is
    // installed on `askSparkleRef` and a changing identity would churn that.
  }, [announce]);

  /**
   * Actually start a turn — the half of the old `askSparkle` tail that must only run for a send
   * that is DISPATCHING.
   *
   * Everything here is about the turn now in flight: the awaited bubble, the liveness clock, the
   * typing indicator, and the retirement floor that silences older turns. Running any of it for a
   * QUEUED message would describe a turn that has not started, and `retireThroughRef` in particular
   * would silence the turn that is still legitimately streaming.
   */
  const dispatchTurn = useCallback((entry: QueuedTurn) => {
    // ══ A NEW TURN ENDS ANY HELD REPLY FIRST (the linter's block path) ═════════════════════════
    // `concierge.rs` installs one turn and KILLS the child it evicts, so a correction turn in
    // flight is about to die without ever emitting a terminal event. Settling here renders the held
    // reply now instead of at the 90-second backstop — and renders it BEFORE this turn's own reply
    // can arrive, so the thread does not grow an answer above the question it was answering.
    settleLintHoldRef.current("the user sent again");
    // Its turn is starting, so it HAS been sent — a reply may legitimately claim it from here.
    neverSentRef.current.delete(entry.bubbleId);
    const bubbleId = entry.bubbleId.startsWith("pending-") ? null : entry.bubbleId;
    awaitingBubbleRef.current = bubbleId;
    setAwaitingId(bubbleId);
    // EVERY dispatched turn moves the boundary, including one with no bubble of its own.
    setSendSeq((n) => n + 1);
    // The send itself, for the liveness clock. AFTER the orphan check, which reads the state this
    // call is about to reset.
    noteConciergeSent();
    setTyping(true);
    // SENDING retires every turn seen so far, here as well as in the backend (see
    // supersededTurn). Their accumulated text is dropped as those events are rejected, not
    // wiped here — clearing the map at send would truncate a turn that is still legitimately
    // streaming.
    //
    // This floor can only retire ids we have SEEN an event for, so a turn killed before it
    // emitted anything is not covered by it; the returned token below closes that half. Both
    // are belt to concierge.rs's braces, which stops a superseded reader emitting at all
    // (roborev 53088/53105/53130).
    retireThroughRef.current = latestTurnRef.current;
    // AND THIS IS WHERE AN ABANDONED FRAGMENT IS DECLARED DEAD (roborev 62936). A killed reader
    // emits nothing, so a displaced turn's bubble gets no `done` and no `error` to hang a marker on
    // — dispatching is the only moment the frontend learns those bubbles have stopped growing.
    // Whatever they had already painted stays on screen, so it must become searchable here or never.
    //
    // NOT the ordinary double-send (roborev 62937): a user send arriving while a user turn is in
    // flight is QUEUED by `conciergeTurnQueue`, never dispatched, so it does not reach this line at
    // all. What it catches is a turn holding no queue slot — a proactive/push turn, or a correction
    // painting in the `correctionTurnId === null` window. See `endStreamsThrough`'s own note.
    // No-op (and no re-render) when nothing is streaming, which is the common case.
    setChat((prev) => endStreamsThrough(prev, retireThroughRef.current));
    // BUILT NOW, NOT AT ENQUEUE. A queued entry deliberately carries no snapshot: the fleet picture
    // is read at dispatch so a turn that waited behind three others still describes the app as it
    // is when it actually runs, rather than as it looked when the user typed.
    // ══ THE RESEARCH DRAIN — PEEK NOW, CLAIM ONLY IF THIS TURN SPEAKS ═════════════════════════════
    // Unread findings go in FRONT of the snapshot, so the brain reads what came back before it
    // reads what the founder just said. `peek` stamps nothing: `readAt` is written in the `done`
    // handler below, because this turn can still be superseded and killed before it says a word —
    // and a finding claimed here would be gone with no residue and no retry.
    // ══ WRITE IT DOWN BEFORE ANSWERING IT, AND NEVER AT THE COST OF THE SEND ══════════════════════
    // Filing is a `bd` round-trip so the turn must not wait on it — but it is issued HERE rather
    // than in the reply handler, because a turn that never completes is exactly the case where the
    // request would otherwise be lost, which is the whole defect (bead sparkle-yd1ud).
    //
    // Everything here is fire-and-forget record-keeping running just before the send, and a failure
    // in any of it must not ABORT the dispatch — that would leave his message silently undelivered,
    // which shipped once from an unguarded `crypto.randomUUID()`. Each call is wrapped SEPARATELY by
    // `bookkeep` (see its header): one shared `try` would let the first failure skip the rest, and
    // it would guard only the synchronous shape while the reachable failure here is a rejection.
    // The guard lives at this call site, not only inside each module (roborev 61903), because that
    // is the invariant — nothing between here and `startConciergeTurn` may take the send down.
    bookkeep("ask capture", () =>
      captureAsksFrom(entry.text, String(latestTurnRef.current)).then((out) => {
        // A CAP THAT SAYS NOTHING IS CONCEALMENT (docs/never-hide-actionable-rows.md). `asksIn`
        // bounds one message to MAX_ASKS_PER_TURN so a long paste cannot bury the queue, and reports
        // what it withheld precisely so the bound stays visible.
        //
        // EACH NOTICE IS GUARDED SEPARATELY (roborev 61961), for the reason the notices exist at
        // all: they are the disclosures that keep the cap and the disagreement from being concealed,
        // so one of them failing must not silently swallow the others. Grouped, a throw from the
        // `dropped` post would skip every `reasked` line below it — concealment produced by the code
        // whose whole job is to prevent it.
        if (out.dropped > 0) {
          bookkeep("dropped-ask notice", () =>
            postSparkle(
              line`That message had more asks than I file at once, so ${plain(String(out.dropped))} of them didn't make the list — say them again and I'll pick them up.`,
            ),
          );
        }
        // He asked for something we already marked done. Neither a silent re-open nor a duplicate:
        // two parties disagree about whether the work happened, and that is his call to make.
        for (const r of out.reasked) {
          bookkeep("re-ask notice", () =>
            postSparkle(
              line`You've asked for ${plain(oneLine(r.ask.sentence))} again — ${plain(r.closedBeadId)} was already closed. I've filed it fresh rather than assume either of us was right.`,
            ),
          );
        }
      }),
    );
    // NO `bookkeep("history capture", …)` HERE, deliberately (sparkle-yd1ud × sparkle-s7rfc). His
    // raw message is indexed — never the composed prompt, which would bury one sentence of his under
    // a roster dump every search would match — but by the thread-store subscriber, which sees the
    // bubble he actually sent. That also takes the capture OFF this dispatch path entirely, so it
    // can no longer be a synchronous throw that costs the send; see the import block's note and
    // services/conciergeHistoryCapture.ts.
    const research = researchDrain.peek();
    // THE CONVERSATION, alongside the fleet picture. Read here for the same reason the feed is:
    // this is the moment the turn actually runs. `chat` is the visible thread, so what the brain is
    // told matches what the human is looking at — which is precisely what breaks when the resumed
    // session is lost underneath a thread that survived (see engine/conciergeContinuity).
    const continuity = buildContinuityBlock({
      chat: useConciergeThreadStore.getState().chat,
      summary: useConciergeThreadSummaryStore.getState().text,
      // This turn's own bubble is ALREADY in the thread (it is appended at send, and the snapshot is
      // built here at dispatch), so exclude it — otherwise the message being asked appears twice in
      // its own prompt.
      excludeId: entry.bubbleId,
    });
    // Fire-and-forget, AFTER the block above is built so this turn is never delayed by it and never
    // sees a half-written summary. Resolves false and keeps the old summary on any failure.
    void maybeRefreshThreadSummary(useConciergeThreadStore.getState().chat);
    // The two compose: research findings lead (they are what came back while he was away), then the
    // fleet + thread snapshot, then his new message last.
    void startConciergeTurn(
      // MERGE NOTE (sparkle-yd1ud × sparkle-s7rfc): both branches rewrote this call, and the three
      // additions compose rather than compete — research findings are what CAME BACK, open asks are
      // what is still OWED, continuity is what was already SAID. Taking either side verbatim would
      // have silently dropped the other's argument, which is the conflict git resolves cleanly and
      // wrongly. `openAsksNow()` is read synchronously from the queue's cache, for the same reason
      // the fleet picture is read at dispatch rather than at enqueue: the prompt should describe
      // what is outstanding when the turn actually runs.
      withResearchPreamble(
        research.preamble,
        buildSnapshot(feedRef.current, entry.text, openAsksNow(), continuity),
      ),
    ).then(
      (id) => {
        const n = id !== null && /^\d+$/.test(id) ? Number(id) : null;
        if (n !== null) retireThroughRef.current = Math.max(retireThroughRef.current, n - 1);
        // `null` is a turn that never installed — superseded before install, cancelled, or a local
        // error (services/concierge). There is no turn to claim against, so the findings stay
        // unread and the next send carries them.
        if (id !== null) researchDrain.stage(id, research.taskIds);
      },
      // ══ A REJECTED DISPATCH MUST STILL RELEASE THE SLOT (probe 4 on PR #1235) ═══════════════════
      // `startConciergeTurn` throws BEFORE its own try block when AI enhancements are off
      // (`ConciergeAiDisabledError`) — deliberately, so no paid child is spawned. That path emits no
      // `concierge:error` event, so the handler that would normally drain never runs: the entry sits
      // as `running` forever and EVERY later question queues behind a turn that does not exist.
      //
      // Turning the toggle off with messages waiting is not exotic — it is the shape a user
      // reaches by pausing the concierge mid-queue, and the failure is silent and permanent.
      (err) => {
        console.warn("concierge: turn failed to start:", err);
        setTyping(false);
        awaitingBubbleRef.current = null;
        setAwaitingId(null);
        // ══ SAY SO, AND DO NOT CASCADE (roborev 58223-M2) ═══════════════════════════════════════
        // `startConciergeTurn` rejects on exactly one condition — AI enhancements being off — and
        // that condition is STICKY. Draining here would dispatch the next waiter, which rejects for
        // the same reason, which drains the next: a queue of N questions emptied in N microtasks
        // with nothing on screen. That is the silent loss this file refuses to accept for a single
        // evicted message, doing it to the whole queue.
        //
        // So the queue is CLEARED and the loss is reported ONCE, listing what did not go, rather
        // than cascading a rejection through every waiter.
        // ══ ONLY A STICKY FAILURE CLEARS THE QUEUE (roborev 58241-M2) ═════════════════════════════
        // `ConciergeAiDisabledError` is the one rejection that cannot be retried — the toggle is off
        // and stays off — so draining would dispatch the next waiter into the same rejection, and
        // the whole queue would empty in N microtasks. Any OTHER rejection may be transient, and
        // destroying every queued question over one is far worse than trying the next: this handler
        // is generic, so the clear must be conditional on the typed error rather than on "something
        // threw".
        const sticky = err instanceof ConciergeAiDisabledError;
        if (!sticky) {
          // ══ A TRANSIENT REJECTION STILL LOSES ITS MESSAGE — SAY SO (roborev 58517-M1) ═══════════
          // This branch drains so the rest of the queue survives, but the entry it was dispatching
          // is gone: `dispatchTurn` already removed it from `neverSentRef`, so without restoring
          // that the NEXT waiter's reply would claim it — `pendingAnchors` walks back to the last
          // settled reply and `reachedTheBrain` passes any sparkle-targeted receipt. The result was
          // "Answered below" under a question the brain never received, with no notice anywhere
          // that it was lost: the exact over-claim and silent-loss this file removed twice already,
          // reintroduced by the branch added to satisfy them.
          //
          // Today `startConciergeTurn` only ever rejects with the typed error — everything else is
          // caught and routed through `dispatchLocalError` — so this is the DEFENSIVE branch. It is
          // also the branch that exists precisely for a future transient rejection, which is when
          // an unguarded version would start losing questions quietly.
          neverSentRef.current.add(entry.bubbleId);
          setChat((prev) =>
            prev.map((m) =>
              m.kind === "you" && m.id === entry.bubbleId && m.receipt
                ? {
                ...m,
                // NO `agentName` ON A NEVER-SENT MESSAGE (knightwatch, PR #1288). Spreading the
                // original receipt preserves it, and `receiptText`'s refused branch renders
                // "Not sent — <agent> couldn't take it" whenever one is present — fabricating a
                // refusal by an agent that was never offered this message. A sparkle-targeted
                // receipt routinely carries a name, so this is the common path, not an edge.
                // `undefined` gives the bare, true "→ Not sent".
                receipt: { ...m.receipt, refused: true, agentName: undefined },
              }
                : m,
            ),
          );
          setChat((prev) => [
            ...prev,
            {
              id: nextId("err"),
              kind: "failure",
              headline: "That message didn't get sent",
              evidence: [String(err), "", entry.text].join("\n"),
            },
          ]);
          drainQueueRef.current();
          return;
        }
        const stranded = [entry, ...turnQueueRef.current.waiting];
        for (const q of stranded) neverSentRef.current.add(q.bubbleId);
        // EACH STRANDED BUBBLE IS MARKED (roborev 58241-M4, corrected by 58517-M2). `clearQueue`
        // erases their "Waiting its turn" line, so without a mark they render identically to a
        // delivered message and the only trace is one failure bubble that scrolls away. `refused`
        // rather than `unanswered`, because only `refused` is rendered — see the evicted-message
        // stamp above for the full reasoning.
        const strandedIds = new Set(stranded.map((q) => q.bubbleId));
        setChat((prev) =>
          prev.map((m) =>
            m.kind === "you" && strandedIds.has(m.id) && m.receipt
              ? {
                ...m,
                // NO `agentName` ON A NEVER-SENT MESSAGE (knightwatch, PR #1288). Spreading the
                // original receipt preserves it, and `receiptText`'s refused branch renders
                // "Not sent — <agent> couldn't take it" whenever one is present — fabricating a
                // refusal by an agent that was never offered this message. A sparkle-targeted
                // receipt routinely carries a name, so this is the common path, not an edge.
                // `undefined` gives the bare, true "→ Not sent".
                receipt: { ...m.receipt, refused: true, agentName: undefined },
              }
              : m,
          ),
        );
        turnQueueRef.current = clearQueue();
        setTurnQueue(turnQueueRef.current);
        setChat((prev) => [
          ...prev,
          {
            id: nextId("err"),
            kind: "failure",
            // NAMES THE TOGGLE. Routing this through `conciergeFailureNotice` produced "try me again
            // in a moment" — and retrying is the one thing that cannot work here, which is exactly
            // the remedy-string failure that module's own header exists to prevent.
            headline: "AI enhancements are off — turn them back on to send these",
            // The machine's OWN sentence, per that module's contract that evidence is the verbatim
            // detail, followed by the questions that did not go so each can be re-sent.
            evidence: [String(err), "", ...stranded.map((q) => q.text)].join("\n"),
          },
        ]);
      },
    );
    // NAMED, NOT SUPPRESSED — and naming it costs nothing. The disclosure notices above are the
    // first `postSparkle` calls inside this callback, so the array became non-exhaustive the moment
    // they were added. `postSparkle` is `useCallback(…, [announce])` and `announce` is
    // `useCallback(…, [])`, so it is stable for this component's lifetime: naming it cannot give
    // `dispatchTurn` a new identity on any render, which is the same reasoning the brain-subscription
    // array records for `noteMounted`. Leaving it out is not a style note — it is desktop lint
    // warning number THIRTEEN against an `eslint src --max-warnings 12` ratchet, i.e. a red CI.
  }, [postSparkle]);
  dispatchTurnRef.current = dispatchTurn;
  drainQueueRef.current = drainQueue;

  /** Stamp a receipt onto a user bubble. Clears `redirectable` from every OTHER bubble, so only
   *  the newest routed message offers the button — a thread full of live redirects invites
   *  redirecting something from ten turns ago, which is never what the user means. */
  const setReceipt = useCallback((id: string, receipt: ConciergeReceipt) => {
    // Feed the column's long-lived live region so the routing is ANNOUNCED, not merely rendered.
    // With the target pill gone this is the only routing signal a screen-reader user gets, and the
    // receipt line itself deliberately carries no aria-live (see RoutingReceipt's header).
    //
    // Through `announce`, never `setAnnouncement` directly (roborev 53392). Routing is STICKY —
    // two messages in a row answered by Sparkle both produce "→ Answered here" — so an identical
    // consecutive write is the COMMON case here, not a corner one, and a bare setState React bails
    // out of would announce the first and silently swallow every repeat.
    // NULL FOR AN ORDINARY CONCIERGE ANSWER, since "Answered here" was removed (RoutingReceipt).
    // Nothing is announced then, and that is the right call rather than a gap: the reply itself
    // lands in the thread and is read out, which is the same reasoning that removed the visual line.
    // Every case that DOES say something a screen-reader user could not otherwise infer — sent
    // elsewhere, refused, or a second delivery — still returns a string and is still announced.
    const receiptLine = receiptText(receipt);
    if (receiptLine) announce(receiptLine);
    setChat((prev) =>
      prev.map((m) => {
        if (m.kind !== "you") return m;
        if (m.id === id) return { ...m, receipt };
        return m.receipt?.redirectable
          ? { ...m, receipt: { ...m.receipt, redirectable: false } }
          : m;
      }),
    );
  }, [announce]);

  /**
   * Record on the user's OWN bubble that the concierge relayed it to an agent.
   *
   * WHY THIS EXISTS — it is the half of the founder's complaint the composer path never covered.
   * There are two ways his words reach a build agent. He can address one himself (`@Agent …`, or a
   * mounted column), and that path has always stamped his bubble at `dispatchToTerminal`. Or he can
   * write ordinary prose and the CONCIERGE decides to relay it — and that path wrote nothing back
   * onto his message at all. It posted a separate "Sent to X's terminal." line further down the
   * thread, which is a statement by the concierge about its own action, several rows away from the
   * message it concerns and easily scrolled past. So the bubble that left the room looked exactly
   * like one that did not, which is what he had to work out by hand.
   *
   * `target: "sparkle"` WITH `alsoSentTo: "agent"` IS THE HONEST SHAPE, not `target: "agent"`. The
   * message really did go to the concierge first — that is HOW it came to be relayed — and the agent
   * is a second delivery the reader cannot otherwise see. It is also the shape the receipt vocabulary
   * already had for "reached two places" (Concierge/types ConciergeReceipt), so nothing new is
   * invented and RoutingReceipt's wording still holds if the card is ever turned off.
   *
   * NEVER OVERWRITES AN EXISTING AGENT RECORD. A bubble that already names an agent was addressed by
   * the user, and his aim outranks anything inferred here — clobbering it would rename his own
   * destination under him, which is the one error this whole feature exists to prevent.
   *
   * NO ANNOUNCEMENT, unlike `setReceipt` above. The relay already speaks for itself: the concierge
   * posts a receipt line into the thread and the column's live region reads it. Announcing again
   * from here would say the same sentence twice to a screen-reader user.
   */
  const stampRelayReceipt = useCallback(
    (id: string, agentId: string, agentName: string | undefined) => {
      setChat((prev) =>
        prev.map((m) => {
          if (m.kind !== "you" || m.id !== id) return m;
          // Already carries an agent — the user's own aim, or a stamp from an earlier receipt in the
          // same turn. A `refused` receipt is caught here too: those are always `target: "agent"`,
          // and a message that bounced must not acquire a delivery it never made.
          if (m.receipt?.target === "agent" || m.receipt?.alsoSentTo === "agent") return m;
          return {
            ...m,
            receipt: { ...m.receipt, target: "sparkle", alsoSentTo: "agent", agentId, agentName },
          };
        }),
      );
    },
    [],
  );

  // The subscription that does it. SEPARATE from the receipt-line effect above, deliberately: that
  // one calls `claimReceiptForDisplay` to stop a replayed receipt drawing a second line, and this
  // stamp must not be gated on winning that claim — they are different concerns and only one of them
  // is about drawing a row.
  //
  // REPLAY IS STILL SAFE, BUT NOT FOR THE REASON THIS COMMENT USED TO GIVE. It said "a remount
  // starts with no awaiting bubble, so there is nothing to stamp" — true only while the origin was
  // read from a live ref at settle time. The origin now travels ON the receipt, so a replayed
  // receipt arrives carrying a perfectly valid bubble id and CAN match a rehydrated message.
  //
  // What makes that harmless is the guard inside `stampRelayReceipt`: a bubble that already records
  // this agent is returned untouched, so re-applying a receipt the thread already reflects is a
  // no-op. That is now the whole of the argument, and it is a property of the guard rather than of
  // the mount — so anything that weakens the guard has to re-answer replay too.
  useEffect(
    () =>
      onConciergeActionReceipt((receipt) => {
        // THE JOIN, AND IT IS CARRIED RATHER THAN INFERRED. `originBubbleId` was captured when the
        // call STARTED (handleConciergeTool reads it at entry); this used to read
        // `awaitingBubbleRef.current` here instead, which is a different question — "what is
        // awaiting NOW" — and the two diverge exactly where it hurts (roborev 62737):
        //
        //   • an approval resumed from a click handler settles arbitrarily long after its turn,
        //   • a displaced turn's reply settles once the NEXT bubble is already awaiting — 149 of
        //     378 turns on one measured day.
        //
        // Both would paint the black card on a message that was never sent while the one that WAS
        // sent stayed bare: the feature's own false claim, inverted. Absent origin stamps nothing —
        // the receipt line below the bubble still reports the send, so nothing is hidden.
        const origin = receipt.originBubbleId;
        // A TYPE NARROWING AND AN EARLY-OUT, NOT THE GUARD — said plainly because mutation-check
        // flags this line as uncaught and that reading is correct. Deleting it changes no behaviour:
        // `stampRelayReceipt` matches on `m.id === id`, and no message has an undefined id, so an
        // origin-less receipt already marks nothing. The safety lives in that match; this just
        // avoids walking the thread and keeps `origin` a string. The paired test asserts the
        // BEHAVIOUR (an origin-less receipt marks no bubble), which is the durable claim and stays
        // true however this line is written.
        if (!origin) return;
        // `ok`, because a refused tool call delivered nothing. `agentId`, because the card's whole
        // promise is a pill the founder can click. `viaPicker` is excluded — that receipt is the
        // concierge pressing a button on his behalf, not his words being forwarded, and describing
        // it as a send would be the false claim conciergeReceipts exists to prevent. `fanout` has no
        // single destination to name.
        if (receipt.kind !== "sent" || !receipt.ok || receipt.viaPicker || receipt.fanout) return;
        if (!receipt.agentId) return;
        // "held" is NOT a delivery — it means the message goes in when the terminal is ready — so it
        // must not turn the bubble into a card claiming it went. Terminal and inbox both did arrive.
        if (receipt.channel !== "terminal" && receipt.channel !== "inbox") return;
        stampRelayReceipt(origin, receipt.agentId, receipt.agentName);
      }),
    [stampRelayReceipt],
  );

  /**
   * The one send path. Routes the text, delivers it, and posts the receipt that makes the routing
   * visible and reversible. Resolves FALSE only when the text did NOT land anywhere, so the
   * compose box restores the draft rather than making the user retype it.
   */
  const deliver = useCallback(
    async (
      id: string,
      /** What the user actually WROTE — no attachment paths. Everything that reads the message as
       *  language uses this: the router classifies it, and Sparkle answers it. Prefixing quoted
       *  temp paths onto the text the classifier sees was a real mistake — "/var/folders/…/shot.png
       *  add retry logic" is not what the user said. */
      text: string,
      /** What the AGENT receives: the same text with the quoted paths in front. PTY path only. */
      payload: string,
      /** What the THREAD already shows, reused as the prompt-history rendering. */
      display: string,
      /** The aim CAPTURED AT SUBMIT (see send). Not re-read here: by the time the queue reaches
       *  this message the user may be looking at a different agent, and delivering there would be
       *  the same irreversible misdelivery the removed pinned-aim guard prevented. */
      submitted: ConciergePromptTarget | null,
      /** The files that rode this send, so a refusal can hand them back. */
      staged: Attachment[],
      /** The user already CHOSE Sparkle for this message — they pressed Chat ❯ in the capture
       *  window rather than Build ❯ — so the router is skipped rather than allowed to overrule
       *  them. Captured at submit like every other aim (see send).
       *
       *  Safe to short-circuit in this direction ONLY. `sparkle` is the reversible destination:
       *  the receipt still names where it went and still offers the one-tap redirect into the
       *  agent. A `forceAgent` twin would type a paragraph into a live PTY on the strength of a
       *  latch, which conciergeRouter's header rules out — do not add one. */
      forceSparkle: boolean,
      /** The user NAMED the destination in the message ("@Kraken Auth ship it"). Overrules the
       *  router toward that agent — see ConciergeMentionAim for why that is allowed here when
       *  `forceSparkle` has no legal twin, and for the gate it does NOT skip. Null on every send
       *  that names nobody, which is every send that existed before mentions. */
      mentionAim: ConciergeMentionAim | null,
      /** Is there anything left to REDIRECT — i.e. does this message strip to a non-empty wire?
       *  False only for a bare address ("@Sparkle" and nothing else, no files), which has no
       *  instruction in it to pass anywhere. Decided in `send`, which is where the strip is computed;
       *  passed rather than recomputed so the flag and the remembered replay cannot disagree. */
      redirectable: boolean,
      /** The quote that rode THIS send, with its restore bound to the draft it left from, so a
       *  refusal or a cancelled countdown hands back this send's fragment rather than whichever one
       *  happened to be staged most recently. Per-send like `staged` above, and for the same reason:
       *  several intents can be armed at once (roborev 59804). */
      sentQuote: SentQuote | null,
      /**
       * `Date.now()` AT SUBMIT — captured in `send`, like `submitted` and `staged` above, and for
       * the same reason: this body is the ENQUEUED half and can run long after the gesture.
       *
       * It exists because computing it here is not merely imprecise, it is INERT. The mounted gate
       * asks "would presence read Here if this submit counted as input?", and a `resolveMode` given
       * `lastInputAt: Date.now()` alongside `now: Date.now()` makes `now - lastInputAt` identically
       * zero — so the idle clause can never fire and the credit is granted at DEQUEUE time,
       * unconditioned on how old the submit actually is. Chain a few slow deliveries (each bounded
       * at `QUEUE_TASK_TIMEOUT_MS`) and a send from minutes ago still reads Here, dispatching to a
       * live terminal on the strength of a gesture that is no longer true of where the user is.
       */
      submittedAt: number,
    ): Promise<boolean> => {
      // Has this send already claimed the mounted notice row with something SPECIFIC? The row holds
      // one line, so a later, vaguer notice would silently replace the explanation the founder needs.
      let notedThisSend = false;
      // An agent that has since LEFT the feed is gone (closed, deleted, project unloaded), and
      // routing at it would report a delivery that cannot happen. Gone → the safe direction.
      const aim = submitted && agentStillExists(submitted.agentId) ? submitted : null;
      const status = aim ? useRuntimeStore.getState().status[aim.agentId] : undefined;
      // The DISPATCHER's own precondition, asked up front, so a guaranteed delivery failure becomes
      // a useful chat answer instead. One shared predicate rather than a copy here, so the two
      // can't drift.
      //
      // `agentCanAcceptPrompt`, NOT `agentCanAcceptInput` — the two answer different questions and
      // this send is a MESSAGE. `agentCanAcceptInput` is the local-PTY question (false for cloud),
      // and it stays that way for the raw-keystroke callers; a compose send that asked it would
      // refuse every cloud agent with "can't take a message right now" over a path the dispatcher
      // now delivers on (design 2026-08-01 §Decision 7).
      const canAcceptInput = aim ? agentCanAcceptPrompt(aim.agentId) : false;
      // ══ AN ADDRESSED MESSAGE, AND THE TWO WAYS IT CAN STILL FAIL ════════════════════════════
      // `aim` and `canAcceptInput` above are the same two checks every send makes, so a mention
      // that named an agent which has since closed — or one that can never take a prompt at all,
      // like a cloud agent — has already been reduced to "no usable aim" by the time we get here.
      // That leaves the message going to Sparkle, which is right (the recoverable direction), but
      // it must not go there SILENTLY: the user typed a name and watched a pill appear, so the one
      // thing they will not expect is a chat answer with no explanation. The receipt alone does not
      // say it either — it names Sparkle, not the agent that turned out to be unreachable.
      const addressed = mentionAim !== null;
      const addressable = addressed && !!aim && canAcceptInput;
      if (addressed && !addressable) {
        postSparkle(
          line`${ref(asAgent(mentionAim.target))} can't take a message right now, so I've kept this here instead.`,
        );
        // Same hidden-thread problem as the refusals below: mounted, that line is off screen.
        if (displayMountedRef.current) {
          noteMounted(
            `${mentionAim.target.name} can't take a message right now, so I've kept this with Sparkle instead.`,
            "warn",
          );
          // AND THE GENERIC LINE MUST NOT OVERWRITE IT. This message now falls through to Sparkle,
          // which posts its own "Asked Sparkle" notice a few lines down — so without this the founder
          // is told the least specific true thing ("asked Sparkle") instead of the one that explains
          // WHY ("that agent can't take a message"). Last write wins in a one-line row, so the
          // specific notice has to claim the row rather than merely arrive first.
          notedThisSend = true;
        }
      }
      // An address with NOTHING TO SAY is not a send. "@Kraken Auth" on its own strips to an empty
      // wire payload, and writing an empty line into a live PTY is at best a stray newline at the
      // agent's prompt. It is also almost certainly not what the user meant, so the concierge asks
      // rather than either guessing or silently doing nothing.
      if (addressable && mentionAim.text.trim() === "" && staged.length === 0) {
        postSparkle(line`You've got ${ref(asAgent(mentionAim.target))} in mind — what should I send over?`);
        setReceipt(id, {
          target: "sparkle",
          agentName: aim?.name,
          agentId: aim?.agentId,
          // Nothing to redirect: there is no instruction in this message to send anywhere.
          redirectable: false,
        });
        return true;
      }
      // ══ THE SCREEN GUARD, ASKED BEFORE ANYTHING IS ARMED ════════════════════════════════════════
      // Cheapest and kindest point to refuse: no countdown runs, no banner appears, and the founder
      // gets the reason while the words are still the last thing they typed. It is asked AGAIN at
      // dispatch (below) because the screen can change during the countdown — these are two different
      // instants and both of them have to be safe. See `terminalWriteBlocked` for why a null viewport
      // stops a mount and not an address.
      if (addressable && aim) {
        const blocked = terminalWriteBlocked(aim.agentId, mentionAim.via);
        if (blocked) {
          postSparkle(terminalRefusalLine(asAgent(aim), blocked));
          // AND on the surface a mounted column can actually show (roborev 57360) — the line above
          // goes to a thread the mount replaces. ONLY while the thread is actually replaced
          // (roborev 57424): unmounted, this refusal is already visible twice (the thread line and
          // the receipt), and a third copy in a row that could never clear would outlive the send.
          if (displayMountedRef.current) noteMounted(terminalRefusalText(aim.name, blocked), "warn");
          const returned = restoreDraft(text, sentQuote);
          restoreAttachments(staged);
          // NO BUBBLE FOR A SEND THAT DID NOT HAPPEN (bead sparkle-k5kit part 2). Only once the words
          // are demonstrably back in the box, though — see `retractSend`: on the rare path where the
          // composer is not mounted to take them, the bubble is the last surviving copy of what the
          // founder typed, and dropping it too would turn a refusal into a loss.
          if (returned) {
            retractSend(id);
            return true;
          }
          setReceipt(id, {
            // NEITHER destination's wording (roborev 57360). `target: "agent"` would read "Sent to
            // X" over a write that never landed — and `target: "sparkle"`, which this used to say,
            // reads "ANSWERED HERE", which is just as false: the brain was never asked and the words
            // are back in the box. `refused` is the arm that says what actually happened. The target
            // still names who it was FOR, so the copy can name them.
            target: "agent",
            refused: true,
            agentName: aim.name,
            agentId: aim.agentId,
            // The words are back in the composer, so there is nothing for a redirect to replay that
            // the founder cannot simply send themselves — and offering to pass a message on to an
            // agent that just declined it is a button pointed at the refusal.
            redirectable: false,
          });
          return true;
        }
      }
      const decision = addressable
        ? ({
            target: "agent",
            // Two ways to have chosen this terminal, and the reason exists so a surprising route is
            // debuggable — so it must say WHICH. "you named this agent" over a message that named
            // nobody would send the next person reading a log hunting for an address that was never
            // typed.
            reason:
              mentionAim.via === "mount"
                ? "the concierge is mounted to this agent"
                : "you named this agent in the message",
            // "heuristic" for the same reason `forceSparkle` claims it: tier 1 means deterministic
            // and zero-cost, and no model was asked. Naming the agent yourself is as tier-1 as it
            // gets — it is not a guess at all. Nor is patching a cable into one: both are gestures
            // the user made, which is the distinction conciergeRouter's header turns on.
            source: "heuristic",
          } as const)
        : forceSparkle
        ? ({
            target: "sparkle",
            reason: "you sent this from the capture window's Chat",
            // "heuristic", not "classified"/"fallback": no model was asked and nothing failed —
            // this is a deterministic, zero-cost decision, which is exactly what tier 1 is.
            source: "heuristic",
          } as const)
        : await routeMessage(text, {
            agent: aim ? { id: aim.agentId, name: aim.name, status, canAcceptInput } : null,
          });

      // Re-check AFTER the (network) route call too: the agent can be closed while we classify,
      // and dispatching at a corpse surfaces as a pty-gone error where the router's own design
      // says to take the safe direction.
      const stillThere = !!aim && agentStillExists(aim.agentId);
      if (decision.target === "agent" && aim && stillThere) {
        // ══ THE FORWARDING-BUG FIX ══════════════════════════════════════════════════════════════
        // This used to dispatch, right here, on the router's verdict alone — an agent with a live
        // prompt plus terse concierge-aimed text matched the router's own answer-detector, and the
        // user's words went into a terminal with no warning and no way back.
        //
        // THE ROUTER CAN NO LONGER PRODUCE THAT VERDICT AT ALL. The detector and its branch were
        // deleted: `routeMessage` never returns `agent`, so the only decision that reaches this
        // block is the one built a few lines up from an explicit `@Name` in the text (see
        // conciergeRouter's header for the damage that forced it). What remains here is therefore
        // the ADDRESSED path — a destination the user stated in words.
        //
        // THE AUTHORITY GATE STAYS ON EVERY PATH — but the COUNTDOWN no longer does, and the two
        // are different things. Nothing reaches a terminal without naming the user gesture that
        // authorized it: an ADDRESSED send still arms an intent, becomes visible, counts down and
        // can be cancelled, dispatching only on an expiry the user didn't stop and carrying
        // `{ kind: "countdown", intentId }`; a MOUNTED send goes immediately carrying
        // `{ kind: "mount", agentId }` (see the mount block below for why the veto window buys
        // nothing there). That is why there is no `router` arm in DispatchAuthority and must never
        // be one — a heuristic verdict is not a user gesture, and the union having no legal variant
        // for it is what makes the old behavior unrepresentable rather than merely discouraged.
        // Explicitness buys a skipped classify — and, for a mount, a skipped WAIT — never a skipped
        // gate.
        // What actually goes down the wire. For an ADDRESSED message that is the version with the
        // `@…` stripped: the agent on the far end is a Claude Code CLI, where a leading `@` opens
        // its own file-reference autocomplete, so relaying the address verbatim would pop a picker
        // inside the agent's composer and strand the instruction behind it (mentions.
        // mentionFreeText). Every other send is unchanged.
        const wire = mentionAim && addressable ? mentionAim.payload : payload;
        const namingBasis = mentionAim && addressable ? mentionAim.text : text;
        // ══ THE DISPATCH ITSELF, LIFTED OUT OF THE ARMING ═══════════════════════════════════════
        // ONE body, two callers, and the sharing is a safety property rather than a tidiness one. A
        // MOUNTED send calls this immediately (just below); an ADDRESSED send calls it when its
        // countdown elapses. Everything between the decision and `submitPrompt` is identical and all
        // of it is load-bearing: the agent-still-exists re-check, the screen re-check, both refusal
        // paths, the receipt, and the draft/attachment restore. A second copy of that for the
        // immediate path is exactly how one branch quietly loses a guard the other keeps.
        const dispatchToTerminal = (authority: DispatchAuthority) => {
          // Through the queue, so a send that armed first still lands first — dispatching must not
          // silently reorder messages relative to an Approve or a redirect.
          void enqueue(async () => {
            // The agent can be closed between the route decision and this write, and dispatching
            // at a corpse would report a delivery that cannot happen — the same re-check `deliver`
            // does around the route call, for the same reason.
            //
            // HOW WIDE THAT GAP IS DEPENDS ON THE CALLER, which is why the check is here rather
            // than at either call site. On the ADDRESSED path seconds have passed — a whole
            // countdown — and the gap is much wider than `deliver`'s. On the MOUNTED path there is
            // no countdown and this runs on the same tick as the submit, so the check is nearly
            // free and nearly always true. Nearly is not always: `enqueue` still serializes this
            // behind whatever was already in flight, so the agent can be gone even here.
            if (!agentStillExists(aim.agentId)) {
              // STILL A PILL, even though the agent is gone. The id is real — it is the agent
              // that closed, not the reference — so the pill resolves to its known-closed state,
              // which names it and offers the route to what it did. That is strictly more than
              // the bare text said.
              postSparkle(line`${ref(asAgent(aim))} isn't open any more, so I didn't send that.`);
              restoreDraft(text, sentQuote);
              restoreAttachments(staged);
              return false;
            }
            // ══ AND THE SCREEN AGAIN, IMMEDIATELY BEFORE THE WRITE ═══════════════════════════
            // The same re-check the block above makes for the agent's existence, over the same
            // gap and for the same reason. On the ADDRESSED path that gap is a whole countdown —
            // exactly long enough to open `vim` or hit a `sudo` prompt in — so the submit-time
            // check is the fast cheap answer and THIS one is the load-bearing one: it is the last
            // thing between the founder's text and `submitPrompt`'s paste-and-carriage-return. Do
            // not delete either as redundant; they observe two different instants, and only the
            // second observes the instant that matters.
            //
            // THE MOUNTED PATH NEEDS THIS JUST AS MUCH, and the reason is easy to get wrong — an
            // earlier version of this comment claimed the two instants "coincide" once the
            // countdown is gone, and that is FALSE. `enqueue` chains every dispatch onto ONE
            // GLOBAL send queue, so this body can run well after the submit even with no countdown
            // at all: long enough to open vim, exactly like the addressed path. The window is
            // narrower, not absent — so do not "tidy" this away as redundant on the mount.
            //
            // ITS TEST IS THE ADDRESSED ONE, and that is now sufficient rather than a gap: both
            // paths run THIS function, so these are the only post-write screen-check lines in the
            // code and the addressed row exercises them literally. Mutating this to `null` kills
            // that row. A mounted equivalent is unwritable — the send-while-busy queue re-runs the
            // submit-time check when it drains a held message, so the earlier guard always refuses
            // first. See the note on the mounted screen row for the full reasoning.
            const blocked = mentionAim
              ? terminalWriteBlocked(aim.agentId, mentionAim.via)
              : null;
            if (blocked) {
              postSparkle(terminalRefusalLine(asAgent(aim), blocked));
              if (displayMountedRef.current)
                noteMounted(terminalRefusalText(aim.name, blocked), "warn");
              const returned = restoreDraft(text, sentQuote);
              restoreAttachments(staged);
              // BOTH refusal instants retract, for the reason roborev 57360 made both of them post
              // a receipt: the two must tell the identical story about an identical outcome. This
              // is the LATER instant — on the addressed path, the one the founder reaches after
              // watching a countdown run; on the mounted path, the same tick as the submit.
              if (returned) {
                retractSend(id);
                return false;
              }
              // THE SAME RECEIPT THE SUBMIT-TIME REFUSAL POSTS. This used to post none at all, so
              // the two refusal instants told the user different stories about the identical
              // outcome — and the later one, the one an addressed send reaches after they have
              // watched a countdown run, was the silent one (roborev 57360).
              setReceipt(id, {
                target: "agent",
                refused: true,
                agentName: aim.name,
                agentId: aim.agentId,
                redirectable: false,
              });
              return false;
            }
            // announceSuccess: false — the receipt below already reads "→ Sent to <agent>".
            const ok = await promptAgent(
              aim,
              wire,
              { display, namingBasis },
              staged,
              false,
              authority,
              // An ADDRESSED message is a message. Without this the dispatcher would still match
              // it against a live picker and press a button (roborev 54569).
              !!mentionAim && addressable,
            );
            // A FAILED delivery gets no receipt: promptAgent has already said what went wrong in
            // the thread, and "→ Sent to X" over a message that never arrived would be a plain lie.
            if (ok) {
              setReceipt(id, {
                target: "agent",
                agentName: aim.name,
                agentId: aim.agentId,
                redirectable: true,
              });
              // ══ THE CONCIERGE STAYS IN THE CONVERSATION ═══════════════════════════════════
              // The founder's headline requirement for this feature: "the concierge sends it over
              // to that builder agent, but ALSO still participates in the conversation… I want
              // the concierge to be a thought partner."
              //
              // Only for an ADDRESSED send. A message the ROUTER decided belonged to an agent is
              // one the user wrote to that agent — following it with an unbidden chat turn would
              // put a paragraph of commentary after every terse "yes" typed at a picker, and bill
              // a brain turn for it. Naming an agent is different: it is a message sent THROUGH
              // the concierge, which is a conversation the concierge is a party to.
              //
              // AFTER delivery, never at arm time. The countdown is cancellable, and a reply
              // saying "sent it" over a send the user then stopped would be exactly the kind of
              // small lie the receipt rules in this file exist to prevent.
              //
              // Quotes the DISPLAY rendering, never the wire: `payload` carries the attachments'
              // temp paths, and this text reaches the brain's context (roborev 46925).
              //
              // ══ AND NOT FOR A MOUNTED SEND EITHER (`via === "mount"`) ══════════════════════
              // Same reasoning as the router-decided case above, arrived at from the other side.
              // A message ADDRESSED to an agent is sent THROUGH the concierge — the founder
              // handed it something to relay, so the concierge is a party to that. A MOUNTED
              // message is the founder talking straight to the agent: the column has swapped to
              // that agent's own conversation, the compose box is keyed to that agent's draft,
              // and Sparkle is not in the room. Following every line of that conversation with a
              // paragraph of unbidden commentary — and billing a brain turn for each one — is not
              // a thought partner, it is a tax on typing. The receipt still names where the
              // message went, and the redirect is still one tap away when the founder does want
              // Sparkle's read on it.
              if (mentionAim?.via === "address" && addressable)
                askSparkle(relayFollowUp(aim.name, display));
              return true;
            }
            // A failed delivery must not cost the user their files any more than their words
            // (roborev 46922/48172/49293).
            restoreDraft(text, sentQuote);
            restoreAttachments(staged);
            return false;
          }, false);
        };

        // ══ MOUNTED: IT GOES NOW, WITH NO COUNTDOWN ═════════════════════════════════════════════
        // THE FOUNDER'S ASK, verbatim: "when the concierge is mounted and I'm sending something to a
        // build agent, I don't need this countdown. I just want it to be sent immediately."
        //
        // WHY THIS IS THE RIGHT SEAM AND NOT A HOLE IN THE FORWARDING FIX. The countdown was built
        // for a bug where concierge-aimed text was SILENTLY forwarded to an agent the ROUTER chose —
        // the user never picked that destination, so they were owed a chance to veto it. That verdict
        // is now unrepresentable: `routeMessage` cannot return `agent` at all (see the block above).
        // The only two destinations that still reach here are ones the user STATED — an `@Name` they
        // typed, or a cable they patched — and a mount is the more explicit of the two. The column
        // has swapped to that agent's conversation and the compose box is keyed to that agent's
        // draft; there is no ambiguity left for a banner to resolve, so the three seconds buy nothing
        // and cost every line they type.
        //
        // THE ADDRESSED PATH KEEPS ITS COUNTDOWN. `@Name` is a message relayed THROUGH the concierge
        // — sent from a surface aimed somewhere else — so a mistyped or mis-resolved name is still a
        // real misroute with a real veto window. Narrowest correct predicate, not "kill the
        // countdown".
        //
        // THE DICTATION COUNTDOWN IS UNTOUCHED. That is a different engine entirely
        // (voice/autoSendTimer, whose header explains why it is a SIBLING of services/dispatchIntent
        // rather than a caller). Speak still ends an utterance on silence exactly as before, and
        // nothing on this path can reach it.
        //
        // ══ ...BUT ONLY WHILE HE IS ACTUALLY AT THE MACHINE ═════════════════════════════════════
        // THE INVARIANT, and it is the whole of the safety argument in one line: **a mount skips the
        // countdown only when presence says HERE; while Away a mounted send behaves exactly as an
        // addressed one does.** Nothing about the mount is special when nobody is watching.
        //
        // WHY PRESENCE AND NOT THE DANGER CLASSIFIER. The obvious carve-out is "instant unless the
        // text is destructive", and it was tried and REJECTED here — it does almost nothing.
        // `DESTRUCTIVE_CATEGORIES` is `APPROVAL_CATEGORIES` minus `NON_BASH_CATEGORIES`, which is
        // exactly `["bash"]`, and `approvalClassifier` was tuned on permission-prompt HEADERS, not
        // free-form prose (its own header says so). Measured against the real classifier: `rm -rf .`,
        // `force push to main`, `drop the users table`, `deploy to production` and `land the PR and
        // delete the branch` ALL classify as `routine`. Only text happening to contain "command",
        // "execute" or "bash" reads destructive — so a classifier gate would have protected the
        // phrasing nobody uses while waving through every phrasing they do, and made the banner's
        // appearance look arbitrary to the user. Do not re-add it here: if that taxonomy should
        // recognise destructive prose, that is a fix in services/dispatchClass (the ONE taxonomy,
        // per its locked decision) with its own table-driven test, not a second opinion in this file.
        //
        // WHAT PRESENCE BUYS THAT THE CLASSIFIER CANNOT. The thing actually worth protecting is
        // `shouldDispatchOnExpiry`, which HOLDS a destructive send when nobody is at the machine.
        // Falling through to `armIntent` whenever presence is Away preserves that rule untouched and
        // costs the classifier's false negatives nothing — an Away machine gets the identical
        // treatment an addressed send has always had.
        //
        // AND IT COSTS HIM NOTHING WHILE HERE, which is why this is not a hedge. With presence Here,
        // `shouldDispatchOnExpiry` returns true for BOTH classes — so arming would never have HELD
        // anything, it would only have added the cancel window he explicitly said he does not want.
        // Skipping it while Here gives up a veto that was never going to fire.
        //
        // (An earlier draft argued the away-rule could not bite on an immediate path at all, since
        // presence is read at expiry and with no delay the expiry IS the submit. THAT IS WRONG and
        // is why this gate exists: `enqueue` chains every dispatch onto one global queue, so the
        // body can run well after the submit. No instant here is "demonstrably the submit".)
        //
        // THE SCREEN RE-CHECK IS *NOT* REDUNDANT HERE EITHER, for that same `enqueue` reason: the
        // submit-time check and the one inside `dispatchToTerminal` still observe different
        // instants on this path, so both are load-bearing and neither may be "tidied" away.
        // ══ SUBMITTING IS INPUT, EVEN WHEN NOBODY TOUCHED THE KEYBOARD ═══════════════════════════
        // `noteInput` has THREE production feeders, and the count matters because an earlier version
        // of this comment said "exactly two" and reasoned from it (roborev 60344):
        //   • `Concierge/ComposeBox`'s `onChange`   — keystrokes, and only the USER's own edits: a
        //     dictated segment landing in the box must not report Here on its own (see it);
        //   • `Terminal`'s xterm `onData`           — keystrokes;
        //   • `services/dictationTerminalSink`      — a post-write poke, and the one that is NOT a
        //     keystroke. It fires only for a dictated delivery straight into a TERMINAL, so it does
        //     not see a concierge send at all.
        //
        // So the hands-free gap is real but narrower than "voice never counts": drive the concierge
        // by voice — read terminal output for five minutes without typing, dictate a line, let
        // auto-send fire — and none of the three has fired, so presence has already resolved to Away,
        // this gate falls through, and the countdown banner is back in precisely the mode where he is
        // not typing. (Dictating into a terminal, by contrast, does keep him Here.)
        //
        // ══ COMPUTED LOCALLY, NOT POKED INTO THE STORE — THAT DISTINCTION IS THE WHOLE POINT ══════
        // The obvious fix is `usePresenceStore.getState().noteInput()` at the submit seam. It was
        // written that way first and it is WRONG, because the blast radius is not this gate: it
        // resets the store's idle clock for `IDLE_AWAY_MS`, and the ARMED path reads presence AT
        // EXPIRY (see `presence:` below) precisely so that walking away DURING a countdown still
        // queues a destructive send. A global poke therefore silently converts "idle-Away +
        // destructive → queued" into "→ dispatched", deleting the one path by which the idle
        // heuristic could still reach the queue arm. And the submit need not be a gesture at all —
        // `send` is reachable from the auto-send RAIL, i.e. a timer firing after dictation silence.
        //
        // So the inference is scoped to the ONE decision that needs it: `resolveMode` re-run over a
        // COPY of the facts, answering "would presence read Here if this submit counted as input?"
        // while mutating nothing. `manualAway` and an unfocused window still win, because both sit
        // ahead of the idle rule inside `resolveMode` — an explicit "I'm stepping out" is not
        // overridden by a timer firing.
        //
        // ══ ANCHORED TO `submittedAt`, NOT TO NOW — AND THAT IS NOT A REFINEMENT ═════════════════
        // Writing `lastInputAt: Date.now()` here (as the first cut did) makes the idle clause
        // STRUCTURALLY UNREACHABLE: `now - lastInputAt` is then identically zero, so the gate always
        // reads Here and the credit is granted at DEQUEUE time. This body is the enqueued half — the
        // same one whose neighbours insist it "can run well after the submit" — so that turns a
        // minutes-old send into an immediate write to a live terminal. `MAX` rather than a bare
        // `submittedAt`, so a real keystroke that landed AFTER the submit still counts.
        const presenceCountingThisSubmit = (() => {
          const facts = usePresenceStore.getState();
          return resolveMode(
            { ...facts, lastInputAt: Math.max(facts.lastInputAt, submittedAt) },
            Date.now(),
          );
        })();
        if (
          mentionAim?.via === "mount" &&
          addressable &&
          presenceCountingThisSubmit === "here"
        ) {
          dispatchToTerminal({ kind: "mount", agentId: aim.agentId });
          // TRUE — the text is in hand and on its way. There is no banner to announce and no cancel
          // window to describe; the receipt the dispatch posts is what says where it went, and the
          // failure and refusal paths inside `dispatchToTerminal` are what put the words and the
          // files back if it never lands.
          return true;
        }

        const armed = armIntent({
          text: wire,
          // The BANNER and the live region quote this, never `payload`. `attachedPayload` prefixes
          // each attachment's quoted temp path, so quoting it would make the column announce
          // `I'll tell Kraken Auth: "'/var/folders/x9/T/sparkle-shot-1753.png' what is wrong here?"`
          // — the exact leak the "temp paths must never reach any of them but the first" invariant
          // above forbids. Same string that goes to promptAgent's `display` a few lines down.
          display,
          targetAgentId: aim.agentId,
          targetName: aim.name,
          // ══ PRESENCE ════════════════════════════════════════════════════════════════════════
          // The REAL store, read at expiry rather than captured at arm time — the user can walk
          // away during the very seconds the countdown is running, which is the window the
          // precedence rule exists to cover. `mode` is stored, not derived, so this is a plain
          // synchronous field read (see stores/presenceStore's header).
          //
          // This used to be the literal `() => "here"` while the presence store lived on a
          // parallel branch. That was fail-OPEN: forgetting this line produced no type error and
          // no red test, and destructive sends fired at an unattended machine. `presence` is a
          // required field for that reason — do not give it a default.
          presence: () => usePresenceStore.getState().mode,
          onDispatch: (_intent, authority) => dispatchToTerminal(authority),
          // The precedence rule held it: destructive, and nobody is at the machine. Say so plainly
          // — a queued action the user never hears about is its own silent failure, the mirror of
          // the one this whole change removes.
          //
          // NOTHING IS RESTORED HERE, and that is the point of the change. This used to hand the
          // draft and the files back and tell the user to send again, which is a DROP dressed up
          // as a hold: their message was gone. The intent now survives in the queue owning both
          // the text and `staged` (still captured by the dispatch closure above), and comes back
          // in front of them when they return. Restoring the draft as well would duplicate the
          // message and re-stage files the pending send is still holding.
          onQueue: () => {
            postSparkle(
              line`That looked like it could break something and you were away, so I'm holding it rather than sending it to ${ref(asAgent(aim))}. I'll bring it back when you return.`,
            );
            // ══ AND SAY IT ON THE MOUNTED SURFACE TOO ═══════════════════════════════════════════
            // A mount can now reach this handler (mounted + Away falls through to the arming), and
            // `postSparkle` alone is INVISIBLE there: the mounted column does not render
            // `ConciergeThread`. The banner cannot cover for it either — it renders `armedIntents()`
            // and a queued intent lives in `queuedSnapshot`, so it leaves the banner as well. Without
            // this line the composer clears, the banner empties, and NOTHING on screen says the
            // message is held — the exact silent hold this handler's own copy exists to prevent, and
            // worse than the original bug because `onQueue` deliberately restores no draft either.
            // Every other user-visible line in this function mirrors to `noteMounted` for this
            // reason; these two were the omissions.
            if (displayMountedRef.current)
              noteMounted(
                `That could break something and you were away, so I'm holding it for ${aim.name} rather than sending it. I'll bring it back when you return.`,
                "warn",
              );
          },
          // Back from the queue and in front of the user again. Feed the column's ONE live region:
          // a re-presented send nobody announces is exactly as silent as the bug this fixes.
          onRepresent: (intent) => {
            announce(countdownAnnouncement(intent, Date.now()));
          },
          onCancel: () => {
            // Everything the send was carrying comes back — the draft and the files — for exactly
            // the reasons the failure path above restores them. Cancelling must cost the user
            // nothing, or they learn not to use the button.
            restoreDraft(text, sentQuote);
            restoreAttachments(staged);
            postSparkle(line`Okay — I didn't send that to ${ref(asAgent(aim))}.`);
            // Mirrored for the same reason as `onQueue` above — a mounted column renders no thread,
            // so the Sparkle line lands nowhere the founder can see. Less severe here (the draft IS
            // restored, so the words visibly come back), but the two must tell one story.
            if (displayMountedRef.current)
              noteMounted(`Okay — I didn't send that to ${aim.name}.`, "info");
          },
        });
        // Feed the column's ONE live region (see setReceipt): a countdown a screen-reader user
        // can't hear is a countdown they can't cancel. Through `announce`, never `setAnnouncement`
        // — two identical consecutive sends to the same agent produce the same sentence, and a bare
        // setState React bails out of would swallow the repeat (roborev 53392).
        announce(countdownAnnouncement(armed, Date.now()));
        // TRUE — the text is in hand: armed, visible, and cancellable. The box clears its draft, and
        // the cancel/failure paths above are what put it (and the files) back if it never lands.
        return true;
      }
      // The BRAIN gets the payload, not the bare text: the concierge's headless `claude -p` reads
      // attachment paths from disk exactly as an agent does (services/conciergeAttach), so
      // stripping them here would hand Sparkle a question about a screenshot it cannot see. Only
      // the ROUTER is given the clean text — "/var/folders/…/shot.png add retry logic" is not what
      // the user said, and classifying it as if it were is a real misroute.
      // WITH THE BUBBLE ID: this turn answers `id`, and if the user's next message displaces it
      // before a single byte comes back, that bubble is the one that has to say so.
      askSparkle(payload, id);
      // ══ THE ESCAPE HATCH HAS TO SAY WHERE ITS ANSWER WENT (roborev 57360) ═══════════════════════
      // Sparkle's reply lands in `ConciergeThread`, which a MOUNTED column does not render — so
      // `@Sparkle what is the status?` produced a routed message, a real answer, and nothing on
      // screen. That makes the documented way out of a mount look broken.
      //
      // The full prose does not belong in a one-line banner, so this points at it rather than
      // quoting it. Only while mounted: unmounted, the answer appears in the thread the founder is
      // already looking at and a notice would be noise about the ordinary case.
      //
      // ══ AND IT NAMES WHO DID *NOT* GET IT (the founder's second ask on this bug) ═════════════════
      // "Asked Sparkle — press Esc to unmount and read the reply." was the whole line, and it names
      // the wrong concern: it tells the founder where the ANSWER is while saying nothing about the
      // agent he is mounted to and plainly looking at. That is what let the misroute read as normal
      // for as long as it did — the one line on screen that could have said "this did not reach your
      // agent" was busy talking about a reply.
      //
      // Every remaining way to reach this while mounted is DELIBERATE now (a leading `@Sparkle`; the
      // two ways an aim turns out unusable write their own, more specific line and set
      // `notedThisSend`), so naming the mount here is never a report of a surprise — it is the
      // receipt for a diversion he chose, and it is exactly as true unmounted, where the name is
      // simply absent.
      //
      // …EXCEPT WHEN THE MOUNT IS THE APP-OWNED SPARKLE AGENT, WHOSE NAME IS "Sparkle" (roborev
      // 59097). `mountedName` falls back to `SPARKLE_AGENT_NAME` for that row, so the named form
      // rendered `Asked Sparkle — not Sparkle.` — and it rendered it in the LIKELIEST case, since a
      // leading `@Sparkle` is now the only way to reach this line while mounted and it is exactly
      // what someone mounted to an agent called "Sparkle" types. A line whose whole job is to
      // separate "the brain got it" from "your agent did not" must not collapse into a
      // contradiction when the two share a name; the unnamed form is the honest one there, and it
      // is the fallback that already exists.
      //
      // ══ AND IT NAMES BOTH KEYS, FOR THE REASON ConciergeColumn'S HINT DOES (bead sparkle-thm9o) ══
      // This is the other on-screen affordance telling the user how to get out of a mount, and it
      // said "Esc" alone. Escape is exactly the key one leaked hidden `role="dialog"` node disabled
      // app-wide — the founder's "I could not unmount the concierge" — so under the conditions that
      // make someone read this sentence, the remedy it offered was the one that could not work while
      // a working one went unmentioned. Fixing the column's hint and leaving this would relocate the
      // defect rather than close it (AGENTS.md, "user-facing copy is code").
      //
      // Drawn from the LIVE binding, not a hard-coded "⌘⇧U": `unmountCable` is rebindable in
      // ⋯ Settings → Shortcuts. Read through `getState()` — this runs inside a send callback.
      if (displayMountedRef.current && !notedThisSend) {
        const mounted = displayMountedRef.current;
        const held = isSparkleAgentId(mounted) ? undefined : displayMountedNameRef.current;
        const keys = `Esc or ${formatBinding(useKeybindingsStore.getState().bindings.unmountCable)}`;
        noteMounted(
          held
            ? `Asked Sparkle — not ${held}. Press ${keys} to unmount and read the reply.`
            : `Asked Sparkle — press ${keys} to unmount and read the reply.`,
          "info",
        );
      }
      const here = stillThere ? aim : null;
      setReceipt(id, {
        target: "sparkle",
        agentName: here?.name,
        agentId: here?.agentId,
        // NOT an unconditional `true` any more. A bare `@Sparkle` strips to an empty wire, and
        // offering to pass "nothing" along to an agent is a button that cannot do its job — see
        // `redirectable`'s note on the parameter above.
        redirectable,
      });
      return true;
    },
    [
      askSparkle,
      promptAgent,
      setReceipt,
      agentStillExists,
      restoreAttachments,
      restoreDraft,
      retractSend,
      enqueue,
      postSparkle,
      announce,
      noteMounted,
    ],
  );

  /**
   * The compose box's entry point.
   *
   * Everything that must reflect SUBMIT happens synchronously here — the user's bubble, the
   * remembered text, the staged files, the capture-Chat aim, and the AIM. Only routing and
   * delivery are queued.
   *
   * Both halves are load-bearing. Queuing the bubble left a second rapid send with no visible state
   * at all: the box clears on submit, so the text was simply gone from the UI for up to the route
   * deadline plus a round trip. And re-reading the aim inside the queued function would deliver to
   * whichever agent the user happened to be looking at when the queue reached it — reintroducing,
   * through the ordering fix itself, exactly the misdelivery the removed pinned-aim guard prevented.
   */
  const send = useCallback(
    (
      text: string,
      mentions?: ConciergeMention[],
      /** The BUBBLE's decomposition of `text` — the pills the compose box staged and the words
       *  typed around them (composer/attachments' `CollapsedSend`). Present only when a pill was
       *  staged. It reaches exactly ONE of the renderings below; see `bubbleText`. */
      collapsed?: CollapsedSend,
    ): Promise<boolean> => {
      // The capture-Chat aim, consumed HERE for the same reason the aim itself is: everything that
      // must reflect SUBMIT happens synchronously, so a handoff landing while this send is still
      // queued cannot retroactively redirect it.
      // WHEN this submit happened, captured HERE for the same reason `submitted` and `staged` are:
      // everything that must reflect SUBMIT is read synchronously, because `deliver` runs off a
      // global queue and can execute long afterwards. The mounted immediate-dispatch gate uses it to
      // decide whether the submit still counts as evidence the user is at the machine — see
      // `deliver`'s `submittedAt` param for why reading the clock down there instead is inert.
      const submittedAt = Date.now();
      // ══ AND THE STORE IS STILL NOT POKED HERE — INCLUDING FOR A REAL CLICK ══════════════════════
      // WHY the store is left alone is stated once, at the mount gate in `deliver` — do not restate
      // it here. This block records only what that one cannot: the follow-up that was TRIED, the
      // measurement that killed it, and where the attempt lives.
      //
      // `if (!autoFiringRef.current) usePresenceStore.getState().noteInput()` — the same gesture gate
      // `notifyManualSend` uses further down — reds "leaves the idle clock alone, so an addressed
      // destructive send still QUEUES while idle-away" (2 failed / 60 passed; without it, 61 passed).
      // `noteInput` clears the idle clock for IDLE_AWAY_MS, far longer than any countdown, so click →
      // walk away → expiry would DISPATCH the destructive send. The gesture gate only narrows WHO
      // reopens that hole.
      //
      // THE ATTEMPT ITSELF IS NOT RECOVERABLE FROM HERE, and this comment used to imply otherwise by
      // naming `refs/rescue/presence-queue-drain`. That ref is CLONE-LOCAL: `refs/rescue/*` is
      // outside the default fetch refspec, so it is never pushed and never fetched, and its object
      // is reachable from no remote branch (checked). For anyone but its author it resolves to
      // nothing. The durable record is this comment plus roborev 60321/60239 — and the change is two
      // lines, so re-deriving it from the description above is cheaper than hunting a dangling ref.
      //
      // WHAT IS ACTUALLY UNRESOLVED, stated precisely because an earlier cut of this comment
      // overclaimed it (roborev 60344): THIS submit cannot release a held send. A held send is
      // otherwise drained by any away → here transition — refocusing the window (`setFocused`), the
      // Here/pin slider (`setHere`/`setPinnedHere`), or a keystroke — and only ages into
      // needs-confirmation in the narrow case where none of those happens: idle-Away, window still
      // focused, never typing, never touching the slider. The queue is not a dead end.
      //
      // The drain needs its own trigger rather than a presence lie, and whether a manual submit
      // SHOULD release a previously-held destructive send is a product question — filed, not
      // inferred here.
      const forceSparkle = forceSparkleRef.current;
      forceSparkleRef.current = false;
      // ══ WHERE THIS MESSAGE GOES ═════════════════════════════════════════════════════════════════
      // The founder's rule, whole, in one pure function (Concierge/composerRoute):
      //
      //   a leading @Sparkle → the concierge   |   a leading @Name → that agent's terminal
      //   otherwise, mounted → the mount's terminal   |   otherwise → the concierge
      //
      // THE FIRST MENTION ONLY, and only when it LEADS. One terminal per message: fanning an
      // irreversible action across every name in a sentence is not something to do behind a comma —
      // every extra name is still drawn as a pill in the bubble, so nothing is hidden, and the
      // receipt names the one that was actually used. And a name that does not lead is the sentence's
      // SUBJECT, not its envelope ("Why is @Kraken Auth just sitting there?" is a question about that
      // agent, aimed at the concierge) — the same positional test `mentionFreeText` uses to decide
      // what to strip, shared so the span that chose the terminal is the span that gets consumed.
      //
      // @Sparkle IS A REAL DESTINATION, NOT AN UNRESOLVABLE NAME. The concierge is a first-class
      // target of this box — `mentionRoster` offers it in the picker, and dictating the word
      // "Sparkle" inserts that pill — but it is not a FEED agent, so looking it up in
      // `mentionAgentsRef` was always going to miss and fall through as "named nobody", which is a
      // lie about a name the user explicitly chose from a picker (bead sparkle-kaz1l). It is now the
      // ESCAPE HATCH from the mount, which is the only reason it has to beat everything else.
      const route = classifyComposerRoute({
        text,
        mentions: mentions ?? [],
        mountedAgentId: mountedAgentIdRef.current,
      });
      const conciergeAddressed = route.kind === "sparkle" && route.via === "address";
      // Resolved against the LIVE roster, so an address naming an agent that has since closed simply
      // fails to resolve and the message falls back to the auto-router — the recoverable direction,
      // and the same answer `deliver` gives when an aim goes missing mid-flight.
      const mentionedAgent =
        route.kind === "agent" && route.via === "address"
          ? mentionAgentsRef.current.find((a) => a.id === route.agentId)
          : undefined;
      // ══ THE IMPROVE-SPARKLE MOUNT IS NO LONGER ITS OWN ADDRESS (bead sparkle-gw8yi) ══════════════
      // A `mountAddress` used to live here: if `targetRef.current` was the app-owned Sparkle agent and
      // the user had not addressed anybody, the message was treated as if they had typed its name —
      // the cancellable, picker-safe ADDRESSED path (sparkle-0rf5), justified by that pane having no
      // composer of its own.
      //
      // IT WAS BUILT FROM `targetRef.current`, AND THAT IS NOT THE MOUNT. `targetRef` is the prompt
      // target, and for this agent Workspace sets it from `activeSpecial === "sparkle"` alone
      // (`sparkleTarget`, Workspace.tsx) — the pane being the surface on screen, with NO reference to
      // the cable. So the founder pressing Escape (cable off, `wired === "off"`, pane still visible)
      // left `mountedAgentId` null while this still fired: his plain, unaddressed message was aimed at
      // that agent's PTY, met the screen guard, and came back as *"@Sparkle has a full-screen app
      // open"* — a sentence about an agent he was not talking to, refusing a message that was bound
      // for the concierge. Improve Sparkle runs Claude Code and is long-running, so it holds the
      // alternate buffer almost always: his cursor resting in that row silently cost him the ability
      // to talk to Sparkle at all. He proved it himself — *"I just moved the cursor OUT of the Improve
      // Sparkle row … and now it seems you're able to receive messages again."*
      //
      // NO REPLACEMENT, AND THAT IS THE POINT. The founder's requirement is that this agent behave
      // like every other build row: *"When I click on the Improve Sparkle agent, I want it to MOUNT
      // THE CONCIERGE INTO THAT AGENT just like it would a regular builder agent."* An ordinary build
      // agent reaches its terminal through `mountRouted` below and through nothing else, and that is
      // CABLE-gated — so this agent now does too. `AgentSidebar.onSelectSparkle` already patches the
      // cable on click, which is what makes the click a mount rather than a selection; Escape unpatches
      // it, and an unpatched cable means the concierge, exactly as it does for every other row.
      //
      // THE ONE THING THIS BUYS BEYOND THE REFUSAL: a concierge-bound message is now structurally
      // incapable of being screen-checked here. `addressable` requires `mentionAim`, which requires
      // `addressedAgent || mountRouted` — with this gone, neither can be true of a message routed to
      // the concierge, so no screen check of any kind runs on one. There is no screen to check: the
      // concierge is not a PTY.
      const addressedAgent = mentionedAgent;
      // ══ THE ONE RULE THAT AIMS A MOUNTED MESSAGE AT A TERMINAL ══════════════════════════════════
      // Any CABLE-MOUNTED build agent, the app-owned Sparkle one included — one rule, not a general
      // case with a special case beside it (see above for why the special case had to go).
      //
      // A MOUNT AIMS AT `mountTargetRef`, NOT AT A ROSTER LOOKUP, and the two cannot disagree:
      // `routableMountedAgentId` is derived from that very target, so re-deriving the projectId/name
      // from anywhere else would be a second source of truth for one fact. False when the cable moved
      // between render and submit, which falls through to the ordinary unaddressed path — the
      // recoverable direction.
      //
      // `mountTargetRef` AND NOT `targetRef`: the latter is `routingTarget`, which `promptTargetShown`
      // still gates for the unmounted inference path. Cross-checking a mount against it is what made
      // the founder's plain mounted send fall through to the concierge — see `routableMountedAgentId`.
      const mountRouted =
        route.kind === "agent" &&
        route.via === "mount" &&
        mountTargetRef.current?.agentId === route.agentId;
      // NO GUARD HERE FOR "named but unresolvable", deliberately, and it is worth saying why since it
      // is the obvious thing to add. `named` exists only when the COMPOSER's roster recognised the
      // span, and this lookup uses the same feed — one render, one source — so a recognised name is
      // always found. A name matching nobody never becomes a mention at all; it stays prose and goes
      // to the router (see "falls back to the router when the name matches nobody in the fleet").
      // `@Sparkle` was the sole exception, because `mentionRoster` appends the concierge for the
      // picker while `mentionAgents` does not carry it — which is exactly the bug fixed above, not a
      // class of bug needing a general fallback. The resolvable-but-unreachable case (agent closed or
      // cloud) does have a voice: `deliver`'s `addressed && !addressable` explains it by name.
      // Same courtesy the agent composer extends: honor the pause-on-submit voice setting so the
      // ── NOTHING PAUSES THE MIC ON SUBMIT ANY MORE ───────────────────────────────────────────
      // A submit used to call `maybePauseOnSubmit()`, which dropped dictation from active back to
      // "waiting for the wake word" — on by default, and skipped for auto-fires precisely because
      // doing it there "would have the feature undo itself", making the user re-say the wake word
      // after every hands-free send.
      //
      // With the wake word retired there is no phrase to resume with, so that pause would leave the
      // microphone unable to come back at all: Speak would go quiet after the first message and stay
      // quiet until the user moved the tray. "SPEAK SHOULD BE ALWAYS ON" is the requirement, and the
      // tray is now the only thing that starts or stops dictation — a send is not a mic gesture.
      //
      // It was also producing the wrong state elsewhere. `pauseActiveDictation` wrote `phase` while
      // capture stayed LIVE, so the composer painted "Listening paused" over a backend still
      // emitting partials seconds later — a second writer of the phase, which is exactly what
      // voice/dictationPhase now documents as having exactly one.
      const id = nextId("you");
      // A named agent OVERRIDES what happens to be selected — that is the whole point of naming one.
      // `addressedAgent` folds in the Improve-Sparkle mount (above), which resolves to the same
      // `targetRef.current` it is built from, so the fallback is unchanged for every other send.
      //
      // A MOUNT SUPPLIES ITS OWN, for the reason spelled out at `mountRouted` above: `targetRef` is
      // gated by `promptTargetShown` and a mount is not. Falling back to it here would hand `deliver`
      // a null aim for exactly the sends this fix exists to route, and `addressable` would go false —
      // the concierge again, by a different road.
      const submitted: ConciergePromptTarget | null = addressedAgent
        ? {
            projectId: addressedAgent.projectId,
            agentId: addressedAgent.id,
            name: addressedAgent.name,
          }
        : (mountRouted ? mountTargetRef.current : targetRef.current);
      // ══ THERE IS NO LONGER A PICKER SHORT-CIRCUIT HERE, AND THERE MUST NOT BE ═══════════════
      // This used to ask `answersLivePicker` BEFORE building the payload and, on a true, send the
      // text UNPREFIXED with its attachments left staged. The reason was real at the time: a send
      // could become a KEYSTROKE, `attachedPayload` prefixes quoted temp paths, and every arm of
      // `matchAnswerToOption` is anchored — so `"/var/folders/…/shot.png" Yes` matched nothing and
      // came back `ambiguous-picker`. Holding the files was the honest half of that: a keystroke is
      // not a message that could carry a file, so spending them would cost the user the picking for
      // nothing.
      //
      // NO SEND FROM THIS BOX CAN BECOME A KEYSTROKE ON THE STRENGTH OF THIS TEXT, on any path:
      //   • UNADDRESSED — `routeMessage` never returns `agent` (see conciergeRouter's header: the
      //     "the agent on screen is waiting AND this looks like an answer" branch was deleted for
      //     typing users' concierge-directed answers into a build agent's terminal). So the message
      //     goes to Sparkle, which reads attachment paths off disk exactly as an agent does. The
      //     short-circuit therefore only ever fired on CONCIERGE-bound text, where it silently
      //     withheld the staged screenshot and had the brain answer a question about a picture it
      //     was never given — with the chips still on screen as the only clue (roborev 55033).
      //   • ADDRESSED — `deliver` passes `neverPickerAnswer` for every mention-decided dispatch, and
      //     the dispatcher REFUSES (`addressed-at-picker`) rather than pressing a button. An
      //     addressed message is a message; its agent is meant to receive the file paths.
      //   • REDIRECTED — the receipt's "Also ask <agent>" is the THIRD way this box reaches a live
      //     PTY, and the only one that may still take the keystroke path: a redirected bare "yes"
      //     SHOULD press the button. But a redirect of a message that carried files replays the
      //     prefixed payload, and `redirect` declares `neverPickerAnswer` for exactly that case
      //     (roborev 55309) — so the files never turn into a keystroke there either.
      //
      // So the lever protects nothing and costs attachments. Do not restore it on the addressed
      // path either: `answersLivePicker` reads the screen at SUBMIT and the dispatch re-reads it
      // after the countdown, so a picker that clears in between would land the addressed message as
      // an ordinary prompt — stripped of the very files the user attached for it. That is this same
      // bug, one path over.
      //
      // Take the staged files in the SAME tick the text leaves, so the next message starts clean
      // and a second Send can't deliver the same attachments twice.
      const staged = takeAttachments();
      // THREE renderings of one message, exactly as the removed composer built them:
      //   payload — the attachments' real paths prefixed to the text, for the PTY only;
      //   display — the typed text plus compact counts, for the thread AND every prompt-history
      //             surface (the pinned header, the history dropdown);
      //   text    — what the user actually typed, for naming, the ghost-text corpus, and what the
      //             ROUTER classifies. Empty on an attachments-only send.
      // The temp paths must never reach any of them but the first (roborev 46911/46925).
      // ══ THE STAGED QUOTE, TAKEN IN THE SAME TICK THE TEXT LEAVES ════════════════════════════════
      // Exactly like `takeAttachments()` above, and for the same reason: the next message must start
      // clean, and a second Send must not attach the same quote twice. `peek` reads through the
      // hook's ref rather than its state, because a founder who stages a quote and hits Enter in one
      // turn would otherwise send the PREVIOUS quote (or none).
      // THROUGH THE REF, not through `quoteApi` directly. The hook's returned object changes
      // identity whenever the staged quote changes, so closing over it would put `quoteApi` in this
      // callback's deps and give `send` a new identity on every stage — which propagates to
      // `sendFromComposer`, the controller, and a re-register of the box's submit seam, for a value
      // that is only ever read at the moment of a send. The ref keeps `send` as stable as it was.
      const stagedQuote = quoteRef.current?.peek() ?? null;
      quoteRef.current?.clear();
      // THE RESTORE IS BOUND TO **THIS** DRAFT, SNAPSHOTTED NOW (roborev 59801).
      //
      // `peek`/`clear` above run in the send tick, so reading them off the ref is equivalent to
      // closing over the object. The failure-restore is not: it runs after `deliver` settles, which
      // for a QUEUED send can be much later — and `restore` is a `useCallback` bound to `draftKey`.
      // Resolving it through the ref at settle time would write to whatever conversation is current
      // THEN, so patching the cable mid-flight and having that send refused would re-stage the quote
      // above a different thread, carrying a `sourceId` that would ride out with the next message
      // there. That is exactly the cross-draft leak `useConciergeQuote`'s header says a single slot
      // would cause. Capturing the bound function keeps the send-time binding without putting
      // `quoteApi` back into this callback's deps.
      const restoreQuote = quoteRef.current?.restore;
      // THE ONE PLACE the binding is captured, and it travels WITH this send from here on — down
      // through `deliver` into `restoreDraft`. Nothing about the quote lives in a shared slot, so a
      // second send arriving while this one is armed cannot redirect this one's restore.
      const sentQuote: SentQuote | null = restoreQuote
        ? { quote: stagedQuote, restore: restoreQuote }
        : null;
      // WHAT THE BRAIN READS gets the quote; the PTY copies do not.
      //
      // That split is structural rather than a policy check, and it is worth naming: `askSparkle`
      // is handed `payload`, while the terminal path builds its own string from `text`
      // (`mentionAim.payload`, below). So prefixing the quote here reaches the concierge — the
      // surface this feature is for — and cannot type a blockquote into a live Claude Code CLI.
      const payload = stagedQuote
        ? quotePrompt(stagedQuote, attachedPayload(text, staged))
        : attachedPayload(text, staged);
      const display = attachedDisplay(text, staged);
      // ══ AND A RENDERING THAT IS THE BUBBLE'S ALONE ══════════════════════════════════════════════
      // A long paste rides as a pill in the transcript instead of as forty rows of wall (the
      // founder's ask; see ConciergeUserMessage.collapsed). So the bubble shows what was TYPED
      // around the pastes and draws the pastes themselves as pills.
      //
      // IT IS A FIFTH RENDERING, NOT A NARROWING OF `display`, and the distinction is the whole
      // safety of this. `display` above still carries the entire body and still goes to `deliver`,
      // which is what every prompt-history surface shows and what a re-send replays — narrowing it
      // would have made the history dropdown hand back a message with the paste missing. `payload`
      // and `text` are untouched by construction: neither is built from anything below.
      const bubbleText = collapsed ? attachedDisplay(collapsed.typed, staged) : display;
      // A FOURTH rendering, and only when the message is addressed: the same thing with the `@…`
      // address taken off. It is a separate rendering rather than a change to `payload` because
      // `payload` still has to carry the address everywhere else — Sparkle answering the message
      // should see who it was aimed at, and a redirect replays it verbatim. Only the wire into the
      // named agent's own terminal drops it (see ConciergeMentionAim).
      //
      // Built from the resolved mentions rather than the whole roster, so it strips exactly the
      // spans that were recognised — no second, laxer notion of what a mention looks like.
      //
      // A MOUNT BUILDS THE SAME AIM. It has no address to strip, but it goes through the identical
      // `mentionFreeText` pass anyway and that is deliberate rather than incidental: a mounted
      // message can still carry a SUBJECT mention ("check what Kraken Auth did first"), and the `@`
      // on it must not reach the terminal for exactly the reason it must not on an addressed one —
      // the Claude Code CLI opens its file-reference autocomplete on a leading `@` and strands the
      // instruction behind a picker. `mentionFreeText` with no leading span drops sigils and keeps
      // every name, which is precisely what a mounted message wants.
      const mentionAim: ConciergeMentionAim | null =
        (addressedAgent || mountRouted) && submitted
          ? (() => {
              const wire = mentionFreeText(text, rosterFromMentions(mentions ?? []));
              return {
                // WHICH GESTURE CHOSE THIS TERMINAL, and the two are now the only two there are: the
                // user typed a name, or the cable is patched. An address is relayed THROUGH the
                // concierge so the conversation stays whole; a mount is the founder talking straight
                // to a build agent, where billing a brain turn per line is a tax rather than a
                // thought partner. The Improve-Sparkle surface used to take the ADDRESSED arm from a
                // mount it built itself (sparkle-0rf5); it takes the `mount` arm now, like every
                // other build row — see `addressedAgent` above for why that special case was removed.
                via: addressedAgent ? ("address" as const) : ("mount" as const),
                target: submitted,
                payload: attachedPayload(wire, staged),
                text: wire,
              };
            })()
          : null;
      // ══ A FIFTH: THE SAME STRIP, BUT FOR THE REDIRECT REPLAY ════════════════════════════════════
      // `mentionAim` above only exists when the address RESOLVED to a promptable agent, so it cannot
      // carry this: `@Sparkle` resolves to no agent at all, and its receipt is the one that ALWAYS
      // offers "Also ask <agent>" (the message always lands on Sparkle). That arm hands its string
      // straight to `promptAgent`, so it needs the same sigil-free wire on a path where `mentionAim`
      // is null. Keyed off `mentions` — the resolved spans — for the same reason `mentionAim` is.
      const wirePayload = mentions?.length
        ? attachedPayload(mentionFreeText(text, rosterFromMentions(mentions)), staged)
        : payload;
      // ══ AND WHETHER THERE IS ANYTHING LEFT TO REDIRECT ══════════════════════════════════════════
      // A BARE address strips to nothing: `mentionFreeText` deletes the addressing span whole, so a
      // dictated "@Sparkle" with no other words leaves `""`. The addressed path has said so since
      // roborev 55418 ("You've got <agent> in mind — what should I send over?"), but that guard is
      // reached only when the mention resolved to a promptable agent, and `@Sparkle` never does — so
      // the message went to Sparkle carrying a redirectable receipt whose replay was the empty
      // string. `redirect` then refused it at `if (!replay) return`, correctly (an empty prompt is a
      // bare newline into a live PTY, which at an open picker presses whatever row is selected) —
      // but SILENTLY, leaving the button mounted for a second tap that would do nothing either. That
      // is the dead-affordance failure this file's receipt rules exist against (roborev 55765).
      // Deciding it HERE makes the button absent rather than inert.
      const redirectable = wirePayload !== "";
      // SNAPSHOT the staged files onto the message itself, in the same tick they are taken. They are
      // gone from the view model a line later (`takeAttachments` above), so a bubble that read the
      // live list would show the picture for one frame and then go blank — which is the state the
      // column shipped in: the screenshot reached the model and left no trace the user could see
      // (PRD §8). `undefined` rather than `[]` for a file-less send, so the persisted thread doesn't
      // grow an empty array on every message.
      setChat((prev) => [
        ...prev,
        {
          id,
          kind: "you" as const,
          text: bubbleText,
          attachments: staged.length ? staged : undefined,
          // Snapshotted like the files and the mentions, and for the same reason: the pill is the
          // record of a paste that was sent, so it has to survive the compose box clearing. The
          // full text lives in the block — nothing here is a reference to something already gone.
          collapsed: collapsed?.blocks.length ? collapsed.blocks : undefined,
          // Snapshotted onto the message for the same reason the files are: this bubble is the
          // record of who the message went to, and resolving its pills against the live fleet later
          // would erase them the moment that agent was closed. ALL of them, not just the one that
          // was used — the user wrote those names and should see them back.
          mentions: mentions?.length ? mentions : undefined,
          // WHAT THIS MESSAGE WAS REPLYING TO, snapshotted onto the bubble like the files and the
          // mentions beside it — the founder asked for the quote to stay visible above his message
          // rather than vanish once sent. A `ReplyAnchor`, so `ReplyAnchorStubs` draws it with the
          // same left bar the concierge's own quoted originals use.
          //
          // The FACE, not the whole selection: the stub is one line by contract, and the full text
          // has already gone to the brain in `payload`.
          quoting: stagedQuote
            ? { id: stagedQuote.sourceId, quote: quoteFace(stagedQuote) }
            : undefined,
        },
      ]);
      // ══ THREE RENDERINGS REMEMBERED, ONE PER CONSUMER ═══════════════════════════════════════════
      // `redirect`'s "Also ask <agent>" hands its string to `promptAgent`, and that is the THIRD way
      // this box reaches a live terminal — the one that does not go through `mentionAim`. So the
      // `@…`-stripping the addressed path gets for free never applied to a replay, and any mentioned
      // message redirected into an agent typed the sigil verbatim into a Claude Code CLI, where a
      // leading `@` opens its file-reference autocomplete and strands the instruction behind a picker
      // the user never asked for (bead sparkle-kaz1l).
      //
      // `@Sparkle` was the sharp edge — it always falls to Sparkle, so its receipt always offers the
      // redirect — but the hazard was never specific to it: `@Kraken Auth` redirected to a different
      // agent carried its sigil too.
      //
      // WHICH REF EACH CONSUMER READS, because an earlier cut got this wrong in a way no test
      // caught: the strip was applied to `sentPayloadRef`, and the Sparkle-bound arm of `redirect`
      // reads THAT ref — not `sentTextRef` — so "Also ask Sparkle" started asking about a message
      // with the addressed agent's name deleted (roborev 55765). Stripped and unstripped are now
      // two separate recordings, each named for the wire it rides:
      //
      //   sentTextRef    → the DISPLAY copy. Bubble and `promptAgent`'s `display`/naming basis.
      //   sentPayloadRef → the BRAIN copy. `askSparkle(replay)`. Keeps names: they are content.
      //   sentWireRef    → the PTY copy. `promptAgent`'s prompt. Sigils stripped, or a redirect
      //                    types `@…` verbatim into a live CLI (bead sparkle-kaz1l).
      rememberSentText(sentTextRef.current, id, text);
      rememberSentText(sentPayloadRef.current, id, payload);
      rememberSentText(sentWireRef.current, id, wirePayload);
      // A REFUSED SEND HANDS THE QUOTE BACK, the way `restoreAttachments` hands back the files. The
      // box restores the typed words on `false`; without this the fragment he selected would be the
      // one part of the message that did not come back, and he would have to go find it again.
      //
      // THE COUNTDOWN PATHS DO NOT COME THROUGH HERE. `deliver` resolves TRUE the moment an intent is
      // armed, so a cancel or a post-countdown failure leaves `outcome === true` and restores through
      // `restoreDraft` instead. Both now write through the SAME send-time binding captured above, so
      // a path that somehow took both would write one slot twice rather than staging the quote in two
      // conversations — which is what the previous cut of this comment wrongly claimed was already
      // true (roborev 59803).
      const outcome = enqueue(
        () =>
          deliver(
            id,
            text,
            payload,
            display,
            submitted,
            staged,
            // `@Sparkle` forces the concierge route exactly as the capture window's Chat does. It is
            // deterministic and zero-cost: the user named the destination, so there is nothing for
            // the router to classify and no reason to spend a call on it. Critically this also stops
            // `submitted` — still the MOUNTED/selected agent, deliberately, because an explicit
            // address must not drop the mount — from being handed to `routeMessage` as a candidate.
            forceSparkle || conciergeAddressed,
            mentionAim,
            redirectable,
            sentQuote,
            submittedAt,
          ),
        false,
      );
      if (stagedQuote) void outcome.then((ok) => { if (!ok) restoreQuote?.(stagedQuote); });
      return outcome;
    },
    [deliver, enqueue, takeAttachments],
  );

  /** Send an already-routed message the OTHER way. Additive: the first delivery stands (see
   *  RoutingReceipt) — this adds a second one and records that both happened. */
  const redirect = useCallback(
    async (messageId: string) => {
      const text = sentTextRef.current.get(messageId);
      // EXISTENCE, not truthiness. An ATTACHMENTS-ONLY send is a real message — ComposeBox allows it
      // (`canSend` is text OR attachments) and `send` stores `""` for it — and it gets a redirectable
      // receipt, so the "Also ask <agent>" button is rendered for it. A falsy test returned before
      // anything dispatched, so that button did NOTHING: no send, no thread line, no receipt change,
      // and it stayed mounted so the user tapped it again. A silently dead affordance is exactly what
      // the receipt rules in this file are written against (roborev 55418). The rehydrated-thread case
      // this guard also used to cover is handled elsewhere — conciergeThreadStore clears
      // `redirectable` on a restored receipt.
      if (text === undefined) return;
      // TWO replays, because the two arms below want opposite things (roborev 55765). Both carry
      // attachment paths — the brain reads files from disk exactly as an agent does — and both fall
      // back to `text` for a message that carried none, where the renderings coincide anyway.
      //
      //   `replay`     → Sparkle. Keeps `@Name`: the names are content the user wrote, and asking
      //                  the brain about the message means asking about who it was aimed at.
      //   `wireReplay` → the agent's PTY. Sigils stripped, or the CLI's file picker eats it.
      const replay = sentPayloadRef.current.get(messageId) ?? text;
      const wireReplay = sentWireRef.current.get(messageId) ?? replay;
      // ══ GUARD ON WHAT ACTUALLY RIDES THE WIRE, NOT ON `text` ═════════════════════════════════
      // Widening the check above to an existence test (so an attachments-only send stops having a
      // dead button) also admitted `text === ""`, and `replay` falls back to it — so a remembered
      // empty string with no recorded payload would dispatch an EMPTY prompt, i.e. a bare newline
      // into the agent's terminal. At a live picker that presses whatever row is selected, which is
      // exactly the "press a button nobody read" hazard the `neverPickerAnswer` rule below exists to
      // close, arriving through the other door — and that flag cannot help, because it suppresses
      // option MATCHING, not the sending of a bare return (roborev 55448).
      //
      // The old falsy guard made this unrepresentable by accident. This one says it on purpose, and
      // about the right value: an attachments-only send has an empty `text` but a non-empty `replay`
      // (the quoted paths), so it still redirects, while a message with nothing to send at all does
      // not claim the receipt, write a thread line, or reach the PTY.
      //
      // HOW NARROW THIS IS, since the next reader will look for a test and not find one — the same
      // note `onFire`'s empty-box guard carries, for the same reason. `ComposeBox.canSend` is
      // `text || attachments`, so a send with neither never happens, and every send WITH attachments
      // records a payload. Reaching this line therefore needs a state the public surface cannot
      // produce: a remembered `""` with no payload beside it (attachments cleared or failed to
      // resolve between `send` and `attachedPayload`, or a future caller of `rememberSentText`).
      // A black-box row asserting "nothing dispatched" passes against the unguarded code too — it is
      // vacuous, and one was written and deleted rather than left here looking like cover. The guard
      // stays because what it prevents is a bare return into a live PTY, which no flag downstream
      // can take back: `neverPickerAnswer` suppresses option MATCHING, not the sending of a newline.
      //
      // BOTH renderings, because the arm that reaches a PTY reads `wireReplay`, and guarding only
      // `replay` would let a message that is non-empty ONLY because of its address ("@Kraken Auth",
      // which strips to "") through to `promptAgent` as a bare return. `send` already withholds
      // `redirectable` for exactly that message, so this is the second of two locks rather than the
      // only one — but they guard different things (the button's presence vs what it dispatches) and
      // a rehydrated receipt reaches this line without passing through `send` at all.
      if (!replay || !wireReplay) return;
      const current = chatRef.current.find((m) => m.id === messageId);
      const receipt = current?.kind === "you" ? current.receipt : undefined;
      if (!receipt || receipt.alsoSentTo) return;
      // Claim the redirect BEFORE awaiting. The dispatch relay is async and the button stays
      // mounted until the receipt updates, so without this a double-tap (or one impatient second
      // click on a slow relay) passed the alsoSentTo guard twice and wrote the same text into the
      // terminal twice — irreversible, and the receipt would still read as a single redirect.
      if (redirectingRef.current.has(messageId)) return;
      redirectingRef.current.add(messageId);
      try {
        if (receipt.target === "agent") {
          askSparkle(replay);
          setReceipt(messageId, { ...receipt, alsoSentTo: "sparkle", redirectable: false });
          return;
        }
        // Chat → agent. Deliver to the agent the BUTTON NAMED, not to whatever is selected now:
        // the label ("Also ask Kraken Auth") is an explicit promise, and the selection moves for
        // reasons unrelated to this thread. Sending elsewhere would be exactly the misdelivery the
        // removed pinned-aim guard existed to prevent (roborev 46284-M4), in the one place the UI
        // has committed to a destination in advance.
        const promised = receipt.agentId;
        const live = targetRef.current;
        const aim =
          promised && live?.agentId === promised
            ? live
            : promised && receipt.agentName
              ? { projectId: "", agentId: promised, name: receipt.agentName }
              : null;
        if (!aim || !agentStillExists(promised)) {
          // The receipt remembers BOTH halves, so the agent it promised stays clickable even now
          // that it is closed. Only a receipt missing one of them falls back to the bare words.
          const who =
            promised && receipt.agentName
              ? ref({ id: promised, name: receipt.agentName })
              : plain("That agent");
          postSparkle(line`${who} isn't open any more, so I couldn't pass the message along.`);
          return;
        }
        // ══ THE THIRD DOOR INTO A LIVE PTY, AND IT NEEDS THE SAME SCREEN GUARD (roborev 57358) ═════
        // This file already names it: "the receipt's 'Also ask <agent>' is the THIRD way this box
        // reaches a live terminal". The mounted-composer change gated the other two — at submit and
        // again after the countdown — and left this one open, which is the worse omission of the
        // three: `redirect` calls `promptAgent` DIRECTLY. There is no armed intent and no countdown,
        // so one tap dispatches irreversibly, with nothing to cancel.
        //
        // `neverPickerAnswer` below is NOT this guard. It stops the replay being matched against a
        // live picker's options; it says nothing about the alternate screen. So without this, a
        // receipt offering "Also ask Kraken Auth" while Kraken sits in `vim` pasted the replay AND
        // submitted it into normal mode, where the keys execute as editor commands.
        //
        // "address" SEMANTICS, deliberately: the redirect target is an agent the user NAMED (the
        // button's label is an explicit promise), and its pane may not be mounted in this window at
        // all — so an unreadable screen must not block it, exactly as it does not block an addressed
        // send. Only what the screen positively shows refuses.
        const redirectBlocked = terminalWriteBlocked(aim.agentId, "address");
        if (redirectBlocked) {
          // NO `alsoSentTo` IS RECORDED, so the button stays live: nothing was passed along, and a
          // receipt that read "then to Kraken Auth" over a refused write would be the same lie the
          // refusal exists to avoid. The user can leave `vim` and tap it again.
          postSparkle(terminalRefusalLine(asAgent(aim), redirectBlocked));
          return;
        }
        // Through the queue: a redirect clicked while a compose send is still routing must land
        // AFTER it, not jump ahead of an earlier message.
        //
        // No files are staged for a redirect — they rode the original send and were consumed
        // there — so nothing can be held or handed back, and `[]` is the honest argument.
        const ok = await enqueue(
          () =>
            // The user tapped redirect on this message's routing receipt. Authorized by that tap,
            // and named by the message it belongs to.
            promptAgent(
              aim,
              // THE STRIPPED ONE. This is the write into a live CLI (bead sparkle-kaz1l).
              wireReplay,
              { display: text, namingBasis: text },
              [],
              false,
              { kind: "redirect", receiptId: messageId },
              // ══ ALWAYS TRUE. A REDIRECT MAY NEVER PRESS A BUTTON ═══════════════════════════════
              // This started as "false, because a redirected bare yes should still answer a picker",
              // then grew a carve-out for attachment-carrying replays (roborev 55309). Both were
              // wrong in the same direction, and the general rule is simpler AND safer (roborev
              // 55418): a redirect is a REPLAY OF A COMPOSED MESSAGE, which is exactly the
              // disposition this flag asserts.
              //
              // What the carve-out left exposed: unlike an addressed send, which arms a visible,
              // cancellable intent, this path calls promptAgent DIRECTLY — one tap dispatches
              // irreversibly. And `matchAnswerToOption` resolves a bare number by 1-based ON-SCREEN
              // POSITION. So: Sparkle lists three options in chat, the user types "1", the router
              // sends it to Sparkle (it can no longer route at an agent), the receipt offers "Also
              // ask CI Hardening", they tap it to pass their choice along — and "1\r" selects the
              // FIRST ROW of CI Hardening's picker, a question they never read, whose options have
              // nothing to do with Sparkle's list. The button's own label promises to ASK, not to
              // press. That is the least recoverable thing this path can do, decided by the
              // matcher's opinion rather than by anyone's intent.
              //
              // Answering a picker from the concierge is still a feature — it just belongs to the
              // surface built for it (the suggestion/nudge card, which does not route through here
              // and carries the agent's actual on-screen options), not to a replay of a message the
              // user aimed somewhere else.
              true,
            ),
          false,
        );
        if (ok) setReceipt(messageId, { ...receipt, alsoSentTo: "agent", redirectable: false });
      } finally {
        redirectingRef.current.delete(messageId);
      }
    },
    [askSparkle, promptAgent, postSparkle, setReceipt, agentStillExists, enqueue],
  );

  /**
   * Every send the COMPOSE BOX initiates — which is both the button and an expired countdown.
   *
   * MANUAL SEND ALWAYS OVERRIDES (PRD §4c): a press is better information than the heuristic has,
   * so it cancels the countdown rather than racing it. The rail's own fire reaches the same submit,
   * hence the flag — without it the rail would cancel itself at the instant it fired.
   */
  const sendFromComposer = useCallback(
    (
      text: string,
      mentions?: ConciergeMention[],
      collapsed?: CollapsedSend,
    ): Promise<boolean> => {
      if (!autoFiringRef.current) notifyManualSend();
      return send(text, mentions, collapsed);
    },
    [send],
  );

  const controller = useMemo(
    () => ({
      onSend: sendFromComposer,
      onRedirect: (messageId: string) => void redirect(messageId),
      onAttach: attach,
      onRemoveAttachment: removeAttachment,
      onDismissAttachNotice: dismissAttachNotice,
      // "Quote in response": the thread reports the snapshot it took when the selection finished,
      // and staging it touches ONLY the quote slot — the founder's typed draft is untouched, which
      // is the behaviour he asked for (his hand-rolled version pastes above what he has written).
      onQuote: quoteApi.stage,
      onRemoveQuote: quoteApi.remove,
      onCopied,
      // PRD §3 (cross-project surfacing): clicking a nudge card "opens that project's tab,
      // switches to Build, and selects the referenced agent". openProjectTab does all three — the
      // tab select plus the shared reveal — so a nudge from a background project lands correctly.
      // A HEADER SEGMENT naming another project ("1 in mobile"). Switch the tab and stop there:
      // `openProjectTab` with no agent id selects nothing and mounts no PTY, which is the whole
      // contract. A count names a POPULATION, not an agent, so inventing one to reveal would be the
      // mirror image of the bug bead `sparkle-vohh` fixed — and this is that same shared path, not
      // a second switcher. What to do once you are there is column two's job; the digest lines in
      // the thread are what narrow it.
      // THE HEADER'S NEEDS-YOU PILL. `ConciergeColumn` has rendered this pill behind
      // `controller.onNeedsYouFilterToggle && …` since it was built, and nothing ever supplied the
      // handler — so the second conjunct was permanently `undefined` and the pill never mounted in
      // production, while its tests passed by injecting one (roborev 54769).
      //
      // It writes the SAME `statusFilter` the sidebar's chips write, via the store's own
      // `isolateStatusBand`/`showAllStatusBands`, so there is ONE filter state rather than two that
      // can disagree — the same mistake the mock made with a header pill and per-column chips
      // hiding rows through separate mechanisms, which is called out in rev4.html.
      onNeedsYouFilterToggle: () => {
        const ui = useUiStore.getState();
        // NARROWS TO BOTH ASKING BANDS, not to `needs_you` alone. `questions` means the agent cannot
        // proceed without you just as squarely as `waiting`/`approval` do — `engine/attention` has
        // always classified it that way — so isolating `needs_you` turned the blue band OFF and hid
        // owed work behind a control the founder reads as "show me what needs me". Same defect as
        // the digest click that hid the merge queue, entered through the newest band.
        if (isAskingIsolated(ui.statusFilter)) ui.showAllStatusBands();
        else ui.setStatusFilter({ needs_you: true, questions: true, running: false, done: false });
      },
      onProjectClick: (projectId: string) => openProjectTab(projectId),
      // Same destination as onNudgeClick, keyed on an id — the recap card's pills. `revealAgent`
      // reports through the column's one announcer, which is what lets those pills suppress the
      // live region they would otherwise each mount.
      onRevealAgent: (agentId: string) => revealAgentById(agentId),
      onNudgeClick: (n: ConciergeNudge) => {
        // THROUGH THE REPORTING PATH. The nudge card's pill also supplies `onOpen`, so it also
        // suppresses its own notice — a card whose agent closed under it used to swallow the click
        // entirely (roborev 56068). The card carries the name, so a vanished id can still be named.
        // Still `revealAgent` underneath, not a bare `openProjectTab`: a singleton nested-rowless
        // agent keeps a CARD, and its card click hits exactly the collapse/filter gates the digest
        // line's click had to learn about (roborev 53737).
        revealAgentById(n.id, n.agentName);
      },
      // The digest's whole purpose: hand off to column two instead of duplicating it.
      //
      // The founder's ask in full: "I just want Sparkle to be telling me that I have two agents that
      // need my attention. If I click on the two agents part of that text then it filters the build
      // column out to only show me the agents that need attention." Opening the project was only the
      // first half — without the second, you click "3 Need you" and still face the whole list.
      //
      // RE-DERIVED FROM THE LIVE FEED, not from the message that was rendered. A digest line can sit
      // on screen across several feed ticks, so the click has to ask what is true NOW: the group may
      // have shrunk, or its lead agent may have answered and resolved. `buildDigest` groups by
      // `project::band` and `ConciergeDigestGroup.id` is that key, so matching the clicked message's
      // id against the freshly-built groups both finds the live group and, by finding nothing, is how
      // a stale click declines to open a dead agent.
      onDigestClick: (d: ConciergeDigestMessage) => {
        // Re-derived from the population the line was BUILT from, so a stale rowless click can't be
        // answered by a row group that happens to share a project and band (their ids differ for
        // exactly this reason).
        const feed = feedRef.current;
        // THREE POPULATIONS, THREE RE-DERIVATIONS. A binary check sent an `unmerged` line down the
        // `rows` arm, where its id does not exist — so `live` was undefined and the click silently
        // did NOTHING, which is the dead-end affordance this whole bead started from.
        const live =
          d.variant === "rowless"
            ? buildDigest(nestedRowlessAgents(feed), "rowless").groups.find((g) => g.id === d.id)
            : d.variant === "unmerged"
              ? buildDigest(accountedUnmerged(feed), "unmerged").groups.find((g) => g.id === d.id)
              : buildDigest(surfacedAgents(feed)).groups.find((g) => g.id === d.id);
        if (!live) return; // resolved out from under the click — open nothing, change nothing
        // A DIGEST LINE REVEALS; IT NEVER NARROWS — either variant. That was always true of the
        // ROWLESS one for a mechanical reason: its agents have no row of their own, so
        // `isolateStatusBand` has nothing of theirs to leave standing, and it would hide the very row
        // the reveal needs — these are blocked workers under an orchestrator that bands `running`, so
        // isolating `needs_you` removes the head they pop out under. It is now true of the ROWS
        // variant too, for the founder's rule rather than a mechanism; see the block below the
        // numbered gates.
        //
        // But declining to SET a filter is not enough, and that was the bug (roborev 53734). The
        // line's promise is "click me and see these N", and TWO pieces of pre-existing UI state can
        // silently break it, both of them the default rather than an edge case:
        //
        //   1. COLLAPSE. `uiStore.isOrchestratorCollapsed` reads a missing entry as COLLAPSED, and
        //      no path opens a subtree on the app's own initiative — so on a fresh launch the head's
        //      subtree is shut. `openProjectTab` selects and mounts the lead but never expands, so
        //      the click gave you a terminal pane above ZERO worker rows.
        //      (This used to also cite `expandOnWorkerAttention` skipping first sighting, and to
        //      warn that marking these reveals "auto" would let auto-collapse fold them away. Both
        //      mechanisms are gone: `setOrchestratorsCollapsed` is the single writer, there is no
        //      auto/manual distinction left to mark, and nothing revokes an expansion.)
        //
        //      WHICH HEADS THIS CALL IS ACTUALLY LOAD-BEARING FOR — the non-lead ones. Several
        //      user-initiated reveals still expand: `revealAgent` above, the selection-reveal effect
        //      in AgentSidebar, the head-row and expand-all gestures, and the concierge
        //      `sidebarView` tools. The AgentSidebar one overlaps this call for the LEAD, because
        //      `openProjectTab(live.projectId, live.leadAgentId)` below selects the lead worker and
        //      that effect expands the selected row's parent. So the lead's head would open without
        //      this line; every OTHER head the digest line names would not.
        //   2. A LEFTOVER BAND FILTER. The sidebar applies `statusFilter` to heads, so a `running`
        //      orchestrator is not drawn at all if `running` is off. A *rows*-variant digest click
        //      used to be the commonest way that happened; it no longer narrows anything, and the
        //      remaining writers are the ones a reader can SEE — the filter chips, the needs-you
        //      pill, and the concierge `sidebarView` tools. Within a session that is still a filter
        //      to clear, which is why this call stays unconditional. Across sessions it is not:
        //      `statusFilter` is in `uiStore.TRANSIENT_UI_KEYS`, so a launch starts all-on.
        //
        // So the click ENFORCES its premise rather than assuming it: show every band, then expand
        // EVERY head the line names. `rowHeadIds` is a list because grouping stays `project::band`
        // — keying it per head instead was tried and reverted, since that fragments the common
        // fleet shape into a card apiece and rebuilds the wall (roborev 53737). One line may span
        // several orchestrators; expanding only the lead's would strand the rest.
        //
        // BOTH VARIANTS DO THE SAME THING NOW, AND THE ROWS ONE USED TO DO THE OPPOSITE.
        //
        // It called `isolateStatusBand(live.band)`, which sets `running:false, done:false`. Every
        // "Needs merge" row lives in `done` (engine/buildSections bands `unmerged` there), so
        // clicking "3 Need you in web" — an affordance whose whole purpose is to help the founder SEE
        // more — concealed the entire merge queue in one click, plus every `running` orchestrator
        // head whose red workers pop out underneath it. And `statusFilter` was persisted, so the
        // concealment outlived the session: a filter he never knowingly set, still hiding work he
        // owed, on a launch with no memory of the click. Against the rule this branch exists to
        // enforce (bead sparkle-qogah.4): "We should never hide a row that needs action from me."
        //
        // So the click REVEALS and never narrows. Widening is not merely safe here, it is what makes
        // the reveal land: the row `openProjectTab` selects is only drawn if its band is on, and an
        // inherited filter from a chip, the needs-you pill or a concierge tool may have it off. The
        // narrowing half of the founder's original ask ("filters the build column out to only show
        // me the agents that need attention") stays available where it reads as a filter and says so
        // on screen — the needs-you pill, which renders its own isolated state and toggles back —
        // rather than on a sentence in the thread that reads as "take me to these".
        const ui = useUiStore.getState();
        // ORDER IS LOAD-BEARING, the other way round from the narrowing version this replaced: show
        // every band FIRST, so the row the selection lands on is already drawable.
        ui.showAllStatusBands();
        // EVERY head the line stands for, not just the lead's: one line can span several
        // in-motion orchestrators, and expanding one of them would strand the rest (roborev
        // 53737). `expandOrchestrators` takes an array for exactly this. A `rows` line's members
        // are heads themselves, so its `rowHeadIds` is empty and this is a no-op there — passed
        // unconditionally so the two variants cannot drift into two behaviours again.
        ui.expandOrchestrators(live.rowHeadIds);
        openProjectTab(live.projectId, live.leadAgentId);
      },
      onNudgeAction: (n: ConciergeNudge, actionId: string) => {
        // [x] ON A RESOLVED CARD IS A DIFFERENT GESTURE, and it is handled BEFORE `resolveAgent`
        // deliberately. On a live card [x] is the app's per-EPISODE acknowledgement, which
        // de-escalates a red that is still standing; a finished episode has nothing left to
        // acknowledge, so the only thing left for the control to mean is "take this out of my
        // history". Routing it into `dismissAlert` instead would write a dismissal against an alert
        // record whose episode has already closed — seeding the NEXT red as pre-dismissed, which is
        // how a genuinely new blocker would come up already silenced.
        // CLEAR AN ACKNOWLEDGED CHIP. The one gesture that takes a blocker off the pinned strip on
        // purpose, and it is deliberately NOT `[x]` — see the acknowledgement below. Nothing else
        // happens: the agent's alarm was already acknowledged when the chip was created.
        if (actionId === PINNED_CLEAR_ACTION) {
          setAcknowledged((prev) => prev.filter((a) => a.id !== n.id));
          return;
        }
        // ACKNOWLEDGING A PINNED BLOCKER LEAVES A CHIP BEHIND. Recorded BEFORE the dismissal runs,
        // because the dismissal is what makes `n` un-derivable: it de-escalates the published band,
        // so by the next tick there is no live nudge left to snapshot. Without this the founder's
        // "never vanishes" is broken by the very control he asked to keep.
        if (!n.resolved && actionId === NUDGE_DISMISS_ACTION) {
          setAcknowledged((prev) => (prev.some((a) => a.id === n.id) ? prev : [...prev, n]));
          // Falls THROUGH on purpose — the acknowledgement itself still has to happen below.
        }
        if (n.resolved && actionId === NUDGE_DISMISS_ACTION) {
          forgetResolved(windowResolvedLedger(), n.id);
          // The ledger is module state, so removing the record changes nothing React can see. The
          // view model is keyed on `feed`, and a feed tick may be seconds away — without this bump
          // the card the reader just dismissed sits there until something unrelated moves.
          setResolvedRev((r) => r + 1);
          return;
        }
        const a = resolveAgent(n.id);
        if (!a) return;
        if (actionId === "approve") {
          void approve(a);
        } else if (actionId === NUDGE_OPEN_ACTION) {
          // A cloud agent's approval has to be given where the question is — the same destination
          // the card's own click and the refusal copy both point at, so the button is not a third
          // behaviour, just the one that is reachable in a single tap.
          revealAgentById(a.id, a.name);
        } else if (actionId === NUDGE_MUTE_ACTION) {
          useSparklePrefsStore.getState().setInterruptPreference(a.id, "mute");
        } else if (actionId === NUDGE_DISMISS_ACTION) {
          // THE [x]. The app's existing per-EPISODE acknowledgement, not a mute and not a local
          // "hide this card" flag — those are the two things it must not be:
          //   • A local flag would have to live somewhere, and this card is DERIVED from the feed
          //     on every tick (there is no card record to mark), so it would mean inventing a
          //     parallel dismissed-set that nothing else in the app can see or clear.
          //   • `dismissAlert` is already in this feed's own status chain (`withDismissedAlerts`,
          //     inside publishedStatusFor), so the acknowledgement de-escalates the red and the
          //     card retracts on the very next tick — the same mechanism, and the same record, the
          //     Build column's row control writes. Dismissing here calms the row there, which is
          //     what a reader who acknowledged an alarm expects and would otherwise have to do
          //     twice.
          // ACKNOWLEDGE WHAT THE CARD STOOD FOR, not only the agent it names (roborev 55986).
          //
          // On the rollup shape this design deliberately keeps — an IDLE orchestrator carrying a red
          // worker's band — the card names the orchestrator. Dismissing only that de-escalates its
          // red, which makes the worker un-represented, so the very next tick raises a new,
          // near-identical card naming the worker. The reader who reflexively acknowledged one alarm
          // gets it straight back under a different name, and has to click [x] once per red
          // descendant. That is whack-a-mole, and it is worse than the alarm.
          //
          // `representedBy` is the feed's own answer to "who speaks for me", so this dismisses the
          // exact set the card was standing in for — no parent walk re-derived here, and nothing
          // dismissed that some OTHER row still speaks for.
          const store = useProjectStore.getState();
          // `getState()` rather than a subscribed selector, matching this file's other store writes
          // from handlers: the action's identity is stable, and subscribing would add a dep to the
          // controller memo that re-creates every callback on any project write.
          // `a.status` is the PUBLISHED status the card was raised on, which is what
          // `advanceAlertRecord` has to see for the dismissal to match THIS episode rather than
          // seeding a different one. Same for each descendant, which carries its own.
          // THE TRANSITIVE CLOSURE, not one hop (roborev 56000). `representedBy` names the NEAREST
          // ancestor that speaks for an agent, so on `orch (idle) → mid (waiting) → leaf (waiting)`
          // the leaf points at `mid`, not at `orch`. Dismissing only the direct representees left
          // the leaf red with both its ancestors' alarms now suppressed — so nothing spoke for it,
          // and the next tick raised a fresh card naming it. That is the same whack-a-mole one
          // nesting level down, and multi-level nesting is a supported shape.
          //
          // Swept to a fixed point rather than recursed, and bounded by the agent count, so a cycle
          // in the persisted `parentId` chain cannot spin here — the same defensive posture
          // `conciergeFeed.representedBy` takes with its `seen` set.
          const fleet = allAgents(feedRef.current);
          const spokenFor = new Set<string>([a.id]);
          for (let pass = 0; pass < fleet.length; pass++) {
            let grew = false;
            for (const other of fleet) {
              if (
                other.representedBy !== null &&
                spokenFor.has(other.representedBy) &&
                !spokenFor.has(other.id)
              ) {
                spokenFor.add(other.id);
                grew = true;
              }
            }
            if (!grew) break;
          }
          // CLOSE THE EPISODE WITHOUT A RECEIPT — before the dismissals, so no tick can land in
          // between (roborev, 2026-08-07). An acknowledged red is NOT a resolved one: `dismissAlert`
          // de-escalates the PUBLISHED status (`withDismissedAlerts` in the chain above) while the
          // agent goes on waiting, so the resolution pass below — which reads exactly that published
          // band — would see the agent leave `needs_you` and mint a grey "RESOLVED after 4s:" card
          // for an agent that is still stopped dead waiting for the reader. That is a live blocker
          // rendered as history, the one thing this feature may not do, and it would also turn [x]
          // into two clicks: one to acknowledge, one to clear the receipt.
          //
          // The SAME set that gets dismissed, for the same reason it is the transitive closure: a
          // descendant whose alarm is being acknowledged here must not leave a receipt either.
          const ledger = windowResolvedLedger();
          for (const id of spokenFor) forgetEpisode(ledger, id);
          for (const agent of fleet) {
            if (spokenFor.has(agent.id)) {
              store.dismissAlert(agent.projectId, agent.id, agent.status);
            }
          }
        }
      },
    }),
    // `play` is absent on purpose: voice OUTPUT (TTS) was removed in §5, so main's `play` dep does
    // not survive the merge. `revealAgentById` is what the card surfaces call now — it wraps
    // `resolveAgent` + `revealAgent` and adds the reporting they were missing — so it is the
    // identity this memo has to track.
    [
      // Both are `useCallback`s off the quote hook, so they are as stable as the rest of this list —
      // named individually rather than as `quoteApi` so the memo does not re-run whenever the staged
      // quote CHANGES, which is every keystroke-free stage and would churn every memoised row.
      quoteApi.stage,
      quoteApi.remove,
      resolveAgent,
      revealAgentById,
      approve,
      sendFromComposer,
      redirect,
      attach,
      removeAttachment,
      dismissAttachNotice,
      onCopied,
    ],
  );

  const pinnedProjectName = useMemo(() => {
    if (!feed.pinnedProjectId) return undefined;
    return feed.projects.find((p) => p.id === feed.pinnedProjectId)?.name;
  }, [feed]);

  // Which project the workspace is looking at — the one the header calls "here". Column TWO is
  // scoped to it; column one is the global index, so the header names the others (PRD §2a).
  const currentProjectId = useCurrentProjectId();

  // The header's per-project split, straight off the feed's own per-project share of the number the
  // line states. Summing `scopedCounts.needs_you` over these projects reproduces
  // `feed.scopedCounts.needs_you` exactly (services/conciergeFeed), which is what lets the split be
  // rendered without the header's total drifting from what the thread accounts for.
  const needsYouByProject = useMemo(
    () =>
      feed.projects
        .filter((p) => p.scopedCounts.needs_you > 0)
        .map((p) => ({
          projectId: p.id,
          projectName: p.name,
          needsYou: p.scopedCounts.needs_you,
          isActive: p.id === currentProjectId,
        })),
    [feed, currentProjectId],
  );

  // Sends that are armed and counting down (services/dispatchIntent). A module-level registry
  // rather than component state on purpose: an intent must outlive any one render and must not be
  // lost if this host re-mounts mid-countdown, which would strand a timer with no way to cancel it.
  // `armedIntents` returns a snapshot with STABLE identity between mutations — a fresh array per
  // call would make useSyncExternalStore re-render forever.
  const pendingIntents = useSyncExternalStore(subscribeIntents, armedIntents, armedIntents);

  // NOTE (bead sparkle-y4ft): `messages` below gets a fresh ARRAY IDENTITY on every feed tick —
  // this memo is keyed on `feed`, which changes whenever any agent's status or a scoped count
  // moves, and clicking an item ticks the feed. ConciergeThread must therefore never treat a new
  // `messages` reference as "the thread changed"; it keys auto-follow on message count + last id +
  // last length for exactly this reason. An identity-keyed consumer scrolls the column out from
  // under the reader.
  // The pill's PRESSED state, read from the same store its toggle writes. Subscribed (not
  // `getState()`) so the pill re-renders when the sidebar's chips change the filter — one state,
  // reflected in both places, rather than a header control that can disagree with the column.
  const needsYouIsolated = useUiStore((s) => isAskingIsolated(s.statusFilter));

  // ── WHAT GITHUB SAID, so "N need merge" can say how many of those N actually can ────────────────
  //
  // Written by `OpenPrMenu` (the app's one pull-request probe, mounted in this column's own header
  // via `ConciergePrChip`); see `stores/prReadinessStore` for why it travels as a store.
  //
  // TWO SUBSCRIPTIONS, NOT ONE OBJECT SELECTOR. zustand compares a selector's result by identity, so
  // `(s) => ({ probed: …, ready: … })` mints a new object every call and re-renders this host on
  // every unrelated store write. Each field is a stable array reference between publishes, and the
  // publish itself is dropped when nothing changed (`sameSnapshot`), so this host repaints only when
  // the readiness answer really moved.
  const probedProjectIds = usePrReadinessStore((s) => s.probedProjectIds);
  const readyAgentIds = usePrReadinessStore((s) => s.readyAgentIds);
  const prReadiness: DigestReadiness = useMemo(() => {
    const probed = new Set(probedProjectIds);
    const ready = new Set(readyAgentIds);
    return { probed: (id) => probed.has(id), agentReady: (id) => ready.has(id) };
  }, [probedProjectIds, readyAgentIds]);

  const model: ConciergeViewModel = useMemo(() => {
    // DIGEST, don't enumerate (bead sparkle-4562.4). One item of a priority keeps its card; two or
    // more become a single line. Without this, eight P0s and nineteen P1s meant twenty-seven cards
    // stacked above the compose box — the chat pushed off screen, and column one reduced to an
    // unreadable copy of column two.
    const { cards, groups } = buildDigest(surfacedAgents(feed));
    // Rowless agents go through the SAME rule, as the `rowless` variant — one card each is how the
    // wall came back (a fleet with several blocked workers under absent or in-motion orchestrators
    // is several cards). What their line may not do is state a ROW count or filter a column that
    // has no rows to leave standing; that is the variant's job, not an exemption from digesting.
    // See `unrepresentedAgents` and services/conciergeDigest.DigestVariant.
    const rowless = buildDigest(nestedRowlessAgents(feed), "rowless");
    // FOUNDER'S RULING (bead sparkle-qogah, 2026-08-05): un-landed work is an action he owes, so it
    // may NOT be omitted from this column — but it is 27 agents on the reported fleet, so it is ONE
    // grouped line carrying a TRUE count, never 27 cards. Asked directly, he chose exactly that:
    // "one honest group — one row reading '27 need merge' that expands in place". Excluding it is
    // what let the column report "0 Need you" over 27 un-landed PRs.
    // AND IT CARRIES THE READINESS SPLIT (bead `sparkle-mf501`). The count above is a git fact —
    // agents whose commits are not on `main` — and on its own it promised four merges where GitHub
    // would allow none. `prReadiness` is what lets the line state the actionable half beside the
    // outstanding one instead of hiding the red work, which the ruling above forbids.
    const unmerged = buildDigest(accountedUnmerged(feed), "unmerged", prReadiness);
    // Never digested — every one of these keeps its own card, because its card is the only way to
    // reach it. See `strandedAgents`.
    // `unmerged.cards` IS DELIBERATELY NOT SPREAD HERE. buildDigest never emits one for this variant
    // (see its singleton branch): un-landed work surfaces only as a LINE, never as an interrupting
    // card carrying Approve/Open affordances that do not apply to it.
    //
    // AND IT MUST NOT BE SPREAD INTO `cardAgents` EITHER. That list is what opens a resolved-card
    // episode below, so adding un-landed work here would give every un-landed agent a grey
    // "RESOLVED after …" card the moment its PR merged — a receipt for something that was never an
    // alarm.
    const cardAgents = [...cards, ...rowless.cards, ...strandedAgents(feed)];
    const nudges = cardAgents.map(agentToNudge);
    // ── RESOLVED CARDS ──────────────────────────────────────────────────────────────────────────
    // A card whose agent has left the red band does not vanish; it stays here, greyed, saying how
    // long the block lasted (founder 2026-08-06, bead `sparkle-9adzg`). See `engine/resolvedNudges`
    // for why this needs a ledger at all — the live set above is derived, so the moment an agent
    // stops being red it stops being derivable, and a card nobody remembered is a card that is gone.
    //
    // THE RED SET IS THE BAND, NEVER `cardAgents`. Two agents sharing a band collapse into a digest
    // LINE, which withdraws their individual cards while both are still blocked; resolving on card
    // absence would grey a live blocker, which is the one thing this must never do.
    // READ, not merely listed as a dependency. `resolvedRev` is the repaint signal for the one write
    // to the resolved ledger that does not come with a feed tick ([x] on a resolved card) — the
    // ledger is module state, so the removal changes nothing React can see. Its VALUE is meaningless;
    // its CHANGE is the whole signal. Referencing it here makes it a genuine dependency instead of
    // one `react-hooks/exhaustive-deps` reports as unnecessary — which mattered concretely: the
    // package lints at `--max-warnings 12` and that warning was the 13th, so it failed CI.
    void resolvedRev;
    const now = Date.now();
    const everyone = allAgents(feed);
    const stillRed = new Set(everyone.filter((a) => a.band === "needs_you").map((a) => a.id));
    const known = new Set(everyone.map((a) => a.id));
    const ledger = windowResolvedLedger();
    // A resolved card going LOUD again is a new event, and it is the one re-slot the arrival ledger
    // cannot infer: the card never left the stream, so its absence timer never started. Without this
    // the re-raised red renders at its original slot — for a long thread, far above the fold.
    for (const a of cardAgents) if (ledger.resolved.has(a.id)) forgetArrival(arrivalRef.current, a.id);
    // AN ACKNOWLEDGED AGENT OPENS NO EPISODE, so it can never earn a "RESOLVED after …" receipt.
    // That is the rule the live [x] already established (an acknowledged red is not a resolved one),
    // and it has to be enforced HERE as well as in the handler, because acknowledging now sets React
    // state: that re-render arrives while the feed still reports the agent red, so the handler's
    // `forgetEpisode` would be undone by a `noteCardsShown` running one render later on stale data,
    // and the next real tick would mint exactly the false receipt the earlier fix removed.
    //
    // CONSERVATIVE IN THE SAFE DIRECTION. An acknowledged agent that genuinely blocks AGAIN goes
    // loud again — that is the feed's own re-alert, and this filter does not touch it — but it earns
    // no receipt for that second episode until the chip is cleared. A missing receipt is a gap in
    // history; a false one is a wrong statement about a live agent. Only one of those is acceptable.
    const acknowledgedIds = new Set(acknowledged.map((a) => a.id));
    noteCardsShown(
      ledger,
      cardAgents.filter((a) => !acknowledgedIds.has(a.id)),
      now,
    );
    noteResolutions(ledger, stillRed, known, (id) => everyone.find((a) => a.id === id), now);
    const live = new Set(nudges.map((n) => n.id));
    // THE READER ASKED NOT TO HEAR ABOUT THESE — so they are HIDDEN, not deleted (roborev 59945-M2).
    //
    // `muted` and out-of-scope are the other two gates `accountedNeedsYou` applies, and both withdraw
    // a LIVE card while the agent is still red; without this the later unblock would put the silenced
    // agent back in the thread as a grey card, through the very control the card offers to silence it
    // with. But BOTH ARE CURRENT-VIEW FACTS, so acting on them by destroying ledger state was wrong in
    // a way that only shows up later: `inScope` is just "this project is pinned right now", so a pin
    // held for a minute would irreversibly erase every receipt already earned in every other project,
    // and — worse — drop the OPEN episode of a still-red agent there, so on unpin its raise restamps
    // to `now` and the eventual card reports a fraction of the real block. The duration is the entire
    // reason the founder chose "keep it, greyed" over "delete it". `muted` has the same shape: it is
    // re-derived each tick from `conciergeTopics(a.id, status)` and a mute can carry an `expiresAt`.
    //
    // A filter is the whole fix: the ledger keeps the truth, and the view shows what the reader has
    // asked to see. Unpin or unmute and the receipt is there, with its real duration.
    const eligible = new Map(everyone.map((a) => [a.id, a.inScope && !a.muted]));
    const resolved: ConciergeNudge[] = resolvedNudges(ledger)
      // Defensive: `noteCardsShown` already drops a resolved record the moment its agent goes live,
      // so this cannot fire today. It stays because the failure it prevents is a DUPLICATE REACT KEY
      // — two cards with one agent id — which React reports as a warning and then renders wrongly,
      // rather than as the loud contradiction (one agent, red here and grey there) that it is.
      .filter((r) => !live.has(r.id))
      .filter((r) => eligible.get(r.id) === true)
      .map((r) => ({
        id: r.id,
        kind: "nudge" as const,
        band: r.band,
        projectName: r.projectName,
        agentName: r.agentName,
        // No prose and no actions: the card draws neither (see NudgeCard), and every action is a
        // thing to do about a LIVE block.
        text: "",
        actions: [],
        resolved: { raisedAt: r.raisedAt, resolvedAt: r.resolvedAt },
      }));
    const digests: ConciergeMessage[] = [...groups, ...rowless.groups, ...unmerged.groups].map(
      (g) => ({
        id: g.id,
        kind: "digest" as const,
        band: g.band,
        variant: g.variant,
        text: g.text,
        leadAgentId: g.leadAgentId,
        memberIds: g.memberIds,
      }),
    );
    // ── LIVE BLOCKERS LEAVE THE TRANSCRIPT ──────────────────────────────────────────────────────
    // Founder, 2026-08-07: *"I want any sort of blocked notices to be right above the compose
    // window. And not in line in the chat thread… they should stay persistently above the composed
    // window so that I see them regardless of how much the chat thread moves."*
    //
    // THE SPLIT IS BY KIND OF FACT, not by kind of item. A chat message is immutable history at a
    // fixed position; a live blocker is neither, so inline gave it both wrong properties at once —
    // it went stale AND it scrolled away. `engine/resolvedNudges` fixed the staleness half; this is
    // the visibility half. So `nudges` (LIVE) is pinned above the composer and is deliberately
    // absent from the stream below, while `resolved` (a finished episode, which IS history) stays
    // in the transcript exactly where it was.
    //
    // NOT ALSO IN THE STREAM. Rendering both would put one agent's blocker on screen twice, and the
    // scrolling copy is the one that goes stale — the precise bug this move exists to end.
    const pinnedBlockers = nudges;
    // ACKNOWLEDGED CHIPS. This filter DISPLAYS; it never ends an acknowledgement — and that split is
    // the whole design, so it is stated once, here (roborev 60332-M2 caught an older version of this
    // block still asserting the opposite twenty lines above the code):
    //
    //   • RENDER (this filter) hides a chip — for mute/scope, and for `working`. Every one of those
    //     is reversible or momentary, and hiding is all a render may do.
    //   • THE EFFECT (see `setAcknowledged` above) RELEASES the record, and only on "surfaced
    //     again". That is what ends the `acknowledgedIds` suppression, which a display filter cannot
    //     express at all — the lesson of roborev 60209, where a chip filtered away at render left
    //     the suppression standing with nothing left to clear it.
    //
    // Neither half can do the other's job: release alone leaves a chip up while the agent is visibly
    // working (roborev 60158-H1), and display alone suppresses receipts forever (60209).
    const liveAcknowledged = acknowledged
      .filter((a) => {
        // MUTE AND SCOPE are current-view facts, so they HIDE (roborev 59945-M2 established this
        // for the receipts) — unmute or unpin and the chip is back.
        if (eligible.get(a.id) !== true) return false;
        // AND THE CHIP STANDS DOWN once the agent is visibly getting on with something (roborev
        // 60158-H1). Display only — see the split above.
        // A DENYLIST ON `working`, not an allowlist of the two de-escalated statuses (roborev
        // 60249-M2). `withDismissedAlerts` only guarantees `idle`/`stopped` while the acknowledged
        // red still STANDS; every other status the agent can go on to publish — `done`, `unmerged`,
        // `new`, `questions`, `lapsed` — is neither `needs_you` (so the record is not released) nor
        // in an allowlist (so the chip is hidden). The blocker would then leave no trace at all: no
        // chip, no receipt, and nothing to clear. Hiding only on `working` is the rule this filter
        // has claimed all along.
        const now = everyone.find((x) => x.id === a.id);
        return now !== undefined && now.status !== "working";
      });
    // Order the whole stream by WHEN EACH ITEM FIRST APPEARED, not by what kind it is. Concatenated
    // as [chat, digests] only to tie-break items that arrive in the SAME tick; anything already
    // placed keeps its slot (see engine/conciergeStreamOrder for why assign-once matters).
    // `resolved` last in the concatenation, so that if a card resolves in the SAME tick a chat
    // message or a digest first appears, the tie-break puts the finished thing under the new one.
    const stream = orderByArrival(arrivalRef.current, [...chat, ...digests, ...resolved]);
    return {
      scope: { pinnedProjectName },
      vitals: feed.scopedCounts,
      needsYouByProject,
      // In arrival order. This used to be `[...chat, ...digests, ...nudges]`, which pinned every
      // notice below the entire conversation no matter when it arrived — so the digests read as
      // stuck to the bottom of the pane rather than as part of the thread.
      messages: stream,
      // PINNED, not threaded — see the split above. Absent from `messages` by construction.
      pinnedBlockers,
      acknowledgedBlockers: liveAcknowledged,
      typing,
      attachments,
      quote: quoteApi.quote,
      dropActive,
      attachNotice,
      needsYouFilter: needsYouIsolated,
    };
  }, [
    // The staged quote is part of the view model, so the model must rebuild when it changes —
    // otherwise the chip would not appear until some other input happened to invalidate this memo.
    quoteApi.quote,
    feed,
    chat,
    typing,
    pinnedProjectName,
    needsYouByProject,
    attachments,
    dropActive,
    attachNotice,
    needsYouIsolated,
    // Not read in the body — it is the repaint signal for the resolved-card ledger's one
    // out-of-band write ([x] on a resolved card). See `resolvedRev`.
    resolvedRev,
    // Read in the body (it ships in the view model), so acknowledging repaints the strip on the
    // same tick the reader clicks rather than at the next feed tick.
    acknowledged,
    // The "N need merge · M ready" split. Its own dependency because the PR probe answers on a
    // three-minute poll of its own: without this, a line built before the probe landed would keep
    // saying nothing about readiness until some unrelated input happened to invalidate this memo.
    prReadiness,
  ]);

  /**
   * The per-message status map — what the concierge is doing about the specific message it is
   * working on, rendered under that bubble rather than only at the foot of the column.
   *
   * DELIBERATELY OUTSIDE the view-model memo above. That memo is keyed on the agent feed and
   * already rebuilds several times a second; folding a store subscription into it would make every
   * tool call rebuild the entire message list, and the thread's rows are memoised precisely to keep
   * that from happening (see ConciergeMessageRow's header on drag-selection stutter). Composed here
   * and merged into the model as its own field, so only the map's identity changes when the status
   * moves.
   */
  const messageStatuses = useConciergeMessageStatuses(awaitingId, typing, turnFloor, turnQueue);
  const modelWithStatuses: ConciergeViewModel = useMemo(
    () => ({ ...model, statuses: messageStatuses, turnFloor }),
    [model, messageStatuses, turnFloor],
  );

  return (
    <>
      {/* Renders nothing; speaks the liveness colour through the column's one announcer, and keeps
          that feature's 1 Hz ticker out of this host's render. See the component. */}
      <LivenessAnnouncer announce={announce} />
      <ConciergeColumn
        model={modelWithStatuses}
        controller={controller}
        width={width}
        // THE CABLE. `ConciergeColumn` has carried the flood and the lift since the cockpit landed,
        // keyed off this prop — and NOTHING PASSED IT, so it defaulted to "off" and both treatments
        // were dead code. Wiring an agent changed the shell root's `data-wired` and the two CSS
        // seam rules, and the column itself never learned: no flood, no shadow, no drop to flush.
        // Read from the store here rather than threaded down from Workspace because this host is
        // where the column's other live state already comes from, and `engine/cable` is the one
        // holder of the value (MAPPING.md: `data-wired` must not become scattered component state).
        wired={wired}
        mountedAgent={mountedAgent}
        routableMountedAgentId={routableMountedAgentId}
        mountedNotice={mountedNotice}
        searchSlot={searchSlot}
        prSlot={<ConciergePrChip />}
        // Armed sends, each cancellable, directly above the box. `cancelIntent` runs the arm site's
        // own onCancel (which restores the files and posts to the thread), so the controller here
        // has nothing to remember — see services/dispatchIntent.
        // Concierge tool calls stopped on the human's yes or no. Self-contained on purpose: it
        // subscribes to the pending-approval ledger and writes the answer straight back, so this
        // host has nothing to remember — same arrangement as the countdown below.
        approvalSlot={<ConciergeApprovals />}
        countdownSlot={
          <CountdownBanner
            intents={pendingIntents}
            onCancel={cancelIntent}
            onConfirm={confirmIntent}
          />
        }
        interim={dictation.interim}
        registerInsert={registerInsert}
        onTextEdit={onTextEdit}
        announcement={announcement}
        copyOnSelection={copyOnSelection}
        // The "@" picker's list, and the roster a typed mention resolves against — relevance-
        // ordered, because that order is what breaks a duplicate-name tie (see the memo).
        //
        // THESE TWO PROPS ARE ALSO THE RAIL'S INPUTS. `railTargetName` runs `mentionRoster` over
        // exactly this pair so the label it draws and the agent this box resolves at submit cannot
        // be two different answers. Change one, change the other.
        mentionAgents={mentionAgents}
        preferredAgentId={routingTarget?.agentId ?? null}
        // ── THE SEND TRAY (PRD §4) ───────────────────────────────────────────────────────────
        // The countdown model is DATA, not a slot, and carries no live region of its own: the arm
        // and fire lines go through `announcement` above like everything else in this column.
        autoSend={autoSendRail}
        sendMode={sendTray.mode}
        onSendModeChange={sendTray.setMode}
        // THE AUTO-SEND TOGGLE, from the same hook that owns the position — so the switch the user
        // sees and the flag the countdown reads (`autoSend` on the rail below) are ONE persisted
        // value, never a prop mirror that could drift from it.
        autoSendOn={sendTray.autoSend}
        onAutoSendChange={sendTray.setAutoSend}
        trayInert={sendTray.inert}
        // The gesture, straight from the hook that owns it — see ComposeBox's `pttHeld` doc for why
        // this one line is the difference between the held treatment existing and running.
        pttHeld={sendTray.held}
        onComposedText={onComposedText}
        registerSubmit={registerSubmit}
        // A `sparkle-agent:` pill in one of the concierge's own replies was clicked. The SAME
        // reveal the notifications and the command palette use — `openProjectTab` opens the owning
        // project's tab, selects it, clears the Sparkle overlay and reveals the agent. Partial
        // re-implementations of that sequence are what its header warns about.
        onOpenAgent={openAgentFromPill}
        // …and the state that is NOT a navigation: a pill that cannot be opened names the agent and
        // routes to the prompt history that outlived it, instead of the click producing nothing.
        onSeeAgentHistory={seeAgentHistory}
      />
      {/* The recommended-action pill. Mounted HERE — where its delivery wiring lives — but it
          renders over the target agent's terminal, which it reaches by portal (see
          ConciergeSuggestions). It was a `suggestionsSlot` in the column until the pill moved onto
          the terminal; a fragment sibling costs no layout, since a portal renders elsewhere.
          KEYED BY AGENT. useSuggestions owns one agent per instance by design; a shared instance
          with a changing id kept the previous agent's buttons on screen and would write their
          keystroke into the newly-selected agent's PTY. See ConciergeSuggestions' header.

          Keyed off `target`, NOT `routingTarget`: the engine must keep running while the user looks
          at the Plan board (auto-approve lives inside the hook). Only the PILL follows the view. */}
      {target ? (
        <ConciergeSuggestions
          key={target.agentId}
          agentId={target.agentId}
          agentName={target.name}
          visible={promptTargetShown}
          // QUEUE ONCE. onApply wraps the WHOLE action, so the delivery it calls must NOT queue
          // again: applySuggestion awaits deliverPrompt from inside the chain, and a second
          // enqueue would chain onto the very promise that is awaiting it. Circular wait — broken
          // only by the task timeout, i.e. a 30s stall of every send, redirect and Approve, and
          // then a keystroke arriving anyway (roborev 53196).
          onApply={(run) => enqueue(run, false)}
          // announceSuccess: TRUE — a suggestion click posts no receipt, so without this a
          // delivered recommended action would be the one silent success in the column.
          // The user clicked a recommended-action pill — an explicit, targeted gesture.
          onDeliverPrompt={(t) =>
            promptAgent(
              target,
              t,
              { display: t, namingBasis: t },
              [],
              true,
              { kind: "suggestion", agentId: target.agentId },
              // A recommended-action pill IS often a picker answer — that is much of what it is
              // for — so it keeps the keystroke path.
              false,
            )
          }
          onFailure={postSparkle}
        />
      ) : null}
    </>
  );
}
