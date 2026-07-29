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
  type ConciergeDigestMessage,
  type ConciergeMessage,
  type ConciergeNudge,
  type ConciergeNudgeAction,
  type ConciergeReceipt,
  type ConciergeViewModel,
} from "./Concierge";
import { ConciergeSuggestions } from "./Concierge/ConciergeSuggestions";
import type { ConciergeAgent, ConciergeFeed } from "../useConciergeFeed";
import type { AgentTabStatus } from "../types";
import { bandCountLabel } from "../engine/statusBandLabels";
import { rosterLine } from "../engine/conciergeRosterLine";
import { oneLine } from "./promptHistory";
import { openProjectTab } from "../services/openProjectTab";
import {
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  startConciergeTurn,
  startProactiveConciergeTurn,
  isProactiveTurn,
  isSupersededDetail,
} from "../services/concierge";
import {
  accountedNeedsYou,
  createProactiveScheduler,
  markStaleProactive,
  surfacedDigest,
} from "../services/conciergeProactive";
import {
  agentCanAcceptInput,
  answersLivePicker,
  dispatchConciergeAnswer,
  onDeferredSendOutcome,
  type ConciergeDispatchPath,
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
import { routeMessage } from "../services/conciergeRouter";
import { mentionFreeText, rosterFromMentions, type ConciergeMention } from "./Concierge/mentions";
import { buildDigest } from "../services/conciergeDigest";
import { createArrivalOrder, orderByArrival } from "../engine/conciergeStreamOrder";
import { useUiStore } from "../stores/uiStore";
import { attachedDisplay, attachedPayload } from "../services/conciergeAttach";
import { useConciergeAttachments } from "../hooks/useConciergeAttachments";
import type { Attachment } from "./composer/attachments";
import { screenshotAttachment } from "./composer/attachmentsApi";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
// Read imperatively (getState) inside the handoff effect only, to tell a cloud build agent — whose
// null prompt target is BY DESIGN — from an agent that genuinely went missing. Not subscribed: this
// host renders from the feed, and a project-store subscription would re-render it on every unrelated
// agent write.
import { useProjectStore } from "../stores/projectStore";
// The SELECTED project id, for the header's "here" segment. A scalar selector, deliberately — it
// re-renders this host only when the selection actually changes, which is the narrow subscription
// the note above rules the whole `projects` array out in favour of.
import { useCurrentProjectId } from "../windowContext";
import { describePaths } from "../services/logSafePaths";
import { log } from "../logger";
import { maybePauseOnSubmit } from "../services/dictationControls";
import { useConciergeDictation } from "../useConciergeDictation";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { usePresenceStore, type PresenceMode } from "../stores/presenceStore";
// `setConciergeChat` is aliased to `setChat` AT THE IMPORT so it stays module-scoped: that is what
// keeps `react-hooks/exhaustive-deps` from demanding it in five dependency arrays below (a store
// setter isn't on the rule's known-stable list the way `useState`'s is, even though this one never
// changes identity). See the store for the full reasoning.
import { useConciergeThread, setConciergeChat as setChat } from "../stores/conciergeThreadStore";
import {
  buildRecap,
  recapSummary,
  type AwaySnapshot,
  type RecapAgentInfo,
} from "../services/conciergeRecap";

let seq = 0;
const nextId = (p: string) => `${p}-${(seq += 1)}`;

/** How many sent messages keep their original text for a possible redirect. Only the newest bubble
 *  is ever redirectable, so anything older is dead weight — and without a bound a long session with
 *  pasted content grows the map forever. Kept well above 1 so the map still reads as a short
 *  history rather than a single slot. */
export const SENT_TEXT_LIMIT = 50;

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

/** Remember `text` for `id`, evicting the oldest entries past the cap (Map preserves insertion
 *  order, so the first keys are the oldest). */
export function rememberSentText(map: Map<string, string>, id: string, text: string): void {
  map.set(id, text);
  while (map.size > SENT_TEXT_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** What the concierge says when the server has refused the send: the free trial is spent. The
 *  dispatch path gates BEFORE delivery (services/trialMeter.trialSendAllowed), so nothing reached
 *  the agent — say so plainly rather than leaving the user waiting on a reply that isn't coming. */
export const TRIAL_SPENT_TEXT =
  "Your free trial is used up, so that didn't send. Upgrade and I'll pass it straight through.";

/** The two voices a non-delivery is reported in: the nudge card's Approve relay, and the compose
 *  box's user-authored prompt. Same facts, different remedy — "hit Retry" vs "then send again". */
type RefusalVoice = "approval" | "prompt";

/** The paths that mean NOT DELIVERED. `picker-option`/`free-text` are excluded because they DID
 *  land; `queued` because it means HELD — the callers report that themselves, but only when `ok`,
 *  so an `ok:false` queued result DOES reach `refusedPath` and comes back `null` for the generic
 *  line (roborev 53044). Narrowing the parameter this way means handing a delivered path to
 *  `refusalCopy` is a compile error at the call site rather than a misleading generic
 *  "I couldn't send…" — the very dead end it exists to remove (roborev 52972). */
type RefusedPath = Exclude<ConciergeDispatchPath, "picker-option" | "free-text" | "queued">;

/**
 * The refusal path of a result that did NOT deliver — or `null` when it did.
 *
 * `ok` stays the ONLY test for delivery. An earlier pass got the narrowing by widening the callers'
 * success branch to `r.ok || r.path === "picker-option" || r.path === "free-text"`, which inverted
 * that: an `{ ok: false, path: "free-text" }` would have reported "Sent to X." and, in
 * `promptAgent`, returned true — DISCARDING the user's draft on a failure that used to restore it
 * (roborev 53018). A cosmetic risk is not worth a real one. This predicate gives the same
 * compile-time proof with `ok` still in charge.
 */
function refusedPath(r: ConciergeDispatchResult): RefusedPath | null {
  if (r.ok) return null;
  switch (r.path) {
    // ok:false on a path that means "delivered" is a contradiction the type system can't yet rule
    // out (ok and path are independent fields). Treat it as a plain refusal with no bespoke line
    // rather than as a success — the user keeps their draft either way.
    case "picker-option":
    case "free-text":
      return null;
    // `queued` means HELD, not delivered — reachable here precisely BECAUSE the callers gate their
    // held branch on `ok`. An ok:false hold is not a hold, so it takes the generic refusal line.
    case "queued":
      return null;
    default:
      return r.path;
  }
}

/** THE one place a refused dispatch path becomes user-facing copy.
 *
 *  `approve` and `promptAgent` used to carry two near-identical `else if` ladders over the same
 *  paths, and they drifted exactly as you'd expect: the truthful `agent-failed`/`cloud-agent` lines
 *  landed on the prompt side a full commit before the approval side, so approving on a cloud agent
 *  gave the generic "I couldn't send…" dead end for a week. An exhaustive `switch` makes that
 *  impossible — a path added to ConciergeDispatchPath is a TYPE ERROR here (the `never` guard in
 *  `default`) instead of a silent fall-through to the generic line.
 *
 *  Only NON-delivery is handled: the callers report the delivered/held paths themselves, because
 *  what they do there differs (approve returns void; promptAgent returns whether to keep the draft). */
function refusalCopy(path: RefusedPath | null, name: string, voice: RefusalVoice): string {
  const approving = voice === "approval";
  const generic = approving ? `I couldn't send the approval to ${name}.` : `I couldn't send that to ${name}.`;
  if (path === null) return generic; // refused on a delivered-looking path — see refusedPath
  switch (path) {
    case "trial-spent":
      return TRIAL_SPENT_TEXT;
    case "agent-failed":
      return approving
        ? `${name} couldn't start, so I couldn't send the approval — open its pane and hit Retry.`
        : `${name} couldn't start, so that didn't send — open its pane and hit Retry (or finish installing Claude Code), then send again.`;
    case "cloud-agent":
      return approving
        ? `${name} runs in the cloud — I can't relay the approval from here yet; answer it in its own pane.`
        : `${name} runs in the cloud, and prompting cloud agents from here isn't wired up yet — use its own pane for now.`;
    case "pty-gone":
      return approving
        ? `${name}'s terminal has closed — I couldn't send the approval.`
        : `${name}'s terminal has closed — that didn't send. Start it again and I'll pass it along.`;
    case "ambiguous-picker":
      return approving
        ? `${name} is asking something I can't answer with a plain "approve" — open it to choose.`
        : `${name} is waiting on a choice I can't map that to — open it and pick, or answer with just the option.`;
    // ITS OWN LINE, not a second use of `ambiguous-picker` above (roborev 54665). That copy says the
    // answer mapped to nothing and to "answer with just the option", and here both are false: the
    // text mapped perfectly — which is WHY it was refused, since an addressed message is a message,
    // not a keystroke — and answering with just the option is what the user did. Sharing the line
    // sent them round a loop whose only exit was guessing that the `@` was the problem. This one
    // states the real reason and the two real exits.
    // ONE exit, not two. This line used to offer a second — "drop the @<name> and send just the
    // option" — and that advice is only safe when the named agent also happens to be the column's
    // current target. `send` resolves an UNADDRESSED message against `targetRef.current`, so with
    // the address removed the bare "yes" is aimed at whatever the column is pointed at. The whole
    // premise of naming an agent is that it is most natural when several are asking at once, which
    // is exactly when the shown target is a DIFFERENT agent — and a terse "yes" landing on that
    // agent's live picker gets framed as `y\r` and presses its button. That is the precise outcome
    // `neverPickerAnswer` exists to prevent, reintroduced by the remedy text. Gating the second
    // exit on `targetRef.current?.agentId === aim.agentId` would also work; it is not worth a
    // branch and a threaded ref to keep an affordance that saves one click. (roborev 54673.)
    case "addressed-at-picker":
      return approving
        ? `${name} is waiting on a choice on screen — open it and pick.`
        : `${name} is waiting on a choice on screen, so I didn't send that to it as a message — open ${name} and pick.`;
    case "unauthorized":
      // Should be unreachable: `authority` is required and non-defaulted, so a call site that omits
      // it does not compile. Reachable only if a malformed authority is built dynamically — a bug,
      // not a user error. Say the honest thing (it did NOT send) without inventing a remedy the
      // user could act on, and let the log line carry the diagnosis.
      return approving
        ? `Something went wrong on my side, so I didn't send the approval to ${name}.`
        : `Something went wrong on my side, so I didn't send that to ${name}. Try again.`;
    case "queue-full":
      // A full hold queue is NOT a dead terminal — the agent is starting normally, there are simply
      // already MAX_PER_AGENT prompts waiting on it. Falling through to the generic line (or worse,
      // to the "terminal has closed" one) would send the user to restart something that is coming
      // up fine (roborev 46280). Both voices name the action that was refused, because these
      // ladders otherwise only say what did NOT happen, leaving the user unsure whether theirs
      // went through.
      return approving
        ? `${name} already has a few prompts waiting to start — let those land first, then approve again.`
        : `${name} already has a few prompts waiting to start — let those land first, then send again.`;
    // No bespoke line: "empty" is a blank answer the UI already swallows, and "expired"/"abandoned"
    // are DEFERRED outcomes reported by the onDeferredSendOutcome effect below, never returned to a
    // caller synchronously. They are listed rather than folded into `default` on purpose — `default`
    // has to stay unreachable for the exhaustiveness guard to have any teeth.
    case "empty":
    case "expired":
    case "abandoned":
      return generic;
    default: {
      const unhandled: never = path;
      void unhandled;
      return generic;
    }
  }
}

/** Flatten every agent across the feed (used to resolve a nudge back to its source agent). */
function allAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return feed.projects.flatMap((p) => p.agents);
}

/**
 * The fleet's statuses AS THE CARDS SEE THEM, for the Away recap's two edges.
 *
 * Read from the FEED, never from `runtimeStore.status`, and that is the whole point (roborev
 * 53631-H2). The feed's per-agent status is the DERIVED/published one — the cross-window merged
 * roster plus the unstarted-worker, red-worker, unmerged and dismissed-alert overlays
 * (services/conciergeFeed → publishedStatusFor) — and it is what every `statusLabel` and every
 * nudge card in this thread already speaks. Diffing the raw store against feed-supplied labels made
 * them two vocabularies, with two visible failures:
 *
 *   • `runtimeStore.status` only holds agents THIS window hosts (useConciergeFeed), so a
 *     roster-fed agent was absent from BOTH sides of the diff and `newlyEntered` skipped it — the
 *     recap said nothing about an agent in another window that went `waiting` while the same
 *     thread rendered a nudge card for it. On a concierge column pinned to a project this window
 *     does not host, the recap could never fire at all.
 *   • A red the user had DISMISSED reads de-escalated (`idle`/`stopped`) in the feed but still
 *     `waiting` in the raw store, so the recap filed it under "Wants you" while printing the feed's
 *     "Done — your turn" beside it — resurfacing an alarm the user had explicitly silenced.
 *
 * Building both sides here makes status, label and card one vocabulary by construction, and picks
 * up cross-window agents for free.
 */
function feedStatuses(feed: ConciergeFeed): Omit<AwaySnapshot, "at"> {
  const agents = allAgents(feed);
  return {
    status: Object.fromEntries(agents.map((a): [string, AgentTabStatus] => [a.id, a.status])),
    agentIds: agents.map((a) => a.id),
    // Carried so the recap can tell a head that was genuinely working at the away edge from one
    // standing in for its subtree — see AwaySnapshot.rolledUpGreen.
    rolledUpGreen: agents.filter((a) => a.rolledUpGreen).map((a) => a.id),
  };
}

/** EVERYTHING column one accounts for right now: in scope, un-muted, needing you, and not already
 *  spoken for by an ancestor's row.
 *
 *  `band === "needs_you"` is the interruption gate. It covers exactly what the old `priority < 2`
 *  did — waiting, approval, blocked, errored — and, critically, still excludes `unmerged`, which
 *  bands `done`. On the reported fleet 27 of 51 agents were committed-but-unlanded; surfacing them
 *  here is 27 nudge cards (see services/conciergeFeed.conciergeBand).
 *
 *  These are THE SAME THREE GATES `conciergeFeed` counts `scopedCounts` on, and that is the point:
 *  the vitals line states `scopedCounts.needs_you` while the thread renders this list, so they are
 *  one population by construction rather than two computations that have to be kept in step. They
 *  did drift — `scopedCounts` counted a red worker AND the orchestrator that inherited its red, so
 *  the line said "2 Need you" over a thread holding one card.
 *
 *  Note the remaining asymmetry is the SAFE direction. `muted` can make this set smaller than the
 *  rows the filter leaves standing, so the sentence can under-state. That is fine — every row it
 *  promised is there, plus one you asked not to be interrupted about. Over-stating is the bug,
 *  because the missing rows do not exist to be shown.
 *
 *  ONE IMPLEMENTATION, in services/conciergeProactive — this delegates rather than restating the
 *  filter (roborev 54166-M5). The proactive push channel builds its prompt from the same population
 *  and the two copies were verbatim duplicates, which is exactly the drift the paragraph above is
 *  about: the brain would announce, unprompted, a count this column does not show. It lives there
 *  and not here because that module is pure and React-free, so the rule is testable as data. */
function accountedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedNeedsYou(feed);
}

/** The half of {@link accountedAgents} that is OWED A ROW in column two — the digest's pool.
 *
 *  `topLevel` is what makes the digest's number honest. Every LINE this feeds is clickable, and the
 *  click isolates that band in the Build column — which narrows top-level rows and nothing else.
 *  Folding a worker into a line's count would state a number the click cannot produce: two blocked
 *  workers rendered "2 Need you in web", and clicking it left an empty column plus an empty-state
 *  chip. */
function surfacedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => a.topLevel);
}

/** The other half: accounted-for agents with NO row of their own, which therefore have to speak for
 *  themselves.
 *
 *  They are digested by the SAME rule as everything else — one keeps its card, two or more become a
 *  line — but as the `rowless` variant, because a normal line's count is a promise about rows and
 *  these have none. This population is NOT bounded by one: gap 3 below fires once per blocked
 *  worker, so several under an absent or in-motion parent used to be several cards, which is the
 *  card wall the digest exists to prevent, reintroduced through the one path that skipped it.
 *
 *  What survives from the card era is the AFFORDANCE, not the shape: a single one still gets a card
 *  whose "Show me" reveals it (`openProjectTab` selects it, and the sidebar pops a red worker out
 *  under its orchestrator), and the collapsed line's click does that same reveal for its lead.
 *
 *  Non-empty only when a rowless agent's red reached nobody — a worker with no `parentId`, one whose
 *  orchestrator is not in the fleet, or a `blocked` one whose bubble `withRedWorkerAttention`
 *  suppressed while its orchestrator was in motion. Before this existed, the `topLevel` gate turned
 *  all three into silence: no row, no card, no line, no count. See
 *  `ConciergeAgent.representedElsewhere` for why the test is band equality and not kind. */
function unrepresentedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => !a.topLevel);
}

/** The part of {@link unrepresentedAgents} a LINE may collapse: those that do get a nested row.
 *
 *  A digest line's click reveals exactly one agent, so collapsing is only honest when the click can
 *  nonetheless put the WHOLE group on screen. That is not a free property of the sidebar — it is
 *  something the click has to DO. The original version of this comment claimed the former ("reveal
 *  one and the siblings are on screen beside it") and was wrong twice over: `collapsedOrchestrators`
 *  reads a missing entry as collapsed, so on a fresh launch the subtree is shut, and a leftover band
 *  filter can drop the head entirely (roborev 53679, then 53734).
 *
 *  So the guarantee is attributed where it actually lives: `revealAgent` and the rowless branch of
 *  `onDigestClick` call `showAllStatusBands()` + `expandOrchestrators(...)` before opening. What
 *  makes this population collapsible is having a head at all — one the click can name and open. */
function nestedRowlessAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return unrepresentedAgents(feed).filter((a) => a.parentRowId !== null);
}

/** The part that may NOT be collapsed: accounted-for agents with no row ANYWHERE.
 *
 *  A worker with no `parentId`, or one whose orchestrator is not in this project's fleet, is not
 *  drawn by column two at all — not as a head, not as a child. Its nudge card's "Show me" is its
 *  ONLY affordance in the app, so folding several into one line strands all but the lead: the line
 *  read "2 workers inside web need you" and the click could satisfy one of them, with no way to
 *  reach the other until the first resolved (roborev 53679).
 *
 *  So these stay one card each, on purpose. That is not the card wall coming back — the wall is the
 *  HIGH-VOLUME case, a blocked worker under a present-but-in-motion orchestrator, which fires once
 *  per worker and is exactly what {@link nestedRowlessAgents} still collapses. This population is
 *  the rare ancestor-less remainder, and a card apiece is the cheapest thing that keeps every one of
 *  them reachable. */
function strandedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return unrepresentedAgents(feed).filter((a) => a.parentRowId === null);
}

function actionsFor(a: ConciergeAgent): ConciergeNudgeAction[] {
  const show: ConciergeNudgeAction = { id: "show", label: "Show me" };
  const mute: ConciergeNudgeAction = { id: "mute", label: "Mute", kind: "ghost" };
  // The primary (gold) action is Approve when the agent is blocked on an approval prompt (one-tap
  // relay into its terminal); otherwise it's Show me. Show me is plain when Approve is the primary.
  if (a.status === "approval") {
    return [{ id: "approve", label: "Approve", kind: "primary" }, show, mute];
  }
  return [{ ...show, kind: "primary" }, mute];
}

function agentToNudge(a: ConciergeAgent): ConciergeNudge {
  return {
    id: a.id, // the source agent id — resolved back via the feed on click/action
    kind: "nudge",
    band: a.band,
    projectName: a.projectName,
    agentName: a.name,
    text: `${a.statusLabel} — ${a.name} in ${a.projectName}.`,
    actions: actionsFor(a),
  };
}

/** Compact context handed to the headless brain so its reply is grounded in what's actually happening. */
function buildSnapshot(feed: ConciergeFeed, userText: string): string {
  // The FULL accounted population, rows and rowless alike — this states `scopedCounts.needs_you`
  // right below, and listing only the row-owning half would hand the brain a count it can't see the
  // items behind.
  const surfaced = accountedAgents(feed);
  // The line format — including the trailing `id:<agentId>` the persona's pill syntax depends on —
  // lives in engine/conciergeRosterLine, shared with buildProactivePrompt. See that module's header
  // for why a second copy of the template string is not an option.
  const lines = surfaced.map((a) => rosterLine(a));
  // Keep the project count SCOPED to what's actually surfaced so it can't misstate scope (e.g. say
  // "5 projects" while only counting in-scope agents).
  const scopedProjects = new Set(surfaced.map((a) => a.projectId)).size;
  const state =
    surfaced.length > 0
      ? `${bandCountLabel("needs_you", feed.scopedCounts.needs_you)} across ${scopedProjects} project(s):\n${lines.join("\n")}`
      : `All projects are calm right now.`;
  return `${state}\n\nThe user says: ${userText}\n\nReply briefly and recommend the next action.`;
}

/** The agent a compose-box send would reach when the target is "agent": the selected tab's
 *  selected agent. Null when there's no project open or no agent selected. */
export interface ConciergePromptTarget {
  projectId: string;
  agentId: string;
  name: string;
}

/**
 * An aim the user stated OUT LOUD, by naming an agent in the message itself (`@Blueprint UI/UX move
 * it 5px`). Everything the send needs to honour that, captured at submit like every other aim.
 *
 * ══ WHY THIS IS ALLOWED TO SKIP THE ROUTER, WHEN `forceSparkle` IS ONLY ALLOWED ONE WAY ═════════
 * `deliver`'s `forceSparkle` carries a warning that a `forceAgent` twin must never be added, because
 * it "would type a paragraph into a live PTY on the strength of a latch". That warning stands, and
 * this is not the thing it forbids. Three differences, and the third is the one that matters:
 *
 *   1. A LATCH is invisible state left over from an earlier action (the capture window's Chat ❯,
 *      set once and consumed later), which is why it has to be retired the moment the words that
 *      set it are gone. A mention is not state at all — it is DERIVED from the text being sent, at
 *      the moment of sending (components/Concierge/mentions). It cannot outlive its own words
 *      because it has no existence apart from them.
 *   2. It is VISIBLE. The user typed the name, the picker offered it, and the pill is in the bubble.
 *   3. **IT DOES NOT SKIP THE GATE.** This changes only WHO decides the destination — the user
 *      instead of the classifier. It still arms an intent, still counts down in the banner, still
 *      offers Cancel, and still posts a receipt. What the warning is really protecting is that no
 *      heuristic verdict reaches a terminal unseen; a mention reaches it by exactly the same
 *      countdown every routed send does. That is why there is still no `router` arm in
 *      DispatchAuthority and must never be one.
 *
 * So: explicitness buys the user a skipped classify, never a skipped gate. If you are ever tempted
 * to dispatch a mention directly, that is the line this comment exists to hold.
 */
interface ConciergeMentionAim {
  /** The agent the message named. */
  target: ConciergePromptTarget;
  /** What the PTY receives — the address stripped off, attachment paths prefixed. The `@` must not
   *  reach the terminal: the agent there is a Claude Code CLI, where a leading `@` opens its own
   *  file-reference autocomplete (see mentions.mentionFreeText). */
  payload: string;
  /** The same without attachment paths — what the auto-namer reads. */
  text: string;
}

/** How much of a relayed message is quoted back to the brain when it acknowledges the hand-off.
 *  Bounded for the reason the router bounds its context line: a pasted essay would otherwise bill
 *  unbounded metered input tokens on every mention. */
const RELAY_QUOTE_CHARS = 240;

/**
 * What Sparkle is asked after it has relayed a message — the founder's headline requirement:
 * *"the concierge sends it over to that builder agent, but ALSO still participates in the
 * conversation… I want the concierge to be a thought partner."*
 *
 * A real brain turn, not a canned line. `postSparkle("Sent to X.")` would satisfy "says something"
 * and miss the ask entirely: the point is that addressing an agent starts a conversation ABOUT that
 * agent rather than ending one. The receipt under the bubble already states the bare fact of
 * delivery, so this prompt asks for the half a receipt cannot give.
 *
 * Phrased in the user's voice because `buildSnapshot` wraps it in "The user says:" — writing it as
 * an instruction to the assistant there would read as the user issuing stage directions.
 */
export function relayFollowUp(agentName: string, sent: string): string {
  const quoted = oneLine(sent).slice(0, RELAY_QUOTE_CHARS);
  return `(I just used the concierge to send "${quoted}" over to my build agent "${agentName}". Confirm briefly that it went, then stay with me on it — what else should I be thinking about, or want to take up with ${agentName}?)`;
}

export function ConciergeHost({
  feed,
  promptTarget = null,
  promptTargetShown = true,
  width,
  searchSlot,
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
}) {
  // Latest feed for the event handlers (send/nudge actions), which run after render.
  const feedRef = useRef(feed);
  // The thread's arrival ledger: which message ids have been seen, and in what order. A REF, not
  // state — it records history rather than driving a render, and the memo below reads it while
  // building. Assign-once semantics keep a digest that flickers (a group needs >= 2 agents, so it
  // collapses at 1 and re-forms at 2) from leaping to the bottom of the thread each time.
  const arrivalRef = useRef(createArrivalOrder());
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
  const [typing, setTyping] = useState(false);
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

  // The compose box's own insert fn, kept so a send that dies AFTER the box already cleared can put
  // the user's words back. See `restoreDraft`.
  const insertRef = useRef<((text: string) => void) | null>(null);

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
  const restoreDraft = useCallback((text: string) => {
    if (text.trim() === "") return;
    insertRef.current?.(text);
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
      promptTarget && allAgents(feed).some((a) => a.id === promptTarget.agentId)
        ? promptTarget
        : null,
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

  // ══ @-MENTIONS ═══════════════════════════════════════════════════════════════════════════════
  // Who the compose box's "@" picker may offer, and — the same list, which is the point — the roster
  // a typed mention is RESOLVED against. One list, so an agent that is offerable and an agent that
  // is addressable can never be two different populations.
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
        canAcceptInput: agentCanAcceptInput(a.id),
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
    ({ agentId, projectId }: { agentId: string; projectId: string }) => {
      // Destructured by NAME on both sides, so the order flip into `openProjectTab(projectId,
      // agentId)` — two strings, silently swappable — cannot happen here (roborev 54894).
      openProjectTab(projectId, agentId);
    },
    [],
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
  useEffect(() => {
    if (!dropTargetAgentId) return;
    const paths = usePendingAttachmentsStore.getState().drain(dropTargetAgentId);
    if (paths.length === 0) return;
    // Kinds, never paths — this log ships with support tickets (services/logSafePaths).
    log.info("composer", `staging ${paths.length} handed-off file(s) on the compose box`, {
      agentId: dropTargetAgentId,
      ...describePaths(paths),
    });
    attachPaths(paths);
  }, [dropTargetAgentId, attachPaths]);

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

  // Stream the brain into the thread: deltas append to a bubble keyed by the turn id; done finalizes.
  useEffect(() => {
    const key = (id: string) => `brain-${id}`;
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
    const upsert = (id: string, text: string, replace: boolean) => {
      const prior = brainTextRef.current[id] ?? "";
      brainTextRef.current[id] = replace ? text : prior + text;
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return [...prev, { id: k, kind: "sparkle", text, ...pushFields(id) }];
        const next = prev.slice();
        const cur = next[i]!;
        next[i] = {
          ...cur,
          kind: "sparkle",
          // `cur` is always the sparkle bubble for this turn — it was found by the turn's own key —
          // but the union now contains a variant with no `text` at all (the recap card), so the
          // narrowing has to be explicit rather than a defensive `?? ""`.
          text: replace ? text : (cur.kind === "sparkle" ? cur.text : "") + text,
          ...pushFields(id),
        };
        return next;
      });
    };
    const offDelta = onConciergeDelta((e) => {
      if (supersededTurn(e.id)) return;
      upsert(e.id, e.text, false);
    });
    const offDone = onConciergeDone((e) => {
      if (supersededTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      // A push owns no typing indicator — nobody is waiting on it. The Rust command stands down
      // for any user turn so the two should never overlap, but if that ever changes, clearing here
      // would take the indicator away from the reply the user IS waiting on.
      if (!isProactiveTurn(e.id)) setTyping(false);
      if (e.text) upsert(e.id, e.text, true);
      const full = brainTextRef.current[e.id] ?? "";
      delete brainTextRef.current[e.id];
      // The reply is FINISHED here — announce it once, rather than per delta. Via `announce`, so
      // the SAME reply twice in a row is still announced twice (roborev 53392).
      if (full) announce(full);
    });
    const offError = onConciergeError((e) => {
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
      setTyping(false);
      // A failed turn never reaches the done handler, so drop its partial text here rather than
      // retaining every failed reply for the life of the session.
      delete brainTextRef.current[e.id];
      setChat((prev) => [
        ...prev,
        {
          id: nextId("err"),
          kind: "sparkle",
          text: "I couldn't reach my brain just now — try me again in a moment.",
        },
      ]);
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [announce]);

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
      startTurn: async (prompt, digest) => {
        const id = await startProactiveConciergeTurn(prompt);
        // Null means no turn ran — the user owns the conversation, or the bridge failed. Reporting
        // that honestly is what keeps the change pending instead of silently swallowed.
        if (id === null) return false;
        pushDigestRef.current.set(id, digest);
        const oldest = pushDigestRef.current.keys().next();
        if (pushDigestRef.current.size > 16 && !oldest.done) pushDigestRef.current.delete(oldest.value);
        return true;
      },
    });
    schedulerRef.current = s;
    return () => {
      s.dispose();
      schedulerRef.current = null;
    };
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
   *   1. `collapsedOrchestrators` reads a missing entry as COLLAPSED, and `expandOnWorkerAttention`
   *      skips first sighting — so on a fresh launch the head's subtree is shut and the reveal lands
   *      on a terminal pane above zero worker rows.
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
   * A top-level agent passes through untouched — it owns its row, so there is nothing to expand and
   * no filter to clear.
   */
  const revealAgent = useCallback((a: ConciergeAgent) => {
    if (a.parentRowId !== null) {
      const ui = useUiStore.getState();
      ui.showAllStatusBands();
      ui.expandOrchestrators([a.parentRowId]);
    }
    openProjectTab(a.projectId, a.id);
  }, []);

  /** Is this agent still in the feed? Absence IS "closed / deleted / project unloaded". */
  const agentStillExists = useCallback(
    (id: string | undefined) => !!id && allAgents(feedRef.current).some((a) => a.id === id),
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
  const postSparkle = useCallback((text: string) => {
    setChat((prev) => [...prev, { id: nextId("sparkle"), kind: "sparkle", text }]);
    // A send outcome is exactly what a screen-reader user needs told, and it arrives whole. Two
    // sends to the same pinned agent produce the same line twice; both must be announced.
    announce(text);
  }, [announce]);

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
      postSparkle(`Approving ${a.name}…`);
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
          postSparkle(`I couldn't reach ${a.name}'s terminal to approve.`);
          return;
        }
        if (!r) {
          postSparkle(`I couldn't send the approval to ${a.name}.`);
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
          postSparkle(`${a.name} is still starting up — I'll approve as soon as it's ready.`);
        } else if (r.ok) postSparkle(`Approved — sent to ${a.name}.`);
        else postSparkle(refusalCopy(refusedPath(r), a.name, "approval"));
      } catch {
        postSparkle(`I couldn't reach ${a.name}'s terminal to approve.`);
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
       *  conciergeDispatch's `neverPickerAnswer`. TRUE only for a message the user ADDRESSED to
       *  this agent by name; the mirror check in `send` cannot enforce it, because the gate lives
       *  inside the dispatcher (roborev 54569). REQUIRED, so a future call site has to decide
       *  rather than inherit a default that is wrong for it. */
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
          postSparkle(`${target.name} is still starting up — I'll send that the moment it's ready.`);
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
              ? `${target.name} was asking something — I answered "${r.matchedLabel}".`
              : `${target.name} was asking something — I answered it.`,
          );
          return true;
        }
        if (r.ok) {
          if (announceSuccess) postSparkle(`Sent to ${target.name}.`);
          return true;
        }
        postSparkle(refusalCopy(refusedPath(r), target.name, "prompt"));
        return false;
      } catch {
        postSparkle(`I couldn't reach ${target.name}'s terminal.`);
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
        const name = allAgents(feedRef.current).find((a) => a.id === r.agentId)?.name ?? "that agent";
        // The files that rode this held send: handed back when it never landed, dropped when it
        // did. Taken either way so the queue can't outlive the promise it belongs to.
        const held = takeHeldAttachments(r.agentId);
        if (!r.ok) restoreAttachments(held);
        // Quote the DISPLAY rendering, never `sent` — `sent` is the wire payload and carries the
        // attachments' temp paths (roborev 46925). Falls back to `sent` only when the dispatch
        // carried no separate display, i.e. nothing was attached.
        const shown = r.display ?? r.sent;
        const quoted = shown ? ` ("${oneLine(shown)}")` : "";
        // Each non-delivery says what actually happened; a wrong reason is its own small lie
        // (roborev 46485-M — `abandoned` used to be reported as "the terminal closed", which is
        // false when the spawn failed and no terminal ever opened).
        //
        // `pty-gone` is its OWN arm rather than the catch-all: the terminal-closed wording is a
        // specific claim, and letting any future path fall into it (say abandonPendingSends grows
        // an `agent-failed` emit) is how 46485-M happened the first time. An unknown path gets a
        // reason it can always stand behind (roborev 53162).
        if (r.ok) postSparkle(`${name} is up — I sent your message${quoted}.`);
        else if (r.path === "expired") postSparkle(`${name} never came up, so I dropped the message I was holding${quoted}. Send it again when it's running.`);
        else if (r.path === "abandoned") postSparkle(`${name} couldn't take the message I was holding${quoted}. Send it again once it's running.`);
        else if (r.path === "pty-gone") postSparkle(`${name}'s terminal closed before I could send the message I was holding${quoted}.`);
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
        else postSparkle(`${name} didn't take the message I was holding${quoted}.`);
      }),
    [postSparkle, takeHeldAttachments, restoreAttachments],
  );

  /** Start a Sparkle chat turn for `text`. Never fails visibly, so it reports no outcome. */
  const askSparkle = useCallback((text: string) => {
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
    void startConciergeTurn(buildSnapshot(feedRef.current, text)).then((id) => {
      const n = id !== null && /^\d+$/.test(id) ? Number(id) : null;
      if (n !== null) retireThroughRef.current = Math.max(retireThroughRef.current, n - 1);
    });
  }, []);

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
    announce(receiptText(receipt));
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
    ): Promise<boolean> => {
      // An agent that has since LEFT the feed is gone (closed, deleted, project unloaded), and
      // routing at it would report a delivery that cannot happen. Gone → the safe direction.
      const aim = submitted && agentStillExists(submitted.agentId) ? submitted : null;
      const status = aim ? useRuntimeStore.getState().status[aim.agentId] : undefined;
      // The DISPATCHER's own precondition, asked up front: it refuses cloud agents outright, so
      // telling the router turns a guaranteed delivery failure into a useful chat answer. One
      // shared predicate rather than a copy here, so the two can't drift.
      const canAcceptInput = aim ? agentCanAcceptInput(aim.agentId) : false;
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
          `${mentionAim.target.name} can't take a message right now, so I've kept this here instead.`,
        );
      }
      // An address with NOTHING TO SAY is not a send. "@Kraken Auth" on its own strips to an empty
      // wire payload, and writing an empty line into a live PTY is at best a stray newline at the
      // agent's prompt. It is also almost certainly not what the user meant, so the concierge asks
      // rather than either guessing or silently doing nothing.
      if (addressable && mentionAim.text.trim() === "" && staged.length === 0) {
        postSparkle(`You've got ${mentionAim.target.name} in mind — what should I send over?`);
        setReceipt(id, {
          target: "sparkle",
          agentName: aim?.name,
          agentId: aim?.agentId,
          // Nothing to redirect: there is no instruction in this message to send anywhere.
          redirectable: false,
        });
        return true;
      }
      const decision = addressable
        ? ({
            target: "agent",
            reason: "you named this agent in the message",
            // "heuristic" for the same reason `forceSparkle` claims it: tier 1 means deterministic
            // and zero-cost, and no model was asked. Naming the agent yourself is as tier-1 as it
            // gets — it is not a guess at all.
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
        // prompt plus terse concierge-aimed text matched `looksLikeAnswer` and the user's words went
        // into a terminal with no warning and no way back. The router is RIGHT to be here (see
        // conciergeRouter's header, and PRs #644/#651 — it and all of its tests stay); what was
        // wrong was that its verdict went straight to the PTY.
        //
        // So it now ARMS an intent instead. The send becomes visible, counts down, and can be
        // cancelled; only an expiry the user didn't stop dispatches, and it does so carrying
        // `{ kind: "countdown", intentId }`. That is why there is no `router` arm in
        // DispatchAuthority and must never be one — a heuristic verdict is not a user gesture, and
        // the union having no legal variant for it is what makes the old behavior unrepresentable
        // rather than merely discouraged.
        // What actually goes down the wire. For an ADDRESSED message that is the version with the
        // `@…` stripped: the agent on the far end is a Claude Code CLI, where a leading `@` opens
        // its own file-reference autocomplete, so relaying the address verbatim would pop a picker
        // inside the agent's composer and strand the instruction behind it (mentions.
        // mentionFreeText). Every other send is unchanged.
        const wire = mentionAim && addressable ? mentionAim.payload : payload;
        const namingBasis = mentionAim && addressable ? mentionAim.text : text;
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
          onDispatch: (_intent, authority) => {
            // Through the queue, so a send that armed first still lands first — the countdown must
            // not silently reorder messages relative to an Approve or a redirect.
            void enqueue(async () => {
              // Seconds have passed since the route decision. The agent can be closed inside the
              // countdown window, and dispatching at a corpse would report a delivery that cannot
              // happen — the same re-check `deliver` does around the route call, for the same
              // reason and over a much wider gap.
              if (!agentStillExists(aim.agentId)) {
                postSparkle(`${aim.name} isn't open any more, so I didn't send that.`);
                restoreDraft(text);
                restoreAttachments(staged);
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
                if (mentionAim && addressable) askSparkle(relayFollowUp(aim.name, display));
                return true;
              }
              // A failed delivery must not cost the user their files any more than their words
              // (roborev 46922/48172/49293).
              restoreDraft(text);
              restoreAttachments(staged);
              return false;
            }, false);
          },
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
              `That looked like it could break something and you were away, so I'm holding it rather than sending it to ${aim.name}. I'll bring it back when you return.`,
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
            restoreDraft(text);
            restoreAttachments(staged);
            postSparkle(`Okay — I didn't send that to ${aim.name}.`);
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
      askSparkle(payload);
      const here = stillThere ? aim : null;
      setReceipt(id, {
        target: "sparkle",
        agentName: here?.name,
        agentId: here?.agentId,
        redirectable: true,
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
      enqueue,
      postSparkle,
      announce,
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
    (text: string, mentions?: ConciergeMention[]): Promise<boolean> => {
      // The capture-Chat aim, consumed HERE for the same reason the aim itself is: everything that
      // must reflect SUBMIT happens synchronously, so a handoff landing while this send is still
      // queued cannot retroactively redirect it.
      const forceSparkle = forceSparkleRef.current;
      forceSparkleRef.current = false;
      // THE ADDRESSED AGENT, if the user named one. The FIRST mention only: a message goes to one
      // terminal, and fanning it out to several would multiply an irreversible action across agents
      // the user named in one sentence — every extra name is still drawn as a pill in the bubble, so
      // nothing is hidden, and the receipt names the one that was actually used. (A deliberate
      // multi-send belongs behind its own affordance, not behind a comma.)
      //
      // Resolved against the LIVE roster, so a mention naming an agent that has since closed simply
      // fails to resolve and the message falls back to the auto-router — the recoverable direction,
      // and the same answer `deliver` gives when an aim goes missing mid-flight.
      const named = mentions?.[0];
      const mentionedAgent = named
        ? mentionAgentsRef.current.find((a) => a.id === named.agentId)
        : undefined;
      // Same courtesy the agent composer extends: honor the pause-on-submit voice setting so the
      // mic does not keep transcribing the room while the send is handled.
      maybePauseOnSubmit();
      const id = nextId("you");
      // A named agent OVERRIDES what happens to be selected — that is the whole point of naming one.
      const submitted: ConciergePromptTarget | null = mentionedAgent
        ? {
            projectId: mentionedAgent.projectId,
            agentId: mentionedAgent.id,
            name: mentionedAgent.name,
          }
        : targetRef.current;
      // IS THIS A PICKER ANSWER? Asked BEFORE the payload is built, because the answer changes how
      // it is built. The prefix `attachedPayload` adds is quoted temp paths, and every arm of
      // `matchAnswerToOption` is anchored — so with a file staged and a picker on screen, "Yes"
      // arrives as `"/var/folders/…/shot.png" Yes`, matches nothing, and comes back
      // `ambiguous-picker`. The box then restores the draft AND the chips, so retyping reproduces
      // it exactly: a loop whose only exit is guessing that the attachments are the problem, which
      // the refusal copy never says.
      //
      // So a terse answer to a live picker sends UNPREFIXED and KEEPS its attachments staged for
      // the next message. Holding them is the honest half: the picker answer is a keystroke, not a
      // message that could carry a file, so consuming them would silently cost the user the picking
      // for nothing. The chips stay on screen, which is also the only signal that they weren't sent.
      //
      // NEVER for an addressed message. `matchAnswerToOption` matches terse text against whatever
      // picker is on the agent's screen, and a message that names its recipient is a MESSAGE — the
      // user wrote a sentence at an agent, not a keystroke at a menu. Letting "@Kraken Auth yes"
      // collapse into pressing "yes" on some unrelated prompt would answer a question they never
      // read, which is the least recoverable thing this column can do.
      const answersPicker =
        !mentionedAgent && !!submitted && answersLivePicker(submitted.agentId, text);
      // Take the staged files in the SAME tick the text leaves, so the next message starts clean
      // and a second Send can't deliver the same attachments twice.
      const staged = answersPicker ? [] : takeAttachments();
      // THREE renderings of one message, exactly as the removed composer built them:
      //   payload — the attachments' real paths prefixed to the text, for the PTY only;
      //   display — the typed text plus compact counts, for the thread AND every prompt-history
      //             surface (the pinned header, the history dropdown);
      //   text    — what the user actually typed, for naming, the ghost-text corpus, and what the
      //             ROUTER classifies. Empty on an attachments-only send.
      // The temp paths must never reach any of them but the first (roborev 46911/46925).
      const payload = attachedPayload(text, staged);
      const display = attachedDisplay(text, staged);
      // A FOURTH rendering, and only when the message is addressed: the same thing with the `@…`
      // address taken off. It is a separate rendering rather than a change to `payload` because
      // `payload` still has to carry the address everywhere else — Sparkle answering the message
      // should see who it was aimed at, and a redirect replays it verbatim. Only the wire into the
      // named agent's own terminal drops it (see ConciergeMentionAim).
      //
      // Built from the resolved mentions rather than the whole roster, so it strips exactly the
      // spans that were recognised — no second, laxer notion of what a mention looks like.
      const mentionAim: ConciergeMentionAim | null =
        mentionedAgent && submitted
          ? (() => {
              const wire = mentionFreeText(text, rosterFromMentions(mentions ?? []));
              return { target: submitted, payload: attachedPayload(wire, staged), text: wire };
            })()
          : null;
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
          text: display,
          attachments: staged.length ? staged : undefined,
          // Snapshotted onto the message for the same reason the files are: this bubble is the
          // record of who the message went to, and resolving its pills against the live fleet later
          // would erase them the moment that agent was closed. ALL of them, not just the one that
          // was used — the user wrote those names and should see them back.
          mentions: mentions?.length ? mentions : undefined,
        },
      ]);
      // Remember BOTH: a redirect to the agent must replay the payload (paths included), a redirect
      // to Sparkle must replay the plain text.
      rememberSentText(sentTextRef.current, id, text);
      rememberSentText(sentPayloadRef.current, id, payload);
      return enqueue(
        () => deliver(id, text, payload, display, submitted, staged, forceSparkle, mentionAim),
        false,
      );
    },
    [deliver, enqueue, takeAttachments],
  );

  /** Send an already-routed message the OTHER way. Additive: the first delivery stands (see
   *  RoutingReceipt) — this adds a second one and records that both happened. */
  const redirect = useCallback(
    async (messageId: string) => {
      const text = sentTextRef.current.get(messageId);
      if (!text) return;
      // The AGENT-bound form (attachment paths prefixed). The brain reads paths too, so BOTH
      // directions replay this rather than the bare text; it falls back to `text` for a message
      // that carried no files, where the two are the same string anyway.
      const replay = sentPayloadRef.current.get(messageId) ?? text;
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
          postSparkle(
            `${receipt.agentName ?? "That agent"} isn't open any more, so I couldn't pass the message along.`,
          );
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
              replay,
              { display: text, namingBasis: text },
              [],
              false,
              { kind: "redirect", receiptId: messageId },
              // A redirect replays a message the router already sent elsewhere; it is not an
              // addressed send, so the picker path stays available to it exactly as before.
              false,
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

  const controller = useMemo(
    () => ({
      onSend: send,
      onRedirect: (messageId: string) => void redirect(messageId),
      onAttach: attach,
      onRemoveAttachment: removeAttachment,
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
        const isolated = ui.statusFilter.needs_you && !ui.statusFilter.running && !ui.statusFilter.done;
        if (isolated) ui.showAllStatusBands();
        else ui.isolateStatusBand("needs_you");
      },
      onProjectClick: (projectId: string) => openProjectTab(projectId),
      onNudgeClick: (n: ConciergeNudge) => {
        const a = resolveAgent(n.id);
        // `revealAgent`, not a bare `openProjectTab`: a singleton nested-rowless agent keeps a CARD,
        // and its card click hits exactly the collapse/filter gates the digest line's click had to
        // learn about (roborev 53737).
        if (a) revealAgent(a);
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
        const live =
          d.variant === "rowless"
            ? buildDigest(nestedRowlessAgents(feed), "rowless").groups.find((g) => g.id === d.id)
            : buildDigest(surfacedAgents(feed)).groups.find((g) => g.id === d.id);
        if (!live) return; // resolved out from under the click — open nothing, filter nothing
        // A ROWLESS line REVEALS, it does not NARROW. Its agents have no row of their own, so
        // `isolateStatusBand` has nothing of theirs to leave standing — and worse, it would hide the
        // very row the reveal needs: these are blocked workers under an orchestrator that bands
        // `running`, so isolating `needs_you` removes the head they pop out under.
        //
        // But declining to SET a filter is not enough, and that was the bug (roborev 53734). The
        // line's promise is "click me and see these N", and TWO pieces of pre-existing UI state can
        // silently break it, both of them the default rather than an edge case:
        //
        //   1. COLLAPSE. `uiStore.isOrchestratorCollapsed` reads a missing entry as COLLAPSED, and
        //      `expandOnWorkerAttention` deliberately skips first sighting — so on a fresh launch the
        //      head's subtree is shut. `openProjectTab` selects and mounts the lead but never
        //      expands, so the click gave you a terminal pane above ZERO worker rows.
        //      (These reveals stay NON-auto on purpose — see uiStore.expandOrchestrators: marking
        //      them would let auto-collapse fold every head but the selected one away again.)
        //   2. A LEFTOVER BAND FILTER. The sidebar applies `statusFilter` to heads, so a `running`
        //      orchestrator is not drawn at all if `running` is off — which a previous *rows*-
        //      variant digest click turns off, by design.
        //
        // So the click ENFORCES its premise rather than assuming it: show every band, then expand
        // EVERY head the line names. `rowHeadIds` is a list because grouping stays `project::band`
        // — keying it per head instead was tried and reverted, since that fragments the common
        // fleet shape into a card apiece and rebuilds the wall (roborev 53737). One line may span
        // several orchestrators; expanding only the lead's would strand the rest.
        if (live.variant === "rowless") {
          const ui = useUiStore.getState();
          ui.showAllStatusBands();
          // EVERY head the line stands for, not just the lead's: one line can span several
          // in-motion orchestrators, and expanding one of them would strand the rest (roborev
          // 53737). `expandOrchestrators` takes an array for exactly this.
          ui.expandOrchestrators(live.rowHeadIds);
          openProjectTab(live.projectId, live.leadAgentId);
          return;
        }
        // ORDER IS LOAD-BEARING. `isolateStatusBand` narrows whichever project is SELECTED, so
        // selecting first is what makes the filter land on the list the sentence named. Filtering
        // first narrows somebody else's column for the frame in between, which reads as "my agents
        // just vanished".
        openProjectTab(live.projectId, live.leadAgentId);
        // The SAME `statusFilter` the sidebar's own chips write (stores/uiStore.isolateStatusBand),
        // deliberately not a filter of the digest's own: one state means the chips render what the
        // click did, "Show all" clears it like any hand-toggled filter, and the two can never
        // disagree about what column two is showing.
        //
        // The revealed agent is safe from the filter it just turned on: `live.leadAgentId` comes
        // from this band's surfaced set, so the selected row is one the filter keeps.
        useUiStore.getState().isolateStatusBand(live.band);
      },
      onNudgeAction: (n: ConciergeNudge, actionId: string) => {
        const a = resolveAgent(n.id);
        if (!a) return;
        if (actionId === "show") {
          // The card's own affordance has to keep the same promise its click does.
          revealAgent(a);
        } else if (actionId === "approve") {
          void approve(a);
        } else if (actionId === "mute") {
          useSparklePrefsStore.getState().setInterruptPreference(a.id, "mute");
        }
      },
    }),
    // `play` is absent on purpose: voice OUTPUT (TTS) was removed in §5, so main's `play` dep does
    // not survive the merge. `revealAgent` is main's, and stays.
    [resolveAgent, revealAgent, approve, send, redirect, attach, removeAttachment],
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
  const needsYouIsolated = useUiStore(
    (s) => s.statusFilter.needs_you && !s.statusFilter.running && !s.statusFilter.done,
  );

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
    // Never digested — every one of these keeps its own card, because its card is the only way to
    // reach it. See `strandedAgents`.
    const nudges = [...cards, ...rowless.cards, ...strandedAgents(feed)].map(agentToNudge);
    const digests: ConciergeMessage[] = [...groups, ...rowless.groups].map((g) => ({
      id: g.id,
      kind: "digest" as const,
      band: g.band,
      variant: g.variant,
      text: g.text,
      leadAgentId: g.leadAgentId,
    }));
    // Order the whole stream by WHEN EACH ITEM FIRST APPEARED, not by what kind it is. Concatenated
    // as [chat, digests, nudges] only to tie-break items that arrive in the SAME tick; anything
    // already placed keeps its slot (see engine/conciergeStreamOrder for why assign-once matters).
    const stream = orderByArrival(arrivalRef.current, [...chat, ...digests, ...nudges]);
    return {
      scope: { pinnedProjectName },
      vitals: feed.scopedCounts,
      needsYouByProject,
      // In arrival order. This used to be `[...chat, ...digests, ...nudges]`, which pinned every
      // notice below the entire conversation no matter when it arrived — so the digests read as
      // stuck to the bottom of the pane rather than as part of the thread.
      messages: stream,
      typing,
      attachments,
      dropActive,
      needsYouFilter: needsYouIsolated,
    };
  }, [
    feed,
    chat,
    typing,
    pinnedProjectName,
    needsYouByProject,
    attachments,
    dropActive,
    needsYouIsolated,
  ]);

  return (
    <>
      <ConciergeColumn
        model={model}
        controller={controller}
        width={width}
        searchSlot={searchSlot}
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
        // The "@" picker's list, and the roster a typed mention resolves against — relevance-
        // ordered, because that order is what breaks a duplicate-name tie (see the memo).
        mentionAgents={mentionAgents}
        preferredAgentId={routingTarget?.agentId ?? null}
        // A `sparkle-agent:` pill in one of the concierge's own replies was clicked. The SAME
        // reveal the notifications and the command palette use — `openProjectTab` opens the owning
        // project's tab, selects it, clears the Sparkle overlay and reveals the agent. Partial
        // re-implementations of that sequence are what its header warns about.
        onOpenAgent={openAgentFromPill}
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
