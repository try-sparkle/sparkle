// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { resetCable, useCableStore } from "../stores/cableStore";
import type {
  ConciergeDispatchPath,
  ConciergeDispatchResult,
} from "../services/conciergeDispatch";

/** The deferred-outcome shape is the PRODUCTION interface, not a hand-copy of it: `onDeferredSend
 *  Outcome` takes `(r: ConciergeDispatchResult) => void`, so aliasing it means the mock can't drift
 *  from what a real listener receives — a field the ladder later gates on, or `sent` becoming
 *  required, now breaks the mock instead of leaving rows green but unrepresentative (roborev
 *  53162). It also makes `path` the real union, so a `path: "pty-gonw"` typo is a compile error
 *  rather than a row that silently passes through the catch-all `else` (roborev 53142).
 *
 *  The `dispatchConciergeAnswer` mock below keeps its own narrower literal ON PURPOSE — it models
 *  an optional `path`, which the production result does not have. */
type DeferredOutcome = ConciergeDispatchResult;
/** For `importOriginal` in the concierge mock below — the real module's type, so pulling a genuine
 *  export through the factory is checked rather than `any`. */
type Concierge = typeof import("../services/concierge");

// Mock the data feed + the three side-effecting services so we test the HOST's wiring: user send →
// brain, nudge actions → dispatch/select/mute, brain deltas → thread. ConciergeColumn renders for real.
const h = vi.hoisted(() => ({
  feed: null as unknown,
  pickerPressFor: vi.fn((_agentId: string, _text: string): { fingerprint: string } | undefined =>
    undefined,
  ),
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  // `path` is the real union, not bare `string`: typed loosely, a `path: "pty-gonw"` typo compiles
  // and quietly exercises refusalCopy's generic arm while the row's regex still matches the generic
  // line — a test passing on a path production can never produce (roborev 53097). matchedLabel
  // rides along on picker-option; the component renders it, so the mock must carry it.
  // The PARAMETERS are declared too (roborev: the routed suites assert delivery ORDER off
  // `mock.calls.map(c => c[1])`, and an argument-less signature makes every call a zero-length
  // tuple — a compile error at the assertion rather than at the mock, which is the confusing end).
  dispatchConciergeAnswer: vi.fn(
    async (
      _agentId: string,
      _text: string,
      _opts?: { userPrompt?: boolean; display?: string; namingBasis?: string },
    ): Promise<{ ok: boolean; path?: ConciergeDispatchPath; matchedLabel?: string }> => ({
      ok: true,
    }),
  ),
  setInterruptPreference: vi.fn(),
  // The router has its own exhaustive suite (services/conciergeRouter.test.ts). Here it is a knob,
  // so these tests assert what the HOST does with a decision rather than re-testing the decision.
  routeMessage: vi.fn(
    async (_text: string, _ctx: { agent: { id: string; name: string } | null }) => ({
      target: "sparkle" as "sparkle" | "agent",
      reason: "test",
      source: "heuristic" as const,
    }),
  ),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  suggestionMounts: [] as string[],
  suggestionVisible: undefined as boolean | undefined,
  suggestionProps: undefined as
    | {
        onApply: (run: () => Promise<boolean>) => Promise<boolean>;
        onDeliverPrompt: (t: string) => Promise<boolean>;
      }
    | undefined,
  deferred: undefined as ((r: DeferredOutcome) => void) | undefined,
  // The append the host hands the dictation hook — i.e. the ONLY way a spoken segment reaches the
  // compose box. Captured so a row can drive a dictated segment the way the mic does, rather than
  // through the textarea's onChange (which is the HAND-edit path and reports to `onTextEdit`).
  // The distinction is the whole point of the row that uses it: see "a DICTATED segment does not
  // retire the Sparkle aim".
  dictationInsert: null as ((text: string) => void) | null,
  // Stands in for the Rust round trip behind a dropped file. Returns a real-shaped Attachment so a
  // staged drop renders a chip the way it does in the app.
  loadAttachmentPaths: vi.fn(async (paths: string[]) => ({
    attachments: paths.map((path) => ({
      id: `att-${path}`,
      kind: "file" as const,
      path,
      name: path.split("/").pop()!,
    })),
    failed: [] as string[],
  })),
  proactiveIds: new Set<string>(),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
    tool?: (e: { id: string; name: string; input: string }) => void;
  },
}));
// Single-window shell (CM-U7): "show me" is a TAB switch + agent reveal, not a bare select.
// Mirror EVERY export: Vitest throws on access to a missing mock export, so a partial factory
// breaks the moment anything else in the tree imports the other symbol.
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// The fire-and-forget bookkeeping on the dispatch path. Stubbed so these suites do not touch `bd`,
// and so a case can make it REJECT and assert the send survives.
//
// `services/conciergeHistoryCapture` is deliberately NOT stubbed here: it is a subscriber on the
// thread store rather than a call this component makes, so leaving it real is what lets
// "a failing ask queue does not take the history write with it" drive the production wiring end to
// end and spy on the store's sink instead of on a mock.
vi.mock("../services/conciergeAskQueue", () => ({
  captureAsksFrom: vi.fn(async () => ({ filed: [], bumped: [], reasked: [], dropped: 0 })),
  openAsksNow: vi.fn(() => []),
  startAskQueue: vi.fn(() => () => {}),
}));
vi.mock("../services/concierge", async (importOriginal) => ({
  // The REAL sentinels and the REAL matcher, not hand-copies: the host now filters error EVENTS by
  // detail (roborev 53460/53462), so a stubbed list or predicate would let the host and Rust drift
  // while these rows stayed green.
  SUPERSEDED_DETAILS: (await importOriginal<Concierge>()).SUPERSEDED_DETAILS,
  isSupersededDetail: (await importOriginal<Concierge>()).isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
  // The PROACTIVE push channel the host mounts. Stubbed to "the transport stood down", which is
  // both the cheapest answer and a real production outcome (the user owns the conversation), so
  // none of the cases below spend a turn they did not ask for. Its own wiring is covered in
  // ConciergeHost.proactive.test.tsx.
  startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
  // CONTROLLABLE: a push's terminal event must not release a USER turn's slot (roborev 58503), and
  // that cannot be exercised while every id reads as non-proactive.
  isProactiveTurn: (id: string) => h.proactiveIds.has(id),
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  // The typed sticky rejection the dispatch handler branches on — a real class, not a stub, so
  // `instanceof` in the host actually discriminates.
  // FAITHFUL TO PRODUCTION (roborev 58517-M3). This was `class extends Error {}` with no
  // constructor, so `String(err)` was just "Error" — which made the claim that the notice carries
  // the machine's own sentence untestable, AND made the headline assertion pass only because the
  // stub diverged: with the real message, a bare /AI enhancements are off/ matches the headline and
  // the evidence block both, and the query throws on multiple matches.
  ConciergeAiDisabledError: class ConciergeAiDisabledError extends Error {
    constructor() {
      super("AI enhancements are off, so the concierge can't think or act.");
      this.name = "ConciergeAiDisabledError";
    }
  },
  onConciergeTool: (cb: (e: { id: string; name: string; input: string }) => void) => {
    h.brain.tool = cb;
    return () => {};
  },
  onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.delta = cb;
    return () => {};
  },
  onConciergeDone: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: (cb: (e: { id: string; detail: string }) => void) => {
    h.brain.error = cb;
    return () => {};
  },
  onConciergeTurnsAbandoned: () => () => {},
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: h.agentCanAcceptInput,
  agentCanAcceptPrompt: h.agentCanAcceptInput,
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  // The PRESS EVIDENCE the Approve relay must carry when a menu is live (bead sparkle-voudj7).
  // Defaults to `undefined` — "no picker on screen" — which is the state every pre-existing row in
  // this file is in, so they keep asserting the shape they always did.
  pickerPressFor: h.pickerPressFor,
  // Not exercised in these rows (no picker on screen), but the host imports it — and Vitest
  // throws on ACCESS to an export a factory omits, so a partial mock breaks the whole file.
  answersLivePicker: () => false,
  onDeferredSendOutcome: (cb: (r: DeferredOutcome) => void) => {
    h.deferred = cb;
    return () => {};
  },
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
// Only the DISK READ is stubbed; `attachedDisplay`/`attachedPayload` stay real (the spread), because
// the send rows below assert on the payload they build. Without this, `loadAttachmentPaths` hits
// Tauri, rejects under jsdom, and a dropped file silently never becomes a chip — which would let the
// re-homed "+ New Build Agent" drain be asserted only by its queue emptying. Draining without
// staging is precisely the silent loss this change exists to remove (roborev 53836).
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    loadAttachmentPaths: h.loadAttachmentPaths,
  };
});
// The recommended-action row is a keyed child (Concierge/ConciergeSuggestions) with its own
// per-agent hook. Mock it to record the agentId it was mounted with — the HIGH finding in roborev
// 53043 was precisely that this identity was shared across agents.
vi.mock("./Concierge/ConciergeSuggestions", async () => {
  const { useEffect } = await import("react");
  return {
    ConciergeSuggestions: (p: {
      agentId: string;
      agentName: string;
      visible?: boolean;
      onApply: (run: () => Promise<boolean>) => Promise<boolean>;
      onDeliverPrompt: (t: string) => Promise<boolean>;
    }) => {
      h.suggestionVisible = p.visible;
      h.suggestionProps = p;
      // MOUNTS, not renders. Pushing on every render made the key={agentId} assertion inert: a
      // re-rendered single instance would record both ids just as well as two instances, so the
      // one test guarding the irreversible cross-agent misdelivery proved nothing (roborev 53086).
      useEffect(() => {
        h.suggestionMounts.push(p.agentId);
      }, []);
      return <div data-testid="suggestions-row" data-agent={p.agentId} />;
    },
  };
});
// The dictation hook (CM-U9) is mocked in EVERY host test, not just the voice one (roborev 48171):
// the host imports it unconditionally, so without this the base tests run the real hook on every
// simulated send — mutating global dictation state and coupling these tests to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    toggleMic: vi.fn(),
    // Keep the append the host registers, so a row can put a spoken segment in the box through the
    // real seam. `null` on deregistration, exactly as the app does.
    registerInsert: (append: ((text: string) => void) | null) => {
      h.dictationInsert = append;
    },
  }),
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: h.setInterruptPreference }) },
}));
// THE DISPATCH SIDE EFFECT, stubbed so the auto-dispatch effect can be OBSERVED rather than actually
// spawning a metered research child. Every other export is preserved. Two consumers reachable from
// THIS file's module graph call it, so the stub covers both: the host's own auto-dispatch effect,
// and `conciergeTools/registry`'s `dispatch` route (registry.ts:242/1780, reached via the real
// `services/concierge` import). It does NOT touch other suites — a `vi.mock` is file-scoped. The
// file-level `afterEach` re-establishes a success default after `resetAllMocks`, because the registry
// route reads `.ok` and would throw on `undefined`. The auto-dispatch rows at the bottom of this file
// assert this mock was CALLED — the wiring the pure-decider test cannot see.
vi.mock("../services/conciergeTools/research", async (orig) => ({
  ...(await orig<typeof import("../services/conciergeTools/research")>()),
  dispatchResearchTask: vi.fn(),
}));

// TRIAL_SPENT_TEXT is IMPORTED, not re-declared: both voices are supposed to return this exact
// string, and asserting the literal on each side is what pins that they stay shared. A hand-synced
// copy here would turn a wording tweak into a red test for a non-bug (roborev 53044).
import { ConciergeHost, TRIAL_SPENT_TEXT } from "./ConciergeHost";
import { captureAsksFrom } from "../services/conciergeAskQueue";
import { useHistoryStore } from "../stores/historyStore";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
} from "../services/conciergeActivity";
import { MESSAGE_STATUS_TESTID } from "./Concierge/MessageStatus";
import { FAILURE_EVIDENCE_TESTID } from "./Concierge/ConciergeMessageRow";
// WHERE A ROUTED MESSAGE NAMES ITS DESTINATION NOW. It used to be a "→ Sent to X" line BELOW the
// bubble; the founder moved it inside the black sent card (see Concierge/SentToAgentRow), so the
// cases below settle on this row instead of on that sentence. The sentence itself is not gone — it
// is still what the column's live region ANNOUNCES, which is why the announcer assertions are
// untouched and still quote it verbatim.
import { SENT_TO_AGENT_TESTID } from "./Concierge/SentToAgentRow";
// The REAL seam the relay-stamp suite drives, rather than a mock of it: the production effect
// subscribes to this module, so recording here is the same event the settler emits.
import {
  currentConciergeTurnOrigin,
  recordConciergeActionReceipt,
  type ConciergeActionReceipt,
} from "../services/conciergeReceipts";
import { ConciergeAiDisabledError } from "../services/concierge";
import { MAX_QUEUED_TURNS } from "../engine/conciergeTurnQueue";
// THE APP-WIDE SEAM the queue depth is published through — the real store, not a mock, because the
// defect being pinned is precisely that the depth never left this component.
import { useConciergeQueueStore } from "../stores/conciergeQueueStore";
// THE PUSHER'S REAL ROUTE TO THE CONCIERGE — the registration the host makes in its own effect, not
// a mock of it. `pusherMount.sendVerified` makes this exact call, so the fold cases below drive the
// production seam rather than a stand-in for it.
import { notifyConcierge } from "../services/conciergeNotifier";
import * as conciergeNotifierModule from "../services/conciergeNotifier";
import { dispatchResearchTask } from "../services/conciergeTools/research";
import { useResearchStore } from "../services/research/store";
import { ANSWERED_MARKER_TESTID } from "./Concierge/ReplyAnchorViews";
import {
  THINKING_ACTIVITY_TESTID,
  THINKING_INDICATOR_TESTID,
} from "./Concierge/ThinkingIndicator";
// Through the mock above, which re-exports the REAL array — so these rows use the same literals the
// host filters on and the same ones Rust emits.
import { SUPERSEDED_DETAILS } from "../services/concierge";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";
// The REAL stores, not mocks: the recap rows below assert the host's wiring between them, and a
// stubbed presence store would let the subscription contract drift without a row going red.
import { usePresenceStore } from "../stores/presenceStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTabStatus } from "../types";
import {
  armedIntents,
  clearAllIntents,
  fireIntent,
  queuedIntents,
} from "../services/dispatchIntent";
// The capture handoff rows at the bottom of this file drive the REAL dispatch entry points against
// the REAL stores. That is the point: the bug being fixed was a producer writing to a store with no
// reader, so a suite that hand-built the store write would have gone green against the broken code.
// Only the whole chain — dispatchBuild/dispatchChat → composeHandoffStore → this host → the box —
// can tell the two apart.
import { dispatchBuild, dispatchChat } from "../services/captureSends";
import { useProjectStore } from "../stores/projectStore";
import { MOUNTED_THREAD_TESTID } from "./Concierge/MountedAgentThread";
import { CONCIERGE_THREAD_TESTID } from "../engine/composeBoxHeight";
// The cable's projected side joins three stores; the pair assignment lives here.
import { useUiStore } from "../stores/uiStore";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
// The LOGGER, not `console`: logger.ts binds its `realConsole` at module load, so a console spy
// installed later never sees these lines — a row asserting on one would pass against silent code.
import { log } from "../logger";
import type { Project } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { PINNED_BLOCKERS_TESTID, PINNED_BLOCKER_TESTID } from "./Concierge/PinnedBlockers";
import { NUDGE_CARD_TESTID } from "./Concierge/NudgeCard";
import { ANONYMOUS_SUBJECT } from "./Concierge/conciergeLine";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);
// `proactiveIds` is MODULE-level harness state, so a case that marks an id proactive leaks it into
// every case after it — mine did, and reddened an unrelated cap case that passed in isolation.
// Cleared here rather than at the end of the one case that writes it: the next writer will forget.
beforeEach(() => h.proactiveIds.clear());

const EMPTY_COUNTS: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 0, done: 0 };

/** A one-agent feed. The band defaults to `needs_you` because that IS the surfacing gate — an agent
 *  in any other band produces no nudge card, which is what the `done` case below pins. */
function feedWith(status: string, band: StatusBand = "needs_you", statusLabel = "Approve?") {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status,
    statusColor: "#e0533f",
    statusLabel,
    band,
    inScope: true,
    muted: false,
    // A parentless build agent — it gets a row of its own in column two, which is what the
    // surfacing gate now also requires (see ConciergeHost.surfacedAgents).
    topLevel: true,
    // Nothing above it in the tree, so no ancestor row can be speaking for it.
    representedElsewhere: false,
    // Spelled out rather than left off: this suite casts feeds through `as unknown as
    // ConciergeFeed`, so an omitted field is silently `undefined` instead of a compile error — and
    // `rolledUpGreen` reads as false when absent, which is the value that makes the recap's
    // double-count guard look like it works. See the promoted-head rows at the end of this file.
    rolledUpGreen: false,
  };
  const counts = { needs_you: 0, questions: 0, running: 0, done: 0, [band]: 1 };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  };
}

afterEach(() => {
  cleanup();
  // Presence is app-global state, so a row that goes Away would leak into the next one.
  usePresenceStore.getState().reset();
  useRuntimeStore.setState({ status: {} });
  // Armed sends are a MODULE-level registry, so one left counting down would fire inside the next
  // test and dispatch into its mocks. Silent by contract — this is teardown, not a user cancel.
  clearAllIntents();
  h.suggestionMounts = [];
  h.suggestionVisible = undefined;
  h.suggestionProps = undefined;
  // resetAllMocks, NOT clearAllMocks: clear leaves any UNCONSUMED `…Once` implementation sitting in
  // the queue, where it silently becomes the NEXT test's first answer. Resetting everything (rather
  // than a hand-maintained list) means a mock added later can't reintroduce that leak by omission.
  vi.resetAllMocks();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.dispatchConciergeAnswer.mockResolvedValue({ ok: true });
  h.startConciergeTurn.mockResolvedValue(null);
  h.agentCanAcceptInput.mockReturnValue(true);
  // Same reason as the mocks above: `resetAllMocks` strips this stub's implementation, and it has
  // TWO consumers reachable from this file's graph — the host's auto-dispatch effect AND
  // `conciergeTools/registry`'s `dispatch` route (registry.ts:242/1780, reachable via the real
  // `services/concierge` import). A row driving the tool route against a reset mock would get
  // `undefined` back and throw on `.ok`, so re-establish a benign success here.
  vi.mocked(dispatchResearchTask).mockResolvedValue({
    ok: true,
    op: "dispatch",
    risk: "routine",
    data: { id: "r0" },
  } as never);
  // The auto-dispatch effect mounts in EVERY row of this file and reads this app-global zustand
  // store; a row that seeded a live task (the "served" case below) would otherwise leak it forward
  // and silently satisfy the `served` short-circuit for the next describe (the sparkle-rvf6n shape).
  useResearchStore.setState({ byId: {}, hydrated: false, openTaskId: null } as never);
  // resetAllMocks above strips this one's implementation too, and an undefined return here is not a
  // quiet no-op: `attachPaths` calls `.then` on it and the whole passive effect throws.
  h.loadAttachmentPaths.mockImplementation(async (paths: string[]) => ({
    attachments: paths.map((path) => ({
      id: `att-${path}`,
      kind: "file" as const,
      path,
      name: path.split("/").pop()!,
    })),
    failed: [] as string[],
  }));
});

/** Point the router at the agent for the next send(s). The router itself is exhaustively tested in
 *  services/conciergeRouter.test.ts; here it is a knob. */
function routeToAgent() {
  h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
}

/** Let the queued send finish. Routing is async now (tier 2 is a network round trip) and every
 *  delivery chains behind the previous one, so nothing lands in the same tick as the click. */
async function settle() {
  await flush();
  await elapseCountdowns();
}

/**
 * Let routing resolve, and STOP THERE — before any countdown elapses.
 *
 * The half of `settle` that suites about the GATE need: they assert on the armed intent, which
 * `settle` would already have fired. Split out rather than inlined so "routing has resolved" and
 * "the send has landed" stay two distinct, nameable moments — the whole point of the change is that
 * they are no longer the same one.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Let every armed send's countdown run out.
 *
 * `deliver` no longer dispatches on the router's verdict — it ARMS an intent (services/
 * dispatchIntent) that the user gets 3s (5s destructive) to cancel, and only an uncancelled expiry
 * delivers. So "the send settled" now includes "the countdown elapsed", and a suite asserting on
 * DELIVERY has to pass through it. That is the behaviour change, not a testing workaround: the
 * assertions below still prove the text reaches the terminal, they now also prove it only gets
 * there by way of the gate.
 *
 * Fires the intents directly rather than advancing timers, so these suites keep real timers and
 * their existing microtask flushing.
 */
async function elapseCountdowns() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    // Generously many: the expiry re-enters the send QUEUE and the delivery it runs is several
    // awaits deep (promptAgent → dispatchConciergeAnswer → the outcome ladder), so too few ticks
    // here shows up as a delivery that "did not happen" rather than as a timing failure.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const thread = () => screen.getByTestId("concierge-thread");
// …AND THE PINNED ALERT STRIP COUNTS AS VISIBLE TOO. Since 2026-08-07 a LIVE blocker is not in the
// transcript at all — the founder asked for blockers pinned above the composer so they cannot
// scroll away — so its Approve/Mute/[x] are outside `thread()`. These helpers therefore search the
// transcript FIRST and the pinned strip second, which keeps every existing case meaning what it
// meant (act on what the reader can see) without re-pointing each one at a surface the case was
// never about. The hidden `role="status"` region is still excluded, which was the whole reason for
// scoping in the first place.
const pinnedZone = () => screen.queryByTestId(PINNED_BLOCKERS_TESTID);
const inThread = (re: RegExp | string) => {
  const hit = within(thread()).queryByText(spans(re));
  if (hit) return hit;
  const pinned = pinnedZone();
  // Falls back to the thread's own getByText when there is no strip, so a genuine miss still fails
  // with the transcript in the message rather than with "no pinned zone".
  return pinned ? within(pinned).getByText(spans(re)) : within(thread()).getByText(spans(re));
};
/** Match a concierge line that is SPLIT ACROSS ELEMENTS.
 *
 *  Every app-authored line names its agent as an agent pill — a `<button>` inside the sentence — so
 *  a receipt is no longer one text node and the default `findByText` cannot see it whole. These
 *  match on the tightest element whose `textContent` satisfies the pattern; an ancestor that merely
 *  CONTAINS it is rejected, which is what keeps the `^…$` anchors in these tests meaningful (several
 *  of them exist specifically to stop one refusal string matching another's prefix). */
const spans = (re: RegExp | string) => (_t: string, el: Element | null) => {
  if (!el) return false;
  const text = el.textContent ?? "";
  const hit = typeof re === "string" ? text === re : re.test(text);
  if (!hit) return false;
  return !Array.from(el.children).some((c) => {
    const kid = c.textContent ?? "";
    return typeof re === "string" ? kid === re : re.test(kid);
  });
};
const findInThread = async (re: RegExp | string) => {
  // RE-READ BOTH SURFACES ON EVERY POLL. Sampling the strip once up front is wrong for an ASYNC
  // matcher: `PinnedBlockers` renders `null` while nothing is live, so `pinnedZone()` is `null` for
  // any case awaiting content that arrives there a tick later — and the lookup would then wait out
  // its full timeout against the transcript, failing with a message pointing at the wrong surface
  // (roborev 60158). The sync helpers are fine because they re-read at call time.
  let found: HTMLElement | null = null;
  await waitFor(() => {
    const pinned = pinnedZone();
    found =
      within(thread()).queryByText(spans(re)) ??
      (pinned ? within(pinned).queryByText(spans(re)) : null);
    expect(found).not.toBeNull();
  });
  return found!;
};
const queryInThread = (re: RegExp | string) => {
  const hit = within(thread()).queryByText(spans(re));
  if (hit) return hit;
  const pinned = pinnedZone();
  return pinned ? within(pinned).queryByText(spans(re)) : null;
};

/**
 * THE RENDERED CAPTION — the observed activity line, wherever it legitimately lives.
 *
 * Every case below that reads this is pinning the same COMPOSED PATH: event → supersede gate →
 * activity store → `conciergeActivityLine` → a caption on screen. None of them is about which box
 * the caption is drawn in. That distinction stopped being academic with sparkle-9ciay: the founder's
 * rule is that the rail beside the compose box carries only what is about the concierge AS A WHOLE,
 * so an observed line — which always describes the turn running for one bubble — now renders UNDER
 * that bubble, and the rail carries it only when there is no bubble to attach it to. Showing it in
 * both places at once was the bug (ConciergeThread.statusOwnership.test.tsx).
 *
 * So this reads the rail first and the running message second, and every assertion below is
 * unchanged in what it claims. `[data-live]` is what separates the observed line from a QUEUE
 * POSITION ("3rd in line"), which is a different kind of status that can be on screen at the same
 * time and is not what any of these cases mean by the caption.
 */
function caption(): string {
  const rail = document.querySelector(`[data-testid="${THINKING_ACTIVITY_TESTID}"]`);
  if (rail) return rail.textContent ?? "";
  const live = document.querySelector(`[data-testid="${MESSAGE_STATUS_TESTID}"][data-live]`);
  if (!live) throw new Error("no activity caption on screen, in either surface");
  return live.textContent ?? "";
}

describe("ConciergeHost", () => {
  it("surfaces an in-scope needing agent as a nudge with an Approve action", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.getAllByText(/CI Hardening/).length).toBeGreaterThan(0);
    expect(inThread("Approve")).toBeTruthy();
    // NO "Show me" any more — the card names the agent as a clickable `AgentPill`, and a button
    // that navigates to the same place is the same affordance twice (founder, 2026-07-30). The
    // pill's own reveal is asserted below.
    expect(queryInThread("Show me")).toBeNull();
  });

  it("Approve relays the answer into the agent's terminal", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // Approve goes through the SAME delivery queue as a compose send now, so it lands a few
    // microtasks later rather than in the click's own tick (roborev 53119).
    await settle();
    // userPrompt: false — "approve" is machine-authored; it must not enter prompt history,
    // debit a trial prompt, or feed the auto-name ladder (roborev 46251-H1).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", {
      // The user clicked Approve on the nudge card — that click IS the authorization.
      authority: { kind: "nudge-approve", agentId: "ag1" },
      userPrompt: false,
      // No menu on screen in this fixture, so there is no press to evidence and the relay carries
      // nothing — the pre-sparkle-voudj7 behaviour, unchanged for the non-picker case.
      pickerPress: undefined,
    });
    expect(h.openProjectTab).not.toHaveBeenCalled();
  });

  // ══ APPROVE PRESSES THE PICKER; IT DOES NOT TYPE AT IT (bead sparkle-voudj7) ══════════════════
  // THE FOUNDER'S BUG, at the layer that caused it. He pressed Approve eight times on an agent
  // showing a Claude Code picker and got the same refusal each time: "…is in a full-screen app right
  // now, so I didn't send the approval… Quit it and approve again." The "full-screen app" was that
  // agent's own picker — nothing of his to quit, and quitting it would have discarded the question.
  //
  // The cause was here, in the relay's ARGUMENTS: it sent "approve" as ordinary text with no
  // `pickerPress`, so the dispatcher's alternate-screen guard refused it. The waiver that makes a
  // press legal already existed (`sparkle-jk8zt`) and this call site never used it — which is
  // exactly why this row lives at the HOST rather than only in the dispatcher's own suite. Every
  // dispatcher-level test passes with this argument deleted; only this one goes red.
  it("carries the live picker's fingerprint, so the press is not refused as a full-screen app", async () => {
    h.pickerPressFor.mockReturnValue({ fingerprint: "fp-of-the-menu-on-screen" });
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    await settle();

    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "approve",
      expect.objectContaining({ pickerPress: { fingerprint: "fp-of-the-menu-on-screen" } }),
    );
    // Read against the SAME agent and the SAME word the relay sends — a fingerprint derived for a
    // different agent, or for different text, would be evidence about the wrong screen.
    expect(h.pickerPressFor).toHaveBeenCalledWith("ag1", "approve");
  });

  // Approve sits behind the queue now, so a click during a still-routing send produces no
  // immediate delivery — and with no feedback the natural reaction is to click again. A second
  // queued approve lands AFTER the picker has been answered, where it answers whatever comes next
  // or is typed as free text (roborev 53119).
  it("a double-tap on Approve dispatches once, and acknowledges the click immediately", async () => {
    h.feed = feedWith("approval");
    let release: (() => void) | undefined;
    h.dispatchConciergeAnswer.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // The acknowledgement is synchronous — that is what makes the second click unnecessary.
    expect(inThread(/Approving @CI Hardening…/)).toBeTruthy();
    fireEvent.click(inThread("Approve"));
    await settle();
    await act(async () => { release?.(); await Promise.resolve(); });
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  it("the agent PILL opens the source project's TAB and selects the agent", () => {
    // What "Show me" used to do, now carried by the thing that names the agent. Routed through the
    // card's own reveal rather than the pill context's plainer opener, because this card usually
    // names a WORKER and a worker's row has to be un-hidden before the reader can see it.
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // The pill now lives on the PINNED strip, not in the transcript — the card moved, the
    // affordance did not change.
    // The pill now lives on the PINNED strip rather than in the transcript — the surface moved,
    // the affordance did not. Scoped to the strip so this cannot start matching some other pill.
    fireEvent.click(
      within(screen.getByTestId(PINNED_BLOCKER_TESTID)).getByTestId("concierge-agent-pill"),
    );
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
  });

  it("does NOT surface an agent whose band is `done` — that includes `unmerged`", () => {
    // The regression this pins: 27 of 51 agents on the reported fleet were committed-but-unlanded.
    // Surfacing the `done` band is 27 nudge cards nobody can dismiss.
    h.feed = feedWith("unmerged", "done");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.queryByTestId(NUDGE_CARD_TESTID)).toBeNull();
  });

  it("surfaces `blocked` — it bands Needs-you now, with the same red as an approval", () => {
    h.feed = feedWith("blocked");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // ONE red treatment, stated once — the card's lead word — and never a "P1" badge in a second
    // alarm color. (`blocked` used to render its own amber tier; that tier is gone.)
    // PINNED, not threaded — the surface moved on 2026-08-07; the treatment did not.
    expect(screen.getByTestId(PINNED_BLOCKER_TESTID)).toBeTruthy();
    expect(inThread("BLOCKED:")).toBeTruthy();
    expect(screen.queryByText("P1")).toBeNull();
  });

  it("Mute records a do-not-interrupt preference for the agent", () => {
    h.feed = feedWith("blocked");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // Mute is an icon control on the card's one line now rather than a labelled button, and it is
    // ALWAYS rendered (painted on hover) precisely so it stays reachable like this — by its
    // accessible name, without a pointer. Dropping it would have deleted the do-not-interrupt
    // feature outright: this is its only call site in the app.
    fireEvent.click(screen.getByLabelText("Mute alerts about CI Hardening"));
    expect(h.setInterruptPreference).toHaveBeenCalledWith("ag1", "mute");
  });

  // ══ BOOKKEEPING MAY NEVER COST THE SEND (roborev 61903, and the regression it followed) ════════
  // Fire-and-forget bookkeeping sits on the dispatch path directly ahead of `startConciergeTurn`. A
  // SYNCHRONOUS throw from it does not lose a history row or a bead — it aborts the send, and the
  // founder's message is silently never delivered. That shipped once: an unguarded
  // `crypto.randomUUID()` hung the queue-drain path.
  //
  // THE HISTORY HALF OF THIS MOVED (the sparkle-yd1ud × sparkle-s7rfc merge). There used to be a row
  // here making `recordConciergePrompt` throw and asserting the turn still started. That call no
  // longer exists: concierge history is captured by `services/conciergeHistoryCapture`'s subscriber
  // on the thread store, so it is not on the dispatch path at all and cannot cost the send by
  // construction. Its successor is `conciergeHistoryCapture.test.ts` ("a throwing sink does not
  // break the conversation", the `record: boom` row) — the equivalent invariant at the new location,
  // where the reachable damage is a throw escaping zustand's listener chain and failing the render.
  // What remains here is the ask-queue half, below.
  //
  // The module-local "capture does not throw" tests could not guard this on their own. They assert
  // the fix's CURRENT LOCATION, so moving the guard, or adding another bookkeeping call beside it,
  // brings the regression back with a fully green suite — the vacuous shape AGENTS.md calls the #1
  // fleet-wide finding. These rows assert the SIDE EFFECT instead: the turn still starts.
  //
  // A REJECTION, not a synchronous throw (roborev 61937). `captureAsksFrom` is `async` and catches
  // its own body, so it can never throw synchronously — a test that made it do so would pin a shape
  // the wire cannot produce, which is the same vacuity this file is otherwise careful about. The
  // reachable failure is a rejected promise (or a throw from `postSparkle` inside the `.then`),
  // and neither is caught by an enclosing `try`.
  //
  // ASSERT THE CONTAINMENT, NOT JUST THE SEND (roborev 61987). A rejection is ASYNCHRONOUS, so it
  // never entered the old shared `try` and never interrupted the statement below it either: a row
  // that only checks `startConciergeTurn` (or only the sibling history write) is green against the
  // shape it claims to have replaced, which proves nothing about the fix. The one thing `bookkeep`'s
  // promise arm actually adds is that the rejection is CAUGHT AND LOGGED instead of escaping as an
  // unhandled rejection — so that warn line is what has to be asserted. Delete `void
  // result.catch(warn)` and this row goes red; the `startConciergeTurn` count alone does not.
  it("still sends the message when the ask queue REJECTS — and CONTAINS the rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(captureAsksFrom).mockRejectedValueOnce(new Error("bd is not available"));
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ask capture failed"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The independence half — the history row survives a failing ask queue. NOTE what this row can and
  // cannot prove (roborev 61987): the rejection is asynchronous, so a single shared `try` would ALSO
  // have left the history write reachable. What makes it non-vacuous is the paired warn assertion:
  // the ask-capture failure has to be OBSERVED (contained and logged) in the same turn that the
  // history write lands, so a regression that drops the promise arm cannot pass by leaving the
  // rejection unhandled and the sibling write incidentally intact.
  //
  // IT SPIES ON THE STORE, NOT ON A MOCKED MODULE (sparkle-yd1ud × sparkle-s7rfc). The write is no
  // longer a call the component makes; it is `conciergeHistoryCapture`'s subscriber reacting to the
  // bubble. `conciergeHistoryCapture` is deliberately NOT mocked in this file, so what runs here is
  // the real production wiring — mount, subscribe, bubble, record — with only the sink swapped. That
  // is also the only thing that still covers the `useEffect` that starts it: delete that line and
  // this row goes red.
  it("a failing ask queue does not take the history write with it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      vi.mocked(captureAsksFrom).mockRejectedValueOnce(new Error("bd is not available"));
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "prompt",
          source: "concierge",
          text: "what needs me?",
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ask capture failed"),
        expect.any(Error),
      );
    } finally {
      record.mockRestore();
      warn.mockRestore();
    }
  });

  // roborev 61961: both notices exist so the cap and the disagreement are NOT concealed, so one of
  // them failing must not swallow the other. Grouped under a single guard, a throw from the
  // `dropped` post skips every `reasked` line below it — concealment produced by the disclosure.
  //
  // THE DROPPED POST HAS TO ACTUALLY FAIL (roborev 61987). A resolved `{dropped: 2}` posts both
  // notices happily, so asserting the re-ask line proves only that the happy path renders — green
  // against the grouped shape this row exists to forbid. `dropped` is therefore a value that passes
  // the `> 0` gate via `valueOf` and then THROWS from `toString`, which is where the notice's
  // `String(out.dropped)` reads it: the failure lands inside the `dropped` guard and nowhere else.
  it("a failing dropped-ask notice does not swallow the re-ask notices", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const explodingCount = {
        valueOf: () => 2,
        toString: () => {
          throw new TypeError("the count cannot be rendered");
        },
      } as unknown as number;
      vi.mocked(captureAsksFrom).mockResolvedValueOnce({
        filed: [],
        bumped: [],
        reasked: [
          {
            closedBeadId: "sparkle-closed1",
            beadId: "sparkle-fresh1",
            ask: {
              key: "ask-1",
              sentence: "build ten homepage designs",
              turnId: "t",
              at: 1,
            },
          },
        ],
        dropped: explodingCount,
      });
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      // The sibling notice really did fail — otherwise the row below proves only that both posts
      // succeeded, which is the vacuity this comment is about.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped-ask notice failed"),
        expect.any(TypeError),
      );
      // …and the re-ask notice, which names the closed bead, survived it.
      expect(inThread(/sparkle-closed1/)).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });

  // …AND THE SAME GUARD, ONE LEVEL DOWN (roborev 62016). The row above pins that `dropped` cannot
  // swallow `reasked`, but it says nothing about whether the re-ask notices are guarded FROM EACH
  // OTHER. `bookkeep("re-ask notice", …)` sits INSIDE `for (const r of out.reasked)` precisely so
  // one unrenderable re-ask cannot take the rest of the list with it — and with a single
  // always-succeeding entry, per-iteration wrapping and one guard around the whole loop are
  // indistinguishable. So: TWO entries, the FIRST one throwing.
  //
  // The throw has to land inside that iteration's guard and nowhere else, which rules out an
  // exploding `closedBeadId` — `plain()` stores it and `toString` would fire at RENDER, outside
  // `bookkeep` entirely. `oneLine` (components/promptHistory.ts) is a bare `text.replace(…)`, so a
  // `sentence` whose `replace` throws fails synchronously at the notice's own call site.
  it("a failing re-ask notice does not swallow the re-ask notices after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unrenderableSentence = {
        replace: () => {
          throw new TypeError("the sentence cannot be collapsed");
        },
      } as unknown as string;
      vi.mocked(captureAsksFrom).mockResolvedValueOnce({
        filed: [],
        bumped: [],
        reasked: [
          {
            closedBeadId: "sparkle-closed1",
            beadId: "sparkle-fresh1",
            ask: { key: "ask-1", sentence: unrenderableSentence, turnId: "t", at: 1 },
          },
          {
            closedBeadId: "sparkle-closed2",
            beadId: "sparkle-fresh2",
            ask: { key: "ask-2", sentence: "build ten homepage designs", turnId: "t", at: 2 },
          },
        ],
        dropped: 0,
      });
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      // The FIRST notice really did fail, and `bookkeep` named the unit — a single `try` around the
      // loop would log one generic failure instead, so the name is what distinguishes the shapes.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("re-ask notice failed"),
        expect.any(TypeError),
      );
      // …and the SECOND iteration still ran. Hoisting the guard out of the loop turns this red.
      expect(inThread(/sparkle-closed2/)).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });

  // …and the same, the other way round — the row that made a SYNCHRONOUS bookkeeping call throw and
  // asserted `bookkeep` names the unit ("history capture failed"), rather than one shared `try`
  // logging a single generic line for whichever call died first (roborev 61987).
  //
  // GONE WITH ITS SUBJECT (sparkle-yd1ud × sparkle-s7rfc), not quietly dropped. The history write it
  // threw from is no longer a call on this path — see the merge note above — and `captureAsksFrom`
  // is `async` and catches its own body, so nothing on the dispatch path can throw synchronously any
  // more. Making one do so would pin a shape the wire cannot produce, which is precisely the vacuity
  // this file is otherwise careful about.
  //
  // The property it guarded — per-call `bookkeep` wrapping, so one failing unit cannot swallow the
  // next — is still pinned, by "one failing notice does not conceal the other" below: that row runs
  // two sync `bookkeep` units in sequence, fails the first, and asserts the second still ran.

  it("sending a message starts a brain turn with a grounded snapshot", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    const snapshot = h.startConciergeTurn.mock.calls[0]![0];
    expect(snapshot).toContain("CI Hardening");
    expect(snapshot).toContain("what needs me?");
    // the user's message shows in the thread
    expect(inThread("what needs me?")).toBeTruthy();
  });

  it("streams a brain reply into the thread (delta then done)", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(inThread("On it.")).toBeTruthy();
    act(() => h.brain.done?.({ id: "7", text: "On it — approving CI Hardening." }));
    expect(inThread("On it — approving CI Hardening.")).toBeTruthy();
  });

  // ══ WHAT IS ON SCREEN IS IN THE INDEX, INCLUDING ON THE FAILURE PATH (roborev 62934/62935) ═════
  // Two rows, and together they are the whole contract between this component and
  // `conciergeHistoryCapture`. The capture waits for a brain bubble to stop growing before indexing
  // it — otherwise it indexes the first token chunk and the sink's INSERT OR IGNORE makes that
  // permanent. This component is what tells it when growing has stopped, so the marker has to be
  // driven from HERE to be worth anything: asserting `streamEnded` on a hand-built fixture in the
  // capture's own suite proves the capture reads the field, never that anything ever writes it.
  //
  // These spy on the real `historyStore` sink with `conciergeHistoryCapture` left unmocked, so what
  // runs is delta → upsert → store write → subscriber → record.
  it("indexes a streamed reply at its FINAL text, not at its first chunk", () => {
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      act(() => h.brain.delta?.({ id: "7", text: "On " }));
      act(() => h.brain.delta?.({ id: "7", text: "it." }));
      // NOTHING yet — the reply is still arriving. This is the half that goes red if the capture
      // finalises on first sight, which is what it used to do.
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response" }),
      );
      act(() => h.brain.done?.({ id: "7", text: "On it — approving CI Hardening." }));
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "response",
          source: "concierge",
          text: "On it — approving CI Hardening.",
        }),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("indexes the partial text of a reply the brain ABANDONED, which stays on screen", () => {
    // A turn that fails mid-stream keeps whatever it painted (ConciergeMessage's ABANDONED FRAGMENT
    // note) — so the founder can scroll back to it, and a search that cannot find it is the exact
    // "we never captured it" confusion the concierge history exists to remove. `markStreamEnded` in
    // `offError` is what closes it; delete that call and this row goes red while the row above stays
    // green, which is why the two are separate.
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      act(() => h.brain.delta?.({ id: "7", text: "I'll get that st" }));
      act(() => h.brain.error?.({ id: "7", detail: "You've hit your session limit" }));
      expect(inThread("I'll get that st")).toBeTruthy();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response", text: "I'll get that st" }),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("indexes the partial text of a reply a newer SEND abandoned — with no terminal event at all", async () => {
    // NO TERMINAL EVENT AT ALL — which is why this row fires no `done` for the displaced turn.
    // `concierge.rs` installs the new turn, KILLS the child it evicts, and that reader returns
    // silently, so the abandoned turn emits neither `done` nor `error`; `ConciergeHost`'s own
    // supersede gates document themselves as defence in depth rather than the primary guard. A first
    // version of this row called `h.brain.done` by hand and was therefore green against a branch the
    // app rarely reaches (roborev 62936) — the vacuous shape AGENTS.md calls its #1 finding.
    //
    // WHICH TURN IS STREAMING HERE, and why it is not a user one (roborev 62937). The delta is
    // injected with no prior send, so the turn queue's `running` is null — the state a BACKEND-
    // INITIATED turn leaves it in. That is deliberate and it is the reachable shape: a user send
    // arriving while a USER turn streams is QUEUED, never dispatched, so it cannot displace anything
    // (see the companion row below). A push turn and a correction painting in the
    // `correctionTurnId === null` window hold no queue slot, so a send during either one dispatches
    // immediately and strands whatever they had painted.
    //
    // Dispatch is the only moment the frontend learns those bubbles are dead, so that is where
    // `endStreamsThrough` marks them. Delete that call and this row goes red.
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      act(() => h.brain.delta?.({ id: "7", text: "I was saying" }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "actually, hold on" } });
      fireEvent.click(screen.getByText("Send"));
      // The send is queued and dispatched asynchronously, and it is DISPATCH that retires the old
      // turn — so this settle is load-bearing, not boilerplate.
      await settle();
      // The fragment is STILL ON SCREEN — which is the whole reason it has to be searchable.
      expect(inThread("I was saying")).toBeTruthy();
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response", text: "I was saying" }),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("a send arriving while a USER turn streams is queued, and sweeps nothing", async () => {
    // The companion to the row above, and it pins the premise rather than the mechanism (roborev
    // 62937). The obvious reading of `endStreamsThrough` is "a double-send kills the running reply
    // at the frontend", and that is FALSE: `conciergeTurnQueue.enqueue` takes the `running !== null`
    // branch and the second send WAITS, which is the whole point of the queue. So the reply in
    // flight must NOT be marked ended, and must NOT be indexed while it is still arriving — if this
    // row ever goes red, the sweep has started eating live replies.
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      act(() => h.brain.delta?.({ id: "7", text: "still answering" }));
      // THE POSITIVE HALF, and it is not decoration. A bare "nothing was recorded" passes for any
      // number of reasons that have nothing to do with the queue — a gated delta, a Send affordance
      // that stopped accepting the second message, or a message dropped on the floor. Each of those
      // silently retires the premise while the row stays green, which is the vacuous shape this
      // whole sequence exists to avoid, so all three are closed below.
      expect(inThread("still answering")).toBeTruthy();
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      // ¬DISPATCHED. Necessary, and on its own NOT sufficient: a second message that never reached
      // `askSparkle` at all produces this same count.
      expect(h.startConciergeTurn, "the second send must not dispatch").toHaveBeenCalledTimes(1);
      expect(inThread("still answering")).toBeTruthy();
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response", text: "still answering" }),
      );
      // …AND QUEUED, which is the half `toHaveBeenCalledTimes(1)` cannot see (roborev 62939).
      // Finishing the running turn must DRAIN the waiter — that is what separates "it waited" from
      // "it evaporated", and only the first supports this row's premise that a double-send never
      // reaches `endStreamsThrough`.
      act(() => h.brain.done?.({ id: "7", text: "answered" }));
      await settle();
      expect(h.startConciergeTurn, "the queued message dispatches once the slot frees").toHaveBeenCalledTimes(2);
      // Still never the streamed fragment: the bubble was settled by its own `done`, so what reached
      // the index is the final text and not the chunk the sweep would have banked.
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response", text: "still answering" }),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("indexes the fragment when a STRAGGLER done arrives for an already-displaced turn", () => {
    // The belt to the row above, and a distinct call site: `offDone`'s `finally`, which marks on
    // EVERY exit that did not render rather than on the four early returns one at a time. That
    // shape is the fix for the second half of roborev 62936 — the first attempt marked the
    // supersede return only and left the silenced one, which is reachable with a painted bubble
    // during the window where `isCorrectionTurn`'s ref is still null.
    //
    // Driven through the supersede return because it is the one an event can reach from outside;
    // the `finally` is shared, so a regression that moves the mark back into a single branch turns
    // this red. `concierge.rs` normally silences these at the source — this is the straggler case
    // its braces are the primary guard for.
    const record = vi
      .spyOn(useHistoryStore.getState(), "record")
      .mockImplementation(async () => undefined);
    try {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      act(() => h.brain.delta?.({ id: "7", text: "I was saying" }));
      // A newer turn's event is what retires 7 inside `supersededTurn`.
      act(() => h.brain.delta?.({ id: "8", text: "Now then" }));
      act(() => h.brain.done?.({ id: "7", text: "never rendered" }));
      // What it PAINTED, never the `done` text it never showed.
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "response", text: "I was saying" }),
      );
      expect(record).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "never rendered" }),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("announces the FINISHED reply once, never the streaming chunks (roborev 53010)", () => {
    // The column's one live region. It must not carry the growing text: a value that changes per
    // delta hands a screen reader an announcement per chunk — the flooding the interim dictation
    // preview was silenced for, which putting role=log on the transcript would have re-created.
    h.feed = feedWith("approval", "needs_you");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    const announcer = () => screen.getByTestId("concierge-announcer");
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(announcer().textContent).toBe("");
    act(() => h.brain.done?.({ id: "7", text: "" }));
    expect(announcer().textContent).toBe("On it.");
  });

  it("shows an error bubble when the brain can't be reached", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.error?.({ id: "t1", detail: "spawn failed" }));
    expect(await findInThread(/couldn't reach my brain/i)).toBeTruthy();
  });

  // A sentinel detail on the EVENT path (roborev 53460). startConciergeTurn silences these on the
  // invoke-rejection path, but an error EVENT carrying the same string was not filtered by detail at
  // all — its only guard was supersededTurn, and that misses a turn which failed before streaming
  // anything, because the send-time floor can only retire ids an event has been SEEN for. The turn
  // id here is deliberately one no delta ever arrived for, which is exactly that hole.
  //
  // Typing must stay ON: the turn that displaced this one is the one still talking.
  it.each(SUPERSEDED_DETAILS.map((d) => [d] as const))(
    "an error event whose detail is %s is silent — no bubble, no typing reset",
    async (detail) => {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      // A brain turn has to be IN FLIGHT for "don't reset typing" to mean anything. Routing is a
      // promise now, so the indicator only appears once the router has said "sparkle".
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      // BY TESTID, NOT BY ACCESSIBLE NAME. "Sparkle is typing" is only the indicator's FALLBACK
      // name — it now reports the actual step instead ("Reading your message", "Checking git"),
      // which is the entire point of the live status line, so a send immediately renames it. What
      // this case is about is whether the row is THERE, and the testid is the handle that answers
      // that without also asserting a caption this feature deliberately changes.
      expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).toBeTruthy();
      // AND THE CAPTION, through the REAL host (roborev 57925/57947). What this adds over presence
      // is the COMPOSED path: that the recorded phase actually reaches the row as a caption. The
      // store-level recording is pinned separately in conciergeTurnFloor.test.ts, so this is not
      // the only thing keeping `noteConciergePhase` alive — an earlier version of this comment
      // claimed that and was wrong.
      //
      // WHAT THIS DOES NOT PIN (roborev 57935): the send here is from IDLE, so `typing` moves and
      // the effect would fire on that alone — the `sendSeq` argument is not exercised. The re-send
      // case below is what covers it.
      expect(caption()).toBe("Reading your message");

      act(() => h.brain.error?.({ id: "9", detail }));
      expect(queryInThread(/couldn't reach my brain/i)).toBeNull();
      // Still typing — the displacing turn owns the indicator.
      expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).toBeTruthy();
    },
  );

  /**
   * THE RE-SEND, which is the half that actually broke twice (roborev 57889/57914/57935).
   *
   * A send SUPERSEDES the turn in flight, so `typing` never drops — only the per-send counter can
   * re-take the boundary.
   *
   * The intervening tool call is what stops this being vacuous, and the reason is a property of the
   * MUTANT, not of the shipped component: with the counter frozen the floor never moves, so the
   * stale `reading_message` still sits above it and the caption would read correctly for the wrong
   * reason. (In the shipped code the floor DOES move on every send while `typing` holds — that is
   * exactly the 57933 fix.) The tool line is what makes the two builds differ.
   *
   * Freeze `useConciergeTurnFloor`'s second argument, or drop the unconditional `setSendSeq` bump at
   * the send site, and the effect never re-runs — the caption stays on the tool line and this reds.
   */
  it("a re-send while still typing re-takes the boundary — the caption returns to 'Reading your message'", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(caption()).toBe("Reading your message");

    // Turn 1 does some work, so the row is showing its tool line rather than the boundary.
    act(() => void noteConciergeToolCall("workspace", "list_projects", {}));
    expect(caption()).toBe(
      "Looking over your projects",
    );

    // THE SECOND SEND NOW QUEUES (sparkle-t8wsj) — it does not start a turn, so it takes no
    // boundary and the caption keeps describing the turn that is actually running. This case was
    // written when a re-send SUPERSEDED, and its old expectation ("Reading your message" again) is
    // exactly the behaviour that killed the first turn's work.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "and this too" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(caption()).toBe(
      "Looking over your projects",
    );
  });

  /**
   * THE DEFECT sparkle-t8wsj FIXES, end to end through the real host: a second send must not start
   * a turn while one is running, because starting one is what makes `concierge.rs` kill the child
   * answering the first question.
   *
   * Asserted on `startConciergeTurn` CALL COUNT, which is the thing that does the killing — the
   * caption assertion above is a consequence, not the mechanism.
   */
  it("queues a second send instead of starting a turn that would kill the first", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const afterFirst = h.startConciergeTurn.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // No new turn: the first one is still being answered.
    expect(h.startConciergeTurn.mock.calls.length).toBe(afterFirst);

    // …and when it finishes, the queued one starts — carrying ITS OWN text.
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    expect(h.startConciergeTurn.mock.calls.length).toBe(afterFirst + 1);
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("second question");
  });

  /**
   * THE DEPTH REACHES A BACKGROUND SWEEP, WHICH IS THE WHOLE POINT OF PUBLISHING IT.
   *
   * The founder watched six messages queue with zero concierge agents running, and nothing said a
   * word — because the depth existed ONLY as this component's `useRef`/`useState` pair and crossed
   * no module boundary at all. `pusherSnapshots` is a synchronous read from a 60-second interval
   * with no component to ask, so a fact that lives in a component is a fact the Pusher structurally
   * cannot have.
   *
   * Asserted on `stores/conciergeQueueStore` — the app-wide store — rather than on anything
   * rendered. A rendered assertion would pass against the old code, which already showed the queue
   * position on the bubble; the store is the thing that was missing.
   */
  it("publishes the queue depth into the app-wide store as messages stack up", async () => {
    _resetConciergeActivityForTests();
    useConciergeQueueStore.getState()._resetForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // A MOUNTED HOST WITH AN EMPTY QUEUE IS A MEASUREMENT, and it has to be distinguishable from
    // the `undefined` the store held a moment ago — see the store's header on why `0` and "nobody
    //
    // `oldestAt: null` is part of that measurement, not an afterthought: nothing is waiting, so
    // there is no age to report — and a stale timestamp here would age forever and make an empty
    // queue look permanently abandoned to `queueUnfanned`.
    await settle();
    expect(useConciergeQueueStore.getState().depth).toEqual({ waiting: 0, running: false, oldestAt: null });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // One in flight, nothing behind it — the ordinary single send, which must NOT read as a backlog.
    // `oldestAt` is null because the RUNNING turn is not waiting: it is being worked on, and its age
    // is not what "nothing is taking my queue" is about.
    expect(useConciergeQueueStore.getState().depth).toEqual({
      waiting: 0,
      running: true,
      oldestAt: null,
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "third question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // THE STATE HE IS ACTUALLY LOOKING AT: messages stacking up behind one running turn.
    expect(useConciergeQueueStore.getState().depth).toEqual({
      waiting: 2,
      running: true,
      // A NUMBER, and specifically the FIRST waiter's — with two waiting, `oldestAt` is what
      // separates "this queue formed a moment ago" from "the founder has been waiting", and it is
      // the only field `queueUnfanned` uses to tell those apart.
      oldestAt: expect.any(Number),
    });

    // ...and it comes back down as the queue drains, so a report cannot keep quoting a backlog that
    // has cleared.
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    expect(useConciergeQueueStore.getState().depth).toEqual({ waiting: 1, running: true, oldestAt: expect.any(Number) });
  });

  /**
   * AN OWED PUSHER FINDING RIDES THE USER'S NEXT TURN, because the proactive channel is
   * SELF-DEFEATING for exactly the findings that matter most.
   *
   * `concierge_proactive_turn` stands down for any user turn in flight — correct, the user owns the
   * conversation — and a non-empty concierge queue means a user turn is ALWAYS in flight, by
   * `engine/conciergeTurnQueue.enqueue`'s own invariant. So the push about a stacked-up queue is
   * declined for precisely as long as the condition holds, while `notify()` still answers true and
   * `pusherRunner` stamps the condition as reported for four hours.
   *
   * `startProactiveConciergeTurn` is stubbed in this file to resolve `null` — "the transport stood
   * down" — which is exactly that state, so the finding reaches the founder here or nowhere.
   */
  it("folds an owed Pusher finding into the next user turn's prompt", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // Through the REAL registration seam — the host hands `scheduler.notify` to
    // `setConciergeNotifier`, and this is the call `pusherMount.sendVerified` makes.
    act(() => {
      expect(notifyConcierge("6 messages are queued for the concierge with nothing fanned out")).toBe(
        true,
      );
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const prompt = String(h.startConciergeTurn.mock.calls.at(-1)?.[0]);
    expect(prompt).toContain("6 messages are queued for the concierge");
    // AHEAD of the founder's message, not after it — the instruction preamble is what turns a
    // finding into something the brain acts on rather than reads past.
    expect(prompt.indexOf("6 messages are queued")).toBeLessThan(prompt.indexOf("what needs me?"));
  });

  it("does not repeat a finding the installed turn already carried", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => void notifyConcierge("Agent A has been quota-walled for 3h"));

    // A turn that INSTALLS — the id is what the claim is made against.
    h.startConciergeTurn.mockResolvedValueOnce("1");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("quota-walled");

    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).not.toContain("quota-walled");
  });

  /**
   * ...AND A TURN THAT NEVER INSTALLED KEEPS IT OWED.
   *
   * `startConciergeTurn` resolves `null` for a turn superseded before install, cancelled, or failed
   * locally — it told the founder nothing. Claiming at prompt-build time would destroy the finding
   * with no residue, which is the loss `research/drain`'s peek/claim split exists to prevent; the
   * same rule applies here, and this is the case that discriminates the two.
   */
  it("keeps an owed finding when the turn never installed", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => void notifyConcierge("Agent A has been quota-walled for 3h"));

    // The file's default stub resolves `null`: no turn id, so nothing may be claimed.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("quota-walled");

    // The slot is released by the local-error path, and the next send carries the finding again.
    act(() => h.brain.error?.({ id: "1", detail: "boom" }));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("quota-walled");
  });

  /**
   * A TORN-DOWN HOST MUST NOT STRAND A FALSE DEPTH.
   *
   * Nothing else writes this store, so an unmount that does not clear leaves its last reading
   * standing for the life of the window: every later sweep reports "2 queued" about a concierge
   * that no longer exists, and there is no live host left to correct it. `undefined` — nobody is
   * looking — is the only honest answer once the mount is gone.
   */
  it("clears the published depth when the host unmounts", async () => {
    _resetConciergeActivityForTests();
    useConciergeQueueStore.getState()._resetForTests();
    h.feed = feedWith("approval");
    const view = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(useConciergeQueueStore.getState().depth).toEqual({ waiting: 1, running: true, oldestAt: expect.any(Number) });

    view.unmount();
    expect(useConciergeQueueStore.getState().depth).toBeUndefined();
  });

  /**
   * THE TOOL CHANNEL IS ACTUALLY SUBSCRIBED (roborev 58020-M1).
   *
   * Every one of the twenty total mocks stubs `onConciergeTool` as an inert subscriber that never
   * fires, so nothing drove this wiring: deleting the whole `onConciergeTool(...)` block from the
   * host left the suite green. The pure sinks are well covered; only the wiring reaching them was
   * not — and the CI break that added those stubs was surfaced by an import-time throw, not by any
   * assertion, so there was no signal that would catch the subscriber being disconnected.
   *
   * Asserted through the RENDERED CAPTION, which is the whole path: event → supersede gate →
   * noteConciergeNativeToolCall → activity store → line → row.
   */
  it("renders a live tool event from the brain, and ignores one from a superseded turn", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(caption()).toBe("Reading your message");

    // A tool call on the CURRENT turn reaches the column.
    act(() => h.brain.tool?.({ id: "1", name: "Grep", input: '{"pattern":"retry"}' }));
    const live = caption();
    expect(live).not.toBe("Reading your message");
    expect(live.length).toBeGreaterThan(0);

    // THE REAL DISPLACED-TURN SHAPE (roborev 58048): a SAME-ID straggler arriving after a re-send,
    // which is what happens when turn 1's buffered stdout flushes once the user has already sent
    // again. An older-id event would be rejected by `supersededTurn`'s `n < latest` branch, so it
    // pins nothing about the `retireThrough` branch that the production comment identifies as the
    // one closing the straggler window — the earlier version of this case did exactly that and
    // claimed otherwise.
    // A SEND NO LONGER RETIRES THE RUNNING TURN (sparkle-t8wsj) — it queues — so the displaced-turn
    // shape is now produced by the turn ENDING and the queued one starting, which is what advances
    // the retirement floor past turn 1.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "and this too" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    const afterDrain = caption();
    expect(afterDrain).toBe("Reading your message");

    // Turn 1 flushes late, under its OWN id, which is now retired.
    act(() => h.brain.tool?.({ id: "1", name: "Read", input: '{"file_path":"/x"}' }));
    expect(caption()).toBe(afterDrain);
  });

  /**
   * THE DRAIN MUST NOT RUN BEFORE THE TEARDOWN (probe 3 on PR #1235).
   *
   * `drainQueue` DISPATCHES the next turn, and dispatch sets the awaited bubble, starts the liveness
   * clock and raises the typing indicator. Draining before this handler's teardown meant the
   * teardown then cleared them — turn N+1 ran with no message attached and a stopped clock.
   *
   * Asserted on the TYPING INDICATOR surviving the turn that ended: it is raised by the dispatch and
   * cleared by the teardown, so it is the visible consequence of the ordering.
   */
  it("keeps the next turn's state after the finishing turn tears down", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();

    // Turn 1 ends: the queued turn 2 starts, and turn 1's teardown must not undo it.
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    // THE PER-MESSAGE STATUS IS STILL ATTACHED, which is the assertion that actually discriminates.
    //
    // `typing` and the column caption both SURVIVE the bug — nothing sets typing false afterwards
    // and the phase was already recorded — so asserting on them passes against the broken ordering.
    // (The first version of this case did exactly that and stayed green under the mutation.) What
    // the teardown really destroys is `awaitingId`: nulling it detaches the running turn from its
    // bubble, so the per-message status has nothing to attach to and disappears entirely.
    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(MESSAGE_STATUS_TESTID)).toBeTruthy();
  });

  /**
   * A REJECTED DISPATCH STILL RELEASES THE SLOT (probe 4 on PR #1235).
   *
   * `startConciergeTurn` throws before its own try block when AI enhancements are off, and that path
   * emits no `concierge:error` event — so nothing drained, the entry stayed `running` forever, and
   * every later question queued behind a turn that did not exist.
   */
  it("drains the queue when a dispatch REJECTS without emitting an error event", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();

    // The NEXT dispatch rejects — no error event follows it.
    h.startConciergeTurn.mockRejectedValueOnce(new Error("ai enhancements are off"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const before = h.startConciergeTurn.mock.calls.length;
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();
    expect(h.startConciergeTurn.mock.calls.length).toBe(before + 1); // the rejecting one ran

    // A THIRD question must still be reachable — the rejected turn released the slot.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "third" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("third");
  });

  /**
   * A REPLY MUST NOT CLAIM THE MESSAGE QUEUED BEHIND IT (probe 2, and roborev 58223-M1).
   *
   * Driven through the NO-DELTA path deliberately: that is the one the first fix silently failed
   * on. `drainQueue` runs earlier in the same `done` handler and promotes the waiter from `waiting`
   * to `running`, so a filter that asked the LIVE queue saw "working" and let it through. Only a
   * reply whose bubble is created in `done` (no prior delta) exposes it.
   */
  it("does not anchor the queued message to the running turn's reply — even with no delta", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "question A" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "question B" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();

    // A answers with NO prior delta, so its bubble is minted in the done path.
    act(() => h.brain.done?.({ id: "1", text: "here is the answer to A" }));
    await settle();
    // NAMED, not counted. B was never in A's prompt, so B's own bubble must carry no
    // "Answered below" marker — a count says two markers exist without saying which bubble is
    // wrongly claimed, and the whole finding is about WHICH message gets claimed.
    const bubbles = within(thread()).getAllByTestId("you-bubble");
    const bBubble = bubbles.find((b) => b.textContent?.includes("question B"))!;
    expect(bBubble).toBeTruthy();
    const bRow = bBubble.closest("[data-message-id]")!;
    expect(bRow.querySelector(`[data-testid="${ANSWERED_MARKER_TESTID}"]`)).toBeNull();
  });

  /**
   * A DROPPED MESSAGE IS REPORTED, AND CANNOT BE CLAIMED (probes 1 and 3, roborev 58223-M3).
   *
   * At the cap the oldest waiter is evicted. Losing it silently is the defect the queue exists to
   * remove, and leaving its bubble unmarked is worse than losing it: the next reply's anchor walk
   * would stamp "Answered below" on a question that was never sent.
   */
  it("reports a message dropped at the cap, with its text", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // One running turn, then fill the queue past the cap.
    for (let n = 0; n <= MAX_QUEUED_TURNS + 1; n += 1) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: `q${n}` } });
      fireEvent.click(screen.getByText("Send"));
    }
    await settle();
    // The oldest WAITER (q1 — q0 is the one running) is gone, and the thread says so WITH ITS TEXT.
    // The text is the entire point: a count reports the loss and gives no way to recover from it,
    // so asserting only the headline would leave the fix's actual claim unverified.
    expect(await within(thread()).findByText(/One queued message was dropped/)).toBeTruthy();
    expect(within(thread()).getByTestId(FAILURE_EVIDENCE_TESTID).textContent).toContain("q1");
    // AND THE EVICTED BUBBLE ITSELF CARRIES A RENDERED MARK (roborev 58638-M1). The previous commit
    // rewrote the comment on this path to claim `refused` and left the code stamping `unanswered`,
    // which renders nothing — so the bubble still looked delivered. Asserting the failure bubble
    // alone could not catch that; this asserts the LOST MESSAGE'S OWN bubble.
    const q1Bubble = within(thread())
      .getAllByTestId("you-bubble")
      .find((b) => b.textContent?.includes("q1"))!;
    expect(q1Bubble).toBeTruthy();
    const q1Text = q1Bubble.closest("[data-message-id]")!.textContent ?? "";
    expect(q1Text).toMatch(/Not sent/);
    // …and NOT "Not sent — <agent> couldn't take it" (knightwatch, PR #1288). The receipt is spread
    // from the original, which carries an `agentName` on the sparkle path, and `receiptText`'s
    // refused branch renders that name as an agent REFUSAL — a claim about an agent that was never
    // offered this message. The bare form is the only true one here.
    expect(q1Text).not.toMatch(/couldn't take it/);
  });

  /**
   * A DISPLACED MESSAGE IS **NOT** "Not sent" (roborev 58638-M2).
   *
   * The orphan path marks a message that REACHED the brain and was being worked on when the next
   * send arrived. `refused` means "never left this app" and renders "Not sent — <agent> couldn't
   * take it" whenever the receipt names an agent, fabricating a refusal by an agent that was never
   * offered the message — and unlike `unanswered` it cannot be withdrawn when the concierge answers
   * a couple of messages later, which is the documented common case.
   *
   * Asserted as an ABSENCE of the false claim, because the true state here renders nothing at all.
   */
  it("never stamps a displaced message 'Not sent' — it reached the brain", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "displaced question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // A tool call: the brain is working on it, but no answer TEXT has arrived.
    //
    // The turn is deliberately left RUNNING. The orphan check reads `awaitingBubbleRef`, and the
    // done handler nulls it — so delivering `done` first leaves nothing to stamp and the case
    // passes whatever the stamp says. (Verified: with `done` in between, mutating the stamp to
    // `refused` did not redden this.) The next send is what runs the check.
    act(() => h.brain.tool?.({ id: "1", name: "Grep", input: '{"pattern":"x"}' }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "next question" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();

    const displaced = within(thread())
      .getAllByTestId("you-bubble")
      .find((b) => b.textContent?.includes("displaced question"))!;
    expect(displaced).toBeTruthy();
    expect(displaced.closest("[data-message-id]")!.textContent).not.toMatch(/Not sent/);
  });

  /**
   * A STICKY REJECTION CLEARS THE QUEUE ONCE, WITHOUT CASCADING (probe 4 / roborev 58241-M2).
   *
   * `ConciergeAiDisabledError` cannot be retried, so draining would dispatch the next waiter into
   * the same rejection and empty the queue in N microtasks with nothing on screen. The cascade was
   * the reported defect and shipped untested.
   */
  it("reports a sticky rejection once and does not cascade through the queue", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    for (const t of ["second", "third"]) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: t } });
      fireEvent.click(screen.getByText("Send"));
    }
    await settle();

    // The next dispatch hits the sticky failure.
    h.startConciergeTurn.mockRejectedValueOnce(new ConciergeAiDisabledError());
    const before = h.startConciergeTurn.mock.calls.length;
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();

    // EXACTLY ONE further dispatch — the one that rejected. No cascade through the rest.
    expect(h.startConciergeTurn.mock.calls.length).toBe(before + 1);
    // One notice, naming the toggle rather than telling the user to retry a sticky condition.
    // Matched on a fragment UNIQUE TO THE HEADLINE: the error's own sentence also begins "AI
    // enhancements are off", so a bare substring matches the evidence block too and throws.
    expect(await within(thread()).findByText(/turn them back on to send these/)).toBeTruthy();
    const evidence = within(thread()).getByTestId(FAILURE_EVIDENCE_TESTID).textContent ?? "";
    // The MACHINE'S OWN SENTENCE — the commit claimed evidence carries it, and with the previous
    // unfaithful stub that claim could not fail.
    expect(evidence).toContain("so the concierge can't think or act");
    // …and every stranded question, so each can be re-sent.
    expect(evidence).toContain("second");
    expect(evidence).toContain("third");
    // EACH STRANDED BUBBLE CARRIES A MARK THAT RENDERS. `unanswered` is never rendered, so the
    // earlier stamp recorded the loss without showing it; `refused` renders "Not sent".
    expect(within(thread()).getAllByText(/Not sent/).length).toBeGreaterThan(0);
  });

  /**
   * A TRANSIENT REJECTION MUST NOT DESTROY THE QUEUE (roborev 58241-M2).
   *
   * The rejection handler is generic, so making the clear unconditional would mean any one-off
   * failure silently discarded every queued question. Only `ConciergeAiDisabledError` is sticky —
   * everything else should release the slot and let the next message through, which is the ordinary
   * drain.
   */
  it("keeps the queue and drains on a NON-sticky rejection", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    for (const t of ["second", "third"]) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: t } });
      fireEvent.click(screen.getByText("Send"));
    }
    await settle();

    // An ORDINARY error, not the sticky one.
    h.startConciergeTurn.mockRejectedValueOnce(new Error("a transient blip"));
    act(() => h.brain.done?.({ id: "1", text: "answered" }));
    await settle();

    // "third" still got its turn — the queue survived the blip that killed "second".
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("third");
    // And no sticky notice was posted — this failure is not the toggle.
    expect(within(thread()).queryByText(/turn them back on to send these/)).toBeNull();

    // ══ AND "second" IS NOT LOST SILENTLY (roborev 58517-M1) ═══════════════════════════════════
    // The earlier version of this case asserted ONLY that "third" ran, never what became of the
    // message the rejection consumed — which is how a branch that destroyed it quietly, and let the
    // next reply claim it, passed review-by-test.
    expect(await within(thread()).findByText(/That message didn't get sent/)).toBeTruthy();
    const lost = within(thread()).getAllByTestId(FAILURE_EVIDENCE_TESTID).at(-1)?.textContent ?? "";
    expect(lost).toContain("second");

    // …and its own bubble is MARKED, which is what stops a later reply claiming it: the mark and
    // the `neverSentRef` re-entry are set together, so this is the observable proxy for both.
    //
    // Asserted on the bubble rather than on a downstream anchor: a reply delivered under a retired
    // turn id is rejected before any bubble is created, so an anchor assertion there passes whether
    // or not the message was protected — it proves nothing. (Verified by mutation: removing the
    // stamp and the ref re-entry left that anchor check green.)
    const secondBubble = within(thread())
      .getAllByTestId("you-bubble")
      .find((b) => b.textContent?.includes("second"))!;
    expect(secondBubble).toBeTruthy();
    expect(
      secondBubble.closest("[data-message-id]")!.textContent,
    ).toMatch(/Not sent/);
  });

  /**
   * A PUSH'S `done` MUST NOT RELEASE A USER TURN'S SLOT (roborev 58503).
   *
   * `turnFinished` is id-agnostic — it releases whatever is in `running` — so an unguarded drain in
   * the done handler let a background push dispatch the queued message while the user's turn was
   * still streaming, and `concierge.rs` then killed that turn's child. The exact loss the queue
   * exists to prevent, arriving from a turn the user never sent.
   *
   * Asserted on `startConciergeTurn` NOT being called again, which is the call that does the
   * killing.
   */
  it("a proactive push finishing does not dispatch the queued message", async () => {
    _resetConciergeActivityForTests();
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "M1" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "M2" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const before = h.startConciergeTurn.mock.calls.length;

    // A background push finishes. It owns no slot, so it must release nothing.
    //
    // ══ A LOWER ID THAN THE USER TURNS, BECAUSE THAT IS THE ONLY ORDER PRODUCTION CAN PRODUCE ═════
    // This drove the push with id "99" — higher than both user turns — and `concierge.rs` makes that
    // impossible: `proactive_may_start` refuses to start a push while ANY turn holds the slot or a
    // send is pending, and `reserve_proactive_token` draws from the SAME monotonic sequence. So a
    // push that is still in flight when the user sends necessarily took its token FIRST.
    //
    // The unrealistic ordering was not cosmetic — it is what forced the real assertion out. A higher
    // id advanced the mock's retirement floor, so M1's own `done` was then rejected by the supersede
    // gate and "the queue still drains afterwards" could not be checked. Production has no such
    // effect: a push publishes no retirement floor at all, precisely so it can never silence a turn.
    h.proactiveIds.add("0");
    act(() => h.brain.done?.({ id: "0", text: "an unprompted note" }));
    await settle();
    expect(h.startConciergeTurn.mock.calls.length).toBe(before);

    // ══ AND THE QUEUE IS NOT STRANDED — the guard's real risk ════════════════════════════════════
    // Releasing someone else's slot is one failure; the mirror image is a guard so broad that the
    // queue never drains again, leaving every later question waiting on a turn that already ended.
    // With the realistic ordering this is finally assertable.
    act(() => h.brain.done?.({ id: "1", text: "answered M1" }));
    await settle();
    expect(h.startConciergeTurn.mock.calls.length).toBe(before + 1);
    expect(String(h.startConciergeTurn.mock.calls.at(-1)?.[0])).toContain("M2");

  });

  // Each refused path gets its OWN remedy, and the remedies genuinely differ: Retry for a pane that
  // gave up, "use its own pane" for a cloud agent. Falling back to the generic "I couldn't send the
  // approval to X." is the dead end these branches exist to remove — and it silently came back once
  // already, because the approval ladder drifted a commit behind the prompt one.
  //
  // Every pattern below is VOICE-UNIQUE — it appears in the approval copy and NOWHERE in the prompt
  // copy. That is the whole point since both voices share one `refusalCopy` table: a loose pattern
  // like /hit Retry/ matches the prompt line too, so mis-wiring the call to `…, "prompt")` would
  // ship "then send again" on a nudge Approve and still pass (roborev 52972). trial-spent is
  // deliberately absent — its copy is SHARED by both voices by design, so it has no unique
  // fragment; the pair of exact-string tests below pin that sharing instead.
  it.each([
    ["agent-failed", /I couldn't send the approval — open its pane and hit Retry/],
    // NARROWED to answers (design 2026-08-01 §Decision 7): prompting a cloud agent works now, so
    // the remedy is no longer "the feature isn't wired" — it is "an approval belongs where the
    // question is". The old /relay the approval/ pattern would still have matched a line that
    // claimed prompting was unwired, which is exactly the stale copy this row must now exclude.
    ["cloud-agent", /an approval has to be given where the question is/],
    // Its sibling, and NOT the same fact: the agent is fine, the connection isn't. Distinct
    // remedies, so both mappings are pinned rather than one standing in for the other.
    ["cloud-offline", /I've lost the connection to the cloud/],
    ["pty-gone", /I couldn't send the approval\./],
    ["ambiguous-picker", /open it to choose/],
    // PATH-unique ("prompts waiting to start") AND voice-unique ("then approve again") together:
    // the tail alone is not enough here, because agent-failed's PROMPT copy also ends "then send
    // again", so a bare tail would pin the voice without pinning path→copy (roborev 54042).
    ["queue-full", /prompts waiting to start.*then approve again/],
  ] as const)("an Approve refused as %s speaks in the APPROVAL voice", async (path, remedy) => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(remedy)).toBeTruthy();
    // …and NOT the generic dead end, nor any prompt-voice phrasing bleeding across.
    expect(queryInThread(/^I couldn't send the approval to/)).toBeNull();
    // "isn't wired up yet" is GONE from the codebase with Decision 7, so it could no longer fail
    // — replaced by a phrase the prompt voice actually still uses.
    expect(queryInThread(/then send again|your message is back in the box|pass it along/)).toBeNull();
  });

  it("an Approve refused as trial-spent says EXACTLY the shared trial line", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // Exact string, not a fragment: trial-spent is the one branch both voices are meant to share,
    // and its prompt-side twin asserts the same literal. A fragment match would let the two drift
    // apart while still passing, which is precisely the design claim (roborev 53018).
    expect(await findInThread(TRIAL_SPENT_TEXT)).toBeTruthy();
  });

  // The approve-side mirror of the prompt table below: `approve` carried the identical widening,
  // where reinstating it prints "Approved — sent to X." on a dispatch that FAILED. Nothing in the
  // suite caught that until now (roborev 53044). No draft to check here — Approve has no composer.
  it.each(["free-text", "picker-option", "queued"] as const)(
    "an ok:false Approve carrying the delivered path %s is still a refusal",
    async (path) => {
      h.feed = feedWith("approval");
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.click(inThread("Approve"));
      await settle();
      // Pin that the dispatch actually happened with the approve arguments. The catch path can't
      // satisfy these rows TODAY (it posts "I couldn't reach X's terminal to approve.", which the
      // regex below doesn't match) — this is a forward-guard: a change routing the catch through
      // refusalCopy would otherwise let them pass on a path they never meant to cover.
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", {
      // The user clicked Approve on the nudge card — that click IS the authorization.
      authority: { kind: "nudge-approve", agentId: "ag1" },
      userPrompt: false,
    });
      expect(await findInThread(/I couldn't send the approval to/)).toBeTruthy();
      expect(queryInThread(/^Approved — sent to/)).toBeNull();
      expect(queryInThread(/still starting up/)).toBeNull();
    },
  );

  // The POSITIVE SUCCESS report. Every other approve test asserts this line only via
  // `queryByText(…).toBeNull()`, and the one success-path test checks the dispatch args without
  // ever looking at the thread — so deleting the success branch made a working Approve post
  // NOTHING and left the suite green. That silence is precisely what `approve`'s own comment
  // promises never happens ("ALWAYS give the user feedback") (roborev 53097).
  it("a delivered Approve is confirmed in the thread", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/^Approved — sent to @CI Hardening\.$/)).toBeTruthy();
    expect(queryInThread(/still starting up|I couldn't send the approval/)).toBeNull();
  });

  // The THROWING path — the other half of "ALWAYS give the user feedback… Also swallows the
  // throwing path". Nothing held this string in place, so deleting the try/catch made a throwing
  // dispatch post nothing at all: the same silence the success test above now prevents. It also
  // pins the copy that the refusal table's forward-guard comment cites as its rationale
  // (roborev 53111).
  it("a THROWING Approve still says something rather than leaving the user waiting", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockRejectedValueOnce(new Error("pty write failed"));
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/^I couldn't reach @CI Hardening's terminal to approve\.$/)).toBeTruthy();
    expect(queryInThread(/^Approved — sent to/)).toBeNull();
    // States WHICH failure voice this row pins: the catch's copy, not refusalCopy's — the same
    // distinction the refusal table's forward-guard comment relies on.
    expect(queryInThread(/I couldn't send the approval to/)).toBeNull();
  });

  // The POSITIVE queued case, which `promptAgent` has and `approve` did not. Without it, deleting
  // or mis-gating approve's queued branch drops an ok:true hold through to `else if (r.ok)` and
  // posts "Approved — sent to X." for something that was only HELD — the exact lie this series
  // exists to remove — with the whole suite still green (roborev 53062).
  it("an Approve that is only QUEUED says so, and does not claim it was sent", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/is still starting up — I'll approve as soon as it's ready/)).toBeTruthy();
    expect(queryInThread(/^Approved — sent to/)).toBeNull();
  });
});

// The capability the removed AgentPane composer owned: type a prompt, have it reach an agent's
// terminal with all the side-effects that used to hang off Send (roborev 46251-H1 / 46260-M3).
//
// The user no longer PICKS that destination — the host routes (PRD/sparkle/concierge-auto-routing).
// So every row that used to flip the target toggle now points the mocked router at the agent
// instead. What is being pinned is unchanged: the dispatch options, and every outcome the thread
// has to report honestly.
describe("ConciergeHost — routed prompt → the selected agent", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget(t: typeof target | null = target) {
    h.feed = feedWith("approval");
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={t} />);
  }

  function type(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
  }

  async function send(text: string) {
    type(text);
    await settle();
  }

  /** Submit and let ROUTING resolve, stopping before the countdown does. */
  async function arm(text: string) {
    type(text);
    await flush();
  }

  it("the box offers NO target affordance — the user never picks", () => {
    renderWithTarget();
    expect(screen.queryByTestId("send-target-toggle")).toBeNull();
  });

  // ── THE REPORTED BUG ─────────────────────────────────────────────────────────────────────────
  // Design §2(b) and §4: an agent-bound decision used to be dispatched the instant it resolved,
  // putting the user's word into a terminal with no warning and no way back.
  //
  // TWO LAYERS FIXED THAT, and this row owns the second. The FIRST is that the router can no longer
  // produce an agent verdict from a heuristic at all — the "this text answers the question on
  // screen" branch was deleted, because it was mis-routing the user's answers to the CONCIERGE into
  // whichever build agent's pane happened to be showing (services/conciergeRouter, and its own
  // suite pins it). The SECOND, asserted here, is that even a legitimate agent-bound decision ARMS
  // a visible, cancellable intent rather than dispatching.
  //
  // The router is a MOCK in this file, so the verdict below is a knob — it stands for the decision
  // ConciergeHost really builds today, the one from an explicit `@Name`. What this row asserts is
  // the negative that matters either way: at the moment routing resolves, NOTHING has been
  // dispatched, and what exists instead is an intent the user can still stop.
  it("REGRESSION: an agent-bound decision ARMS an intent, it does not dispatch", async () => {
    h.feed = feedWith("approval");
    routeToAgent();
    renderWithTarget();
    // `arm`, not `send`: `send` also elapses the countdown, which is exactly the step this row
    // exists to observe the near side of.
    await arm("yes");

    // NOT DELIVERED. This is the whole regression: before the gate, "yes" was already in the PTY.
    expect(
      h.dispatchConciergeAnswer,
      "a router verdict alone must never reach a terminal",
    ).not.toHaveBeenCalled();

    // Held instead — visible, attributable, and stoppable.
    const armed = armedIntents();
    expect(armed, "the send must be armed rather than lost").toHaveLength(1);
    expect(armed[0]!.text).toBe("yes");
    expect(armed[0]!.targetAgentId).toBe("ag1");
    // And the user can actually see it: the banner names the agent and the words.
    expect(screen.getByTestId("countdown-banner")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel sending to CI Hardening" }),
    ).toBeTruthy();

    // Only the uncancelled expiry delivers, and it says why it was allowed to.
    await elapseCountdowns();
    await waitFor(() =>
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "yes", {
        authority: { kind: "countdown", intentId: armed[0]!.id },
        userPrompt: true,
        display: "yes",
        namingBasis: "yes",
        // FALSE for every send in this file: none of them is @-addressed, so each keeps the
        // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
        neverPickerAnswer: false,
      }),
    );
  });

  it("REGRESSION: cancelling the armed send keeps it out of the terminal for good", async () => {
    routeToAgent();
    renderWithTarget();
    await arm("yes");
    expect(armedIntents()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel sending to CI Hardening" }));
    });
    expect(armedIntents()).toHaveLength(0);
    // The banner is gone, the user is told, and no expiry can resurrect the send.
    expect(screen.queryByTestId("countdown-banner")).toBeNull();
    expect(await findInThread(/I didn't send that to @CI Hardening/)).toBeTruthy();
    await elapseCountdowns();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("asks the router where the message goes, with the agent in view", async () => {
    renderWithTarget();
    await send("what needs me?");
    expect(h.routeMessage).toHaveBeenCalledWith("what needs me?", {
      agent: { id: "ag1", name: "CI Hardening", status: undefined, canAcceptInput: true },
    });
  });

  it("a 'sparkle' decision starts a brain turn and never touches the agent", async () => {
    renderWithTarget();
    await send("what needs me?");
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("an 'agent' decision dispatches as a USER prompt and never asks the brain", async () => {
    routeToAgent();
    renderWithTarget();
    await send("rebase onto main and re-run CI");
    // With nothing attached, all three renderings are the same string (see the dispatch options).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "rebase onto main and re-run CI",
      {
        // A router verdict alone can no longer reach a terminal: it arms an intent, and only the
        // uncancelled expiry dispatches — hence a `countdown` authority rather than none at all.
        // There is deliberately no union arm that would let the old silent send type-check.
        authority: { kind: "countdown", intentId: expect.any(String) },
        userPrompt: true,
        display: "rebase onto main and re-run CI",
        namingBasis: "rebase onto main and re-run CI",
        // FALSE for every send in this file: none of them is @-addressed, so each keeps the
        // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
        neverPickerAnswer: false,
      },
    );
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // Asking the dispatcher's own precondition UP FRONT turns a guaranteed delivery failure into a
  // useful chat answer. `canAcceptInput` is required on RouteAgent for exactly this reason — a
  // caller that doesn't know must not be able to route at a terminal.
  //
  // The predicate is `agentCanAcceptPrompt` now, not `agentCanAcceptInput` (design 2026-08-01
  // §Decision 7): a cloud agent CAN take a message, so the false case this pins is an agent the
  // store has never heard of, not a cloud one. The mock wires both names to one spy, so toggling
  // it here still drives the host.
  it("tells the router an unreachable agent can't accept input", async () => {
    h.agentCanAcceptInput.mockReturnValue(false);
    renderWithTarget();
    await send("anything");
    expect(h.routeMessage).toHaveBeenCalledWith("anything", {
      agent: { id: "ag1", name: "CI Hardening", status: undefined, canAcceptInput: false },
    });
  });

  it("tells the router there is nothing to prompt when no agent is in view", async () => {
    renderWithTarget(null);
    await send("still chat");
    expect(h.routeMessage).toHaveBeenCalledWith("still chat", { agent: null });
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // A promptTarget naming an agent the feed no longer carries is a corpse: routing at it would
  // report a delivery that cannot happen.
  it("treats an agent that vanished from the feed as no agent at all", async () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p9", agentId: "ghost", name: "Ghost" }}
      />,
    );
    await send("hello?");
    expect(h.routeMessage).toHaveBeenCalledWith("hello?", { agent: null });
  });

  // Two IDENTICAL consecutive announcements — the most ordinary path there is: send twice to the
  // same pinned agent and both outcomes read "Sent to CI Hardening." (roborev 53392). Fed a bare
  // string, the second `setAnnouncement` is `Object.is`-equal, so React bails out of the update; and
  // even re-rendered the text node is unchanged, while an `aria-live` region only speaks on a
  // content CHANGE. The screen-reader user was told about the first send only.
  //
  // So this asserts the NODE was replaced, not merely that the text still reads the same — the text
  // read the same the whole time it was broken, which is why the previous "fixed" claim on bbf596e
  // survived with no nonce in the code and this suite green.
  //
  // Under ROUTING the repeat is the common case, not a corner one: the outcome announced for a
  // routed send is its RECEIPT, and routing is sticky — two messages in a row sent to the same
  // agent both read "→ Sent to CI Hardening". So this pins the receipt path through `announce`
  // rather than a plain `setAnnouncement`.
  it("announces a SECOND, IDENTICAL outcome — the live region must not go quiet on a repeat", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer
      .mockResolvedValueOnce({ ok: true, path: "free-text" })
      .mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    const announcer = () => screen.getByTestId("concierge-announcer");

    await send("ship it");
    // Settle on the card; then assert the ANNOUNCEMENT, which is what this case is about. The two
    // deliberately differ now: the visible surface names the agent as a pill inside the bubble, and
    // the live region still speaks the full sentence — a screen-reader user gets no pill to read.
    await within(thread()).findByTestId(SENT_TO_AGENT_TESTID);
    expect(announcer().textContent).toBe("→ Sent to CI Hardening");
    const spoken = announcer().firstElementChild;
    const seq = spoken?.getAttribute("data-announce-seq");

    await send("ship it again");
    // A different node carrying the same words: exactly the mutation the assistive technology
    // listens for, and the thing a bare string could not produce.
    await waitFor(() => expect(announcer().firstElementChild).not.toBe(spoken));
    expect(announcer().textContent).toBe("→ Sent to CI Hardening");
    expect(announcer().firstElementChild?.getAttribute("data-announce-seq")).not.toBe(seq);
  });

  it("surfaces the trial-spent refusal instead of pretending the prompt landed", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    renderWithTarget();
    await send("one more");
    // Exact string — the approve-side twin asserts the same literal, which is what pins that the
    // one branch both voices share actually stays shared.
    expect(await findInThread(TRIAL_SPENT_TEXT)).toBeTruthy();
  });

  it("says a queued prompt is waiting on the agent's start-up", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    renderWithTarget();
    await send("start on the docs");
    // Full phrase, not the /still starting up/ fragment both voices share: mis-wiring this branch
    // to the APPROVAL wording ("I'll approve as soon as it's ready") would pass on the fragment.
    expect(await findInThread(/still starting up — I'll send that the moment it's ready/)).toBeTruthy();
  });

  // The positive picker-option branch — the last untested "ok:true but not a plain send" report.
  // Mis-gating it (e.g. to "free-text") drops through to `if (r.ok)`, which under routing posts no
  // line at all — silently losing WHICH option the user's text answered (roborev 53081).
  it("a prompt that answered a PICKER names the option it chose", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({
      ok: true, path: "picker-option", matchedLabel: "Yes",
    });
    renderWithTarget();
    await send("yes");
    expect(await findInThread(/was asking something — I answered "Yes"/)).toBeTruthy();
  });

  // `matchedLabel` is OPTIONAL on the result, so interpolating it unguarded renders the literal
  // `I answered "undefined".` — the same untrue report the ladder exists to avoid (roborev 53097).
  it("a picker-option result with NO label degrades truthfully — never 'I answered \"undefined\"'", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "picker-option" });
    renderWithTarget();
    await send("yes");
    expect(await findInThread(/was asking something — I answered it\./)).toBeTruthy();
    expect(queryInThread(/undefined/)).toBeNull();
  });

  // The refusal ladder, in the PROMPT voice. Each row asserts a phrase unique to its path so a
  // fall-through to the generic line is a failure, not a pass.
  it.each([
    ["agent-failed", /hit Retry/],
    // Was /use its own pane for now/ — the line that told the user prompting a cloud agent "isn't
    // wired up yet". It is, so that copy would now be an instruction to work around a working
    // feature (AGENTS.md: user-facing copy is code). What is left is the ANSWER refusal.
    ["cloud-agent", /I can't answer that for it from here/],
    ["cloud-offline", /so that didn't reach/],
    // NOT /open it and pick/ any more: `addressed-at-picker` was split out of this path and its
    // copy contains that phrase too, so the pattern stopped being path-unique and swapping the two
    // `case` bodies would still have passed — the exact drift class this table exists to catch.
    // "a choice I can't map that to" is this copy's alone (roborev 54673).
    ["ambiguous-picker", /a choice I can't map that to/],
    // Its sibling, under the same uniqueness rule, so the mapping is pinned in BOTH directions.
    ["addressed-at-picker", /didn't send that to it as a message/],
    // /didn't send/ is voice-unique but appears in THREE prompt-side branches, so it pins the voice
    // without pinning the path→copy mapping. "pass it along" is pty-gone's alone (roborev 53018).
    ["pty-gone", /pass it along/],
    // Same reasoning as the approval table: "then send again" is shared with agent-failed, so the
    // path-unique phrase is paired with it. This row also pins that a full hold queue KEEPS THE
    // DRAFT — the behaviour a queue-full refusal most needs to guarantee, since the send is
    // retryable the moment the queue drains (roborev 54042).
    ["queue-full", /prompts waiting to start.*then send again/],
  ] as const)("a prompt refused as %s speaks in the PROMPT voice and keeps the draft", async (path, remedy) => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    renderWithTarget();
    await send("worth not retyping");
    expect(await findInThread(remedy)).toBeTruthy();
    expect(queryInThread(/^I couldn't send that to/)).toBeNull();
    // No approval-voice phrasing bleeding across the shared table.
    expect(queryInThread(/the approval|open it to choose/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  // `ok` is the ONLY test for delivery. A pass at the type-narrowing problem widened this branch to
  // `r.ok || r.path === "picker-option" || r.path === "free-text"`, which meant an ok:false result
  // carrying a delivered-looking path reported success and returned true — silently DISCARDING the
  // user's draft on a failure that used to restore it (roborev 53018). The two fields are
  // independent on ConciergeDispatchResult, so nothing but this test stops that coming back.
  it.each(["free-text", "picker-option", "queued"] as const)(
    "an ok:false result carrying the delivered path %s is still a refusal — draft kept",
    async (path) => {
      routeToAgent();
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      renderWithTarget();
      await send("must not vanish");
      expect(await findInThread(/I couldn't send that to @CI Hardening\./)).toBeTruthy();
      // …and no "I'll send it the moment it's ready" promise either — that lie is the same shape.
      expect(queryInThread(/still starting up/)).toBeNull();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("must not vanish");
    },
  );

  // The prompt-side throwing path. Worse than silence here: the catch is also the ONLY thing
  // returning false on an exception, so deleting it discards the user's draft (roborev 53111).
  it("a THROWING prompt says so AND gives the draft back", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockRejectedValueOnce(new Error("pty write failed"));
    renderWithTarget();
    await send("worth not retyping");
    expect(await findInThread(/^I couldn't reach @CI Hardening's terminal\.$/)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  it("puts the draft BACK in the box when the send fails", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    await send("a paragraph nobody wants to retype");
    await findInThread(/didn't send/i);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "a paragraph nobody wants to retype",
    );
  });

  it("does NOT restore the draft on a successful send", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    await send("landed fine");
    // The settle signal, not the subject of the test: wait until the send has visibly landed before
    // reading the box. The sent card is what says so now (see the import note above).
    await within(thread()).findByTestId(SENT_TO_AGENT_TESTID);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  // The aim is captured AT SUBMIT, not re-read when the queue reaches the message: selection moves
  // for reasons unrelated to the box (a nudge's "Show me", a notification reveal, a tab click), and
  // a late lookup would deliver the user's paragraph to whichever agent happened to be selected
  // (roborev 46284-M4). Pinning used to be the toggle's job; with routing it is the queue's.
  it("delivers a QUEUED send to the agent aimed at when THAT message was submitted", async () => {
    let release: (() => void) | undefined;
    h.routeMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ target: "agent", reason: "test", source: "heuristic" });
        }),
    );
    const { rerender } = renderWithTarget();
    type("for the agent I aimed at");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // Something else changes the selected agent while the send is still routing.
    const feed2 = feedWith("approval") as ConciergeFeed;
    (feed2.projects[0]!.agents as unknown[]).push({
      ...feed2.projects[0]!.agents[0]!,
      id: "other",
      name: "Something Else",
    });
    h.feed = feed2;
    await act(async () => {
      rerender(
        <ConciergeHost
          feed={feed2}
          promptTarget={{ projectId: "p1", agentId: "other", name: "Something Else" }}
        />,
      );
    });
    await act(async () => {
      release!();
    });
    // This row drives the queue by hand rather than through `send()`, so the countdown has to be
    // elapsed explicitly. The intent is armed the moment routing resolves; waiting for it (rather
    // than for the dispatch) is also what pins the fix — the send is HELD here, not delivered.
    await waitFor(() => expect(armedIntents()).toHaveLength(1));
    // …and it is aimed at the agent that was selected AT SUBMIT, not the one selected now.
    expect(armedIntents()[0]!.targetAgentId).toBe("ag1");
    await elapseCountdowns();
    await waitFor(() =>
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "for the agent I aimed at", {
        // Routed sends reach the PTY only via the countdown gate — never a silent router dispatch.
        authority: { kind: "countdown", intentId: expect.any(String) },
        userPrompt: true,
        display: "for the agent I aimed at",
        namingBasis: "for the agent I aimed at",
        // FALSE for every send in this file: none of them is @-addressed, so each keeps the
        // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
        neverPickerAnswer: false,
      }),
    );
  });

  // Two sends whose ROUTING resolves out of order must still reach the PTY in submit order —
  // routing is a network round trip, so without the chain the second can overtake the first and
  // silently reorder the user's instructions.
  it("delivers rapid sends in submit order even when routing resolves out of order", async () => {
    const toAgent = { target: "agent" as const, reason: "test", source: "heuristic" as const };
    // "first" routes SLOWLY, "second" instantly — the exact race that would reorder PTY writes.
    // Keyed on the TEXT, not on call order: the chain means the second send's classify does not
    // even start until the first has settled, so a positional mock would hand the second send's
    // gate to a call that never happens.
    let releaseFirst: (() => void) | undefined;
    h.routeMessage.mockImplementation((text: string) =>
      text === "first"
        ? new Promise((resolve) => {
            releaseFirst = () => resolve(toAgent);
          })
        : Promise.resolve(toAgent),
    );
    renderWithTarget();
    type("first");
    type("second");
    // The chain starts on a microtask, so wait until "first" is actually in flight before
    // releasing it — otherwise the gate doesn't exist yet and the test proves nothing.
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await act(async () => {
      releaseFirst!();
    });
    // Both sends now ARM before either delivers, so the ordering guarantee has to hold across the
    // gate as well: elapse them in the order they were armed (which is what the real timers do —
    // same class, same delay, armed first fires first) and the PTY writes must still come out in
    // submit order.
    await waitFor(() => expect(armedIntents()).toHaveLength(2));
    expect(armedIntents().map((i) => i.text)).toEqual(["first", "second"]);
    await elapseCountdowns();
    await waitFor(() => expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2));
    expect(h.dispatchConciergeAnswer.mock.calls.map((c) => c[1])).toEqual(["first", "second"]);
  });

  // The aim is captured before a NETWORK call. If the agent closes while we classify, dispatching
  // at it surfaces as pty-gone where the router's own design says to take the safe direction.
  it("falls back to Sparkle when the agent disappears mid-routing", async () => {
    let release: (() => void) | undefined;
    h.routeMessage.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ target: "agent", reason: "test", source: "heuristic" });
        }),
    );
    const { rerender } = renderWithTarget();
    type("meant for the agent");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // The agent is closed while the classify is in flight.
    const empty = { projects: [], counts: EMPTY_COUNTS, scopedCounts: EMPTY_COUNTS, pinnedProjectId: null };
    await act(async () => {
      rerender(<ConciergeHost feed={empty as unknown as ConciergeFeed} promptTarget={null} />);
    });
    await act(async () => {
      release!();
    });
    await settle();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // The box clears on submit, so a bubble that waited for routing left a second rapid send with no
  // visible state at all for up to the route deadline plus a round trip.
  it("shows both bubbles immediately, even while the first is still routing", async () => {
    h.routeMessage.mockImplementation(() => new Promise(() => {}));
    renderWithTarget();
    type("first");
    type("second");
    expect(inThread("first")).toBeTruthy();
    expect(inThread("second")).toBeTruthy();
  });

  // The queue must always settle FULFILLED: a rejected promise parked in the chain hands the
  // rejection to ComposeBox, whose `.then(ok => …)` has no rejection arm — so the draft would not
  // be restored and the user's text would be lost.
  it("a REJECTING send does not stall the one queued behind it", async () => {
    routeToAgent();
    h.routeMessage.mockRejectedValueOnce(new Error("router exploded"));
    renderWithTarget();
    type("doomed");
    await settle();
    await send("but this one lands");
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "but this one lands",
      expect.anything(),
    );
  });
});

// ── The presence seam, wired for real ────────────────────────────────────────────────────────────
// Design §5 "Integration obligation": `shouldDispatchOnExpiry` and its unit tests live in
// services/dispatchIntent, but the WIRING — that the host reads the actual presenceStore rather
// than a literal — is its own obligation, and these are the rows that fail until it exists.
//
// This is not belt-and-braces. The earlier draft passed a literal `"here"` into the arm site, which
// type-checks, lints clean and passes every unit test in dispatchIntent while destructive sends fire
// at an unattended machine. Only a test that moves the REAL store can tell the two apart.
describe("ConciergeHost — presence governs what an expiry may do", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget() {
    h.feed = feedWith("approval");
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={target} />);
  }

  /** Submit and let routing resolve — stopping at ARMED, so the row itself chooses when (and under
   *  which presence) the countdown elapses. That choice is the entire subject of this suite. */
  async function send(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
    await flush();
  }

  /** Move the REAL store, the way blur does. Not a mock — a stub here would let the host read a
   *  literal and still pass, which is precisely the failure being guarded against. */
  async function goAway() {
    await act(async () => {
      usePresenceStore.getState().setAway();
    });
  }
  async function comeBack() {
    await act(async () => {
      usePresenceStore.getState().setHere();
    });
  }

  beforeEach(() => {
    h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
  });

  it("a DESTRUCTIVE send expiring while Away queues — and is still retrievable", async () => {
    renderWithTarget();
    // Destructive off the SHARED approval taxonomy, not a bespoke list of scary verbs — locked
    // decision 3 (design §1). `classifyCategory` reads this as `bash`, which the conservative
    // auto-approve preset withholds, which is what makes it destructive here too.
    await send("run the deploy command");
    expect(armedIntents()[0]!.class, "this text must land in the 5s tier").toBe("destructive");

    await goAway();
    await elapseCountdowns();

    expect(
      h.dispatchConciergeAnswer,
      "a destructive expiry at an unattended machine must not reach the PTY",
    ).not.toHaveBeenCalled();
    // HELD, not dropped — the message is still there, whole.
    expect(queuedIntents()).toHaveLength(1);
    expect(queuedIntents()[0]!.text).toBe("run the deploy command");
    expect(await findInThread(/I'm holding it rather than sending it to @CI Hardening/)).toBeTruthy();
  });

  it("a ROUTINE send expiring while Away still goes — the rule holds back one class, not all", async () => {
    renderWithTarget();
    await send("add retry logic to the webhook");
    expect(armedIntents()[0]!.class).toBe("routine");

    await goAway();
    await elapseCountdowns();

    await waitFor(() => expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1));
    expect(queuedIntents()).toHaveLength(0);
  });

  it("coming back re-presents the held send with a fresh countdown, and it then delivers", async () => {
    renderWithTarget();
    await send("run the deploy command");
    await goAway();
    await elapseCountdowns();
    expect(queuedIntents()).toHaveLength(1);

    await comeBack();

    // Back in front of the user, counting again — and back in the banner they can cancel from.
    expect(queuedIntents()).toHaveLength(0);
    expect(armedIntents()).toHaveLength(1);
    expect(screen.getByTestId("countdown-banner")).toBeTruthy();

    await elapseCountdowns();
    await waitFor(() =>
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
        "ag1",
        "run the deploy command",
        expect.objectContaining({ authority: { kind: "countdown", intentId: expect.any(String) } }),
      ),
    );
  });

  it("re-presents TWO held sends one at a time — never two countdowns at once", async () => {
    renderWithTarget();
    await send("run the deploy command");
    await send("bash scripts/land.sh");
    await goAway();
    await elapseCountdowns();
    expect(queuedIntents(), "both destructive sends must be held").toHaveLength(2);

    await comeBack();

    // THE assertion the single announcer forces: one banner, one countdown, one thing to react to.
    expect(armedIntents(), "only the head may arm on return").toHaveLength(1);
    expect(screen.getAllByTestId("countdown-banner")).toHaveLength(1);
    expect(queuedIntents()).toHaveLength(1);

    // The second follows only once the first has resolved.
    await elapseCountdowns();
    await waitFor(() => expect(armedIntents()).toHaveLength(1));
    expect(screen.getAllByTestId("countdown-banner")).toHaveLength(1);
    await elapseCountdowns();
    await waitFor(() => expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2));
  });
});

// The receipt is what makes inference defensible (PRD §3). Without it a misroute is silent, which
// is precisely the objection the removed target toggle existed to answer.
describe("ConciergeHost — routing receipts", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget(t: typeof target | null = target) {
    h.feed = feedWith("approval");
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={t} />);
  }

  async function send(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
  }

  it("names the agent on a message routed to the terminal", async () => {
    routeToAgent();
    renderWithTarget();
    await send("add retry logic");
    // THE CLAIM IS UNCHANGED — a terminal-routed message says where it went — but the element that
    // carries it moved INSIDE the user's own bubble, and the name is now a live `AgentPill` the
    // founder can click rather than the dead text that made him work it out by hand.
    const row = await within(thread()).findByTestId(SENT_TO_AGENT_TESTID);
    expect(row.textContent).toContain("Sent to:");
    expect(row.textContent).toContain("CI Hardening");
    // …and it is INSIDE the bubble, which is the whole of what he asked for. Asserting only that the
    // row exists would pass against a version that left it hanging underneath.
    expect(within(thread()).getByTestId("you-bubble").contains(row)).toBe(true);
  });

  // ══ NO RECEIPT SENTENCE FOR AN ORDINARY CONCIERGE ANSWER (founder, 2026-08-04) ════════════════
  // This asserted "→ Answered here". He asked for that gone: the concierge answering in place is
  // self-evident from the reply appearing directly beneath it, so the line was noise on every turn.
  // The receipt ROW stays — it hosts the redirect — so this pins the row present and the sentence
  // absent, which is exactly the change and would fail if either half regressed.
  // NO RECEIPT ELEMENT AT ALL now, not merely no sentence. The row previously survived an empty
  // sentence because it hosted the "Also ask" redirect; with that button removed there is nothing
  // left to host, and that strip belongs to the per-message status (Concierge/MessageStatus).
  it("shows no receipt at all when the concierge answered in place", async () => {
    renderWithTarget();
    await send("what's going on?");
    // The bubble is the settle signal: `send` awaits routing, so once the user's message is in the
    // thread the receipt (if any) has been stamped.
    expect(await within(thread()).findByTestId("you-bubble")).toBeTruthy();
    expect(within(thread()).queryByTestId("routing-receipt")).toBeNull();
    expect(within(thread()).queryByText(/Answered here/)).toBeNull();
  });

  // "→ Sent to CI Hardening" over a message that never arrived would be a plain lie; the failure
  // is already explained in the thread.
  it("posts NO receipt when the delivery failed", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    await send("never lands");
    await findInThread(/didn't send/i);
    expect(within(thread()).queryByTestId("routing-receipt")).toBeNull();
  });




  // With the target pill gone the receipt is the ONLY routing signal a screen-reader user gets, so
  // rendering it without announcing it would leave them with nothing.
  it("announces the routing through the column's live region", async () => {
    routeToAgent();
    renderWithTarget();
    await send("add retry logic");
    expect(screen.getByTestId("concierge-announcer").textContent).toBe("→ Sent to CI Hardening");
  });




});

// The recommended-action row, re-homed above the compose box (PRD §4). Real build agents lost their
// composer at CM-U7 and the suggestion row went with it; this is where it lives now.
describe("ConciergeHost — recommended actions", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  it("mounts the row for the actively-shown agent", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={target} />);
    expect(screen.getByTestId("suggestions-row").getAttribute("data-agent")).toBe("ag1");
    expect(h.suggestionVisible).toBe(true);
  });

  // The engine follows the SELECTION; only the rendering follows the VIEW. Unmounting the hook
  // when the user glances at the Plan board would silently stop auto-approve (roborev 53074).
  it("keeps the engine mounted but hidden when the agent's pane isn't shown", () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={target}
        promptTargetShown={false}
      />,
    );
    expect(screen.getByTestId("suggestions-row")).toBeTruthy();
    expect(h.suggestionVisible).toBe(false);
  });

  // The other half of promptTargetShown: an imperative typed while looking at the Plan board must
  // not be written into a terminal the user cannot see.
  it("a send is NOT routed at an agent whose pane isn't shown", async () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={target}
        promptTargetShown={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).toHaveBeenCalledWith("add retry logic", { agent: null });
  });

  it("mounts NO row when no build agent is in view", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={null} />);
    expect(screen.queryByTestId("suggestions-row")).toBeNull();
  });

  // useSuggestions owns ONE agent per instance by design; a shared instance with a changing id kept
  // the previous agent's buttons on screen and would write their keystroke into the newly-selected
  // agent's PTY (roborev 53043 HIGH). key={agentId} is what makes each a fresh instance.
  it("gives each agent its OWN row instance rather than reusing one", async () => {
    const feed2 = feedWith("approval") as ConciergeFeed;
    (feed2.projects[0]!.agents as unknown[]).push({
      ...feed2.projects[0]!.agents[0]!,
      id: "ag2",
      name: "Other Agent",
    });
    h.feed = feed2;
    const { rerender } = render(
      <ConciergeHost feed={feed2} promptTarget={target} />,
    );
    await act(async () => {
      rerender(
        <ConciergeHost
          feed={feed2}
          promptTarget={{ projectId: "p1", agentId: "ag2", name: "Other Agent" }}
        />,
      );
    });
    expect(h.suggestionMounts).toEqual(["ag1", "ag2"]);
  });

  // QUEUE ONCE. onApply wraps the WHOLE action, so the delivery it calls must not queue again:
  // a second enqueue would chain onto the very promise awaiting it — a circular wait broken only
  // by the 30s task timeout, i.e. a stall of every send, redirect and Approve (roborev 53196).
  it("queues a suggestion ONCE — the delivery inside onApply must not re-enter the queue", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={target} />);
    const props = h.suggestionProps!;
    let delivered = false;
    await act(async () => {
      await props.onApply(async () => {
        delivered = await props.onDeliverPrompt("do the thing");
        return delivered;
      });
    });
    expect(delivered).toBe(true);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "do the thing", {
      // The user clicked a recommended-action pill.
      authority: { kind: "suggestion", agentId: "ag1" },
      userPrompt: true,
      display: "do the thing",
      namingBasis: "do the thing",
      // FALSE for every send in this file: none of them is @-addressed, so each keeps the
      // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
      neverPickerAnswer: false,
    });
    // A suggestion click posts no receipt, so this is the one delivery that DOES say so itself.
    expect(await findInThread(/^Sent to @CI Hardening\.$/)).toBeTruthy();
  });
});
// A queued prompt is a PROMISE ("I'll send that when it's ready"). Whatever happens to it later
// has to come back into the thread, or the user is told something that never becomes true.
describe("ConciergeHost — reconciling a queued prompt", () => {
  function renderHost() {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
  }

  it("confirms the delayed delivery once the agent comes up", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: true, path: "free-text", agentId: "ag1", sent: "start on the docs" }));
    // Includes the QUOTE: every test here passes `sent`, but none asserted it, so dropping the
    // interpolation passed — and the quote is the only thing telling the user WHICH held message
    // an outcome refers to when several were queued (roborev 53123).
    expect(
      await findInThread(/@CI Hardening is up — I sent your message \("start on the docs"\)\./),
    ).toBeTruthy();
  });

  it("says so when the hold aged out instead of leaving the promise dangling", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "never sent" }));
    // The quote matters MOST here: this is the arm whose copy explicitly instructs the user to
    // send it again, and flushPendingSends emits one expired outcome per aged-out entry, so an
    // unattributable message is the costliest of the three (roborev 53162).
    expect(
      await findInThread(/never came up, so I dropped the message I was holding \("never sent"\)\./),
    ).toBeTruthy();
  });

  it("says so when the terminal closed before the held prompt could land", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "pty-gone", agentId: "ag1", sent: "gone" }));
    expect(
      await findInThread(/closed before I could send the message I was holding \("gone"\)\./),
    ).toBeTruthy();
  });

  // An UNKNOWN path must not inherit the terminal-closed wording. `pty-gone` is now its own arm,
  // so the catch-all gives a reason it can always stand behind — letting a new path fall into a
  // specific claim is exactly how 46485-M shipped a falsehood the first time (roborev 53162).
  //
  // The assertion is BRANCH-SPECIFIC on the catch-all's own verb — "didn't", where `abandoned`
  // says "couldn't". They were briefly identical (which un-pinned `abandoned` outright), then
  // prefix-related (which left them separable only by the `$` below). Distinct words mean this row
  // keeps working even if someone later writes an unanchored matcher (roborev 53187/53198).
  //
  // Driven by `agent-failed`: a real union member that has no arm TODAY. If it ever gains one,
  // this row fails loudly and should be repointed at another armless member.
  it("a path the ladder doesn't know states only the reason — no terminal claim, no wrong remedy", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "agent-failed", agentId: "ag1", sent: "held" }));
    expect(
      await findInThread(/^@CI Hardening didn't take the message I was holding \("held"\)\.$/),
    ).toBeTruthy();
    expect(queryInThread(/terminal closed before I could send/)).toBeNull();
    // Not the `abandoned` arm's wording, and no remedy: `agent-failed` needs a Retry and a cloud
    // agent is never "running" locally, so that instruction would never come true.
    expect(queryInThread(/couldn't take the message/)).toBeNull();
    expect(queryInThread(/Send it again once it's running/)).toBeNull();
  });

  // The ABANDONED arm — the one branch here that ALREADY shipped a falsehood once. Its own comment
  // records the history: `abandoned` used to be reported as "the terminal closed", which is false
  // when the spawn failed and no terminal ever opened (roborev 46485-M). Nothing held the corrected
  // string, so mis-gating it drops through to the else and reinstates exactly that lie, green
  // (roborev 53123). The negative half matters most — these two lines are what drifted before.
  it("says the agent couldn't TAKE the held message — not that a terminal closed", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "abandoned", agentId: "ag1", sent: "held" }));
    // WITH the quote: it matters most on non-delivery. `abandonPendingSends` emits one outcome per
    // held entry, so several of these can land for the same agent at once, and the quote is the
    // only thing telling the user which text to retype (roborev 53142).
    // Anchored on the FULL abandoned line including its remedy clause — that clause is what
    // separates this arm from the catch-all, so matching only the reason would let a mis-gated
    // `abandoned` fall through and still pass (roborev 53187).
    expect(
      await findInThread(
        /^@CI Hardening couldn't take the message I was holding \("held"\)\. Send it again once it's running\.$/,
      ),
    ).toBeTruthy();
    expect(queryInThread(/terminal closed before I could send|never came up/)).toBeNull();
  });

  // The anonymous fallback is a LIVE path: the outcome can arrive after the agent has left the
  // feed. Nothing covered it, so a change to a non-guarding form would render
  // "undefined is up — I sent your message" — the same literal-undefined report the matchedLabel
  // guard was added to prevent one commit ago (roborev 53123).
  //
  // PINNED ON THE SYMBOL, NOT THE LITERAL (roborev 63539, Medium). Written as `/^that agent is up/`
  // this test kept passing while an edit to `ANONYMOUS_SUBJECT` split the thread's wording — the row
  // here saying the old words two lines above receipt rows saying the new ones. A literal
  // expectation for shared copy does not guard the copy; it pins the drift.
  //
  // Built as a STRING, not a regex. `findInThread`'s string arm is an exact-text match, so it needs
  // no anchors — and interpolating user-facing copy into a `new RegExp` is the hazard the sibling
  // guard in `receiptRuns.test.ts` was flagged for: the whole premise of the symbol is that this
  // wording gets edited, and the first metacharacter in it either throws or silently loosens the
  // match.
  it("names an agent that has left the feed generically, never 'undefined'", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: true, path: "free-text", agentId: "gone-from-feed", sent: "x" }));
    expect(
      await findInThread(
        `${ANONYMOUS_SUBJECT} is up — I sent your message ("x").`,
      ),
    ).toBeTruthy();
    expect(queryInThread(/undefined/)).toBeNull();
  });

  it("quotes the DISPLAY rendering back, never the payload with its temp paths", async () => {
    // The whole point of the three-way split (roborev 46911/46925): `sent` is the wire payload.
    // Quoting it here would print '/var/folders/…png look at this' into the thread — the one
    // surface `display` exists to protect — three lines below the code that avoids exactly that.
    renderHost();
    act(() =>
      h.deferred?.({
        ok: true,
        path: "free-text",
        agentId: "ag1",
        sent: "'/var/folders/x9/T/sparkle-shot-1753.png' look at this",
        display: "look at this · 1 image",
      }),
    );
    expect(await findInThread(/"look at this · 1 image"/)).toBeTruthy();
    expect(within(thread()).queryByText(/sparkle-shot-1753\.png/)).toBeNull();
  });
});

// DIGEST, don't enumerate (bead sparkle-4562.4). Eight P0s and nineteen P1s meant twenty-seven
// cards stacked above the compose box — the chat pushed off screen, and column one reduced to an
// unreadable copy of column two.
describe("ConciergeHost — digest instead of a card wall", () => {
  /** A feed with `n` needs-you agents in one project. */
  function feedOf(n: number) {
    const agents = Array.from({ length: n }, (_, i) => ({
      id: `ag${i}`,
      name: `Agent ${i}`,
      projectId: "p1",
      projectName: "sparkle-desktop",
      kind: "build" as const,
      status: "approval",
      statusColor: "#e0533f",
      statusLabel: "Approve?",
      band: "needs_you" as const,
      inScope: true,
      muted: false,
      topLevel: true,
      // Nothing above it in the tree, so no ancestor row can be speaking for it.
      representedElsewhere: false,
    }));
    const counts: Record<StatusBand, number> = { ...EMPTY_COUNTS, needs_you: n };
    return {
      projects: [
        { id: "p1", name: "sparkle-desktop", inScope: true, counts, scopedCounts: counts, agents },
      ],
      counts,
      scopedCounts: counts,
      pinnedProjectId: null,
    };
  }

  it("keeps the card when only one item needs attention", () => {
    h.feed = feedOf(1);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.queryByTestId("concierge-digest")).toBeNull();
    expect(inThread("Approve")).toBeTruthy(); // the card's action
  });

  it("collapses a wall of cards into ONE line", () => {
    h.feed = feedOf(8);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    const digests = screen.getAllByTestId("concierge-digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.textContent).toContain("8 Need you in sparkle-desktop");
    // …and no per-agent cards survive to bury the chat.
    expect(queryInThread("Approve")).toBeNull();
  });

  it("the digest line hands off to column two", () => {
    h.feed = feedOf(5);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag0");
  });

  it("leaves the chat reachable — a reply still renders alongside the digest", async () => {
    h.feed = feedOf(8);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.done?.({ id: "1", text: "Here is what needs you." }));
    expect(await findInThread("Here is what needs you.")).toBeTruthy();
    expect(screen.getAllByTestId("concierge-digest")).toHaveLength(1);
  });
});

// ─── Return-from-Away recap (design §3 A5) ──────────────────────────────────────────────────────
// The store's own transitions are exhaustively covered in stores/presenceStore.test.ts; these rows
// test only the HOST's half — snapshot at the Away edge, diff and post one card on the way back.
describe("ConciergeHost — Away → Here recap", () => {
  // TWO THINGS THESE ROWS PIN, both of which the first cut got wrong (roborev 53631):
  //
  //  1. The diff reads the FEED's status, not runtimeStore's. The feed's is the derived/published
  //     one every card and label in the thread already speaks (publishedStatusFor: cross-window
  //     roster + the worker/unmerged/dismissed-alert overlays), and runtimeStore only holds agents
  //     THIS window hosts. So a row drives a change by RE-RENDERING with a new feed — and one row
  //     below leaves runtimeStore empty entirely, which is the cross-window agent's shape.
  //  2. The recap is gated on stretch LENGTH (conciergeRecap.MIN_AWAY_MS), so every row has to
  //     advance a clock. A ⌘-tab-length stretch is a full Away→Here cycle and must stay silent.
  const T0 = 1_700_000_000_000;
  let clockNow = T0;
  let clock: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    clockNow = T0;
    clock = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
  });
  // Restored HERE rather than by the file's afterEach: that one calls vi.resetAllMocks(), which
  // would strip the implementation off this spy and leave `Date.now()` returning undefined for
  // every later row. (Inner afterEach hooks run before outer ones, so this wins.)
  afterEach(() => {
    clock?.mockRestore();
    clock = null;
  });

  const away = () => act(() => usePresenceStore.getState().setFocused(false));
  const back = () => act(() => usePresenceStore.getState().setFocused(true));

  const setStatus = (status: AgentTabStatus) =>
    useRuntimeStore.setState({ status: { ag1: status } });

  it("posts a card naming what changed, and announces the same sentence", () => {
    h.feed = feedWith("working", "running");
    setStatus("working");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 12 * 60_000;
    setStatus("waiting");
    rerender(<ConciergeHost feed={feedWith("waiting", "needs_you", "Needs you") as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(card.textContent).toContain("While you were away");
    expect(card.textContent).toContain("1 needs you");
    expect(within(card).getAllByTestId("recap-change")).toHaveLength(1);
    // The SAME sentence, through the column's existing single live region — not a second one.
    const live = screen.getByRole("status");
    expect(live.textContent).toContain("While you were away");
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("reports the ORDINARY finish — working → idle, the case the card exists for", () => {
    // `idle` ("Done — your turn") is what the Stop hook emits; `done` also means LANDED and is
    // rare. Every row here used to drive `done`, which is why none of them caught a recap that
    // stayed silent on the walk-away-and-come-back case (roborev 53631-H1).
    h.feed = feedWith("working", "running");
    setStatus("working");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 40 * 60_000;
    setStatus("idle");
    rerender(
      <ConciergeHost feed={feedWith("idle", "done", "Done — your turn") as ConciergeFeed} />,
    );
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(card.textContent).toContain("1 finished");
    expect(within(card).getByTestId("recap-change").getAttribute("data-status")).toBe("idle");
    expect(card.textContent).toContain("Done — your turn");
  });

  it("reports an agent it does NOT host — the feed is the only place it exists", () => {
    // A roster-fed agent from another window: absent from runtimeStore.status on both edges, so a
    // diff of that map skipped it entirely while the thread rendered a nudge card for it. On a
    // column pinned to a project this window doesn't host, that made the recap unable to fire.
    useRuntimeStore.setState({ status: {} });
    h.feed = feedWith("working", "running");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 20 * 60_000;
    rerender(<ConciergeHost feed={feedWith("waiting", "needs_you", "Needs you") as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(within(card).getByTestId("recap-change").getAttribute("data-status")).toBe("waiting");
    expect(useRuntimeStore.getState().status).toEqual({});
  });

  it("posts nothing when only a derived OVERLAY moved — no agent did anything", () => {
    // The feed's status is the derived one, and `branchStatus` boots empty: after a relaunch a
    // persisted agent reads `idle` until the first branch poll escalates it to `unmerged`. Launch,
    // ⌘-tab away, come back — that must not be "1 finished" for every agent with an old branch
    // (roborev 53652). Reading the derived map is right; treating its churn as news is not.
    h.feed = feedWith("idle", "done", "Done — your turn");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 15 * 60_000;
    rerender(<ConciergeHost feed={feedWith("unmerged", "done", "Needs merge") as ConciergeFeed} />);
    back();
    expect(within(thread()).queryByTestId("concierge-recap")).toBeNull();
  });

  it("reports the ordinary finish even when both ENDS look identical", () => {
    // idle → working → idle. The Stop hook maps a finished turn back to `idle`, so an agent that
    // was resting when you left and is resting when you return may still have done a full unit of
    // work in between — and the two-endpoint diff sees nothing at all (roborev 53674).
    h.feed = feedWith("idle", "done", "Done — your turn");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 5 * 60_000;
    rerender(<ConciergeHost feed={feedWith("working", "running", "Working") as ConciergeFeed} />);
    clockNow += 10 * 60_000;
    rerender(<ConciergeHost feed={feedWith("idle", "done", "Done — your turn") as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(card.textContent).toContain("1 finished");
    expect(within(card).getByTestId("recap-change").getAttribute("data-status")).toBe("idle");
  });

  it("reports an agent that STARTED and finished while you were out", () => {
    // Same two endpoints as the overlay row above — idle → unmerged — and the opposite meaning.
    // The host is the only thing that sees the MIDDLE of the stretch (the feed keeps updating
    // while the window is blurred), so it accumulates the evidence and hands it to buildRecap.
    h.feed = feedWith("idle", "done", "Done — your turn");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 5 * 60_000;
    rerender(<ConciergeHost feed={feedWith("working", "running", "Working") as ConciergeFeed} />);
    clockNow += 10 * 60_000;
    rerender(<ConciergeHost feed={feedWith("unmerged", "done", "Needs merge") as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(card.textContent).toContain("1 finished");
    expect(within(card).getByTestId("recap-change").getAttribute("data-status")).toBe("unmerged");
  });

  it("posts NOTHING when nothing changed while away", () => {
    h.feed = feedWith("working", "running");
    setStatus("working");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 12 * 60_000;
    back();
    expect(within(thread()).queryByTestId("concierge-recap")).toBeNull();
  });

  it("stays silent on a ⌘-tab-length stretch, however much moved", () => {
    // Blur → Away is immediate and unconditional (a locked presence decision), so eight seconds in
    // another app is a complete away stretch. A card here is the chrome the user learns to skip.
    h.feed = feedWith("working", "running");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 8_000;
    rerender(<ConciergeHost feed={feedWith("waiting", "needs_you", "Needs you") as ConciergeFeed} />);
    back();
    expect(within(thread()).queryByTestId("concierge-recap")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("While you were away");
  });

  it("posts nothing on a Here → Here no-op", () => {
    h.feed = feedWith("working", "running");
    setStatus("working");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // Never went away, so there is no snapshot to diff against and no stretch to summarise.
    act(() => usePresenceStore.getState().setHere());
    clockNow += 12 * 60_000;
    rerender(<ConciergeHost feed={feedWith("waiting", "needs_you", "Needs you") as ConciergeFeed} />);
    act(() => usePresenceStore.getState().setHere());
    expect(within(thread()).queryByTestId("concierge-recap")).toBeNull();
  });

  it("reports an agent that finished AND landed while you were out", () => {
    h.feed = feedWith("working", "running");
    setStatus("working");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    away();
    clockNow += 12 * 60_000;
    setStatus("done");
    rerender(<ConciergeHost feed={feedWith("done", "done", "Done") as ConciergeFeed} />);
    back();
    const card = within(thread()).getByTestId("concierge-recap");
    expect(card.textContent).toContain("1 finished");
    // OPEN THE CARD FIRST. It is a disclosure since bead `sparkle-o37mn`, and this fixture is the
    // one shape allowed to start collapsed: a single SETTLED row (`done` — finished AND landed),
    // which asks the reader for nothing. The row assertion below is about the recap DIFF, not about
    // the disclosure, so it opens the card rather than changing what it checks.
    fireEvent.click(within(card).getByTestId("recap-disclosure"));
    expect(within(card).getByTestId("recap-change").getAttribute("data-status")).toBe("done");
  });
  // ── A HEAD STANDING IN FOR ITS SUBTREE ────────────────────────────────────────────────────────
  //
  // engine/workerRollup promotes a calm orchestrator to `working` when its workers roll up green,
  // so every surface bands the fleet alike. Two lines in THIS component keep that promotion out of
  // the recap: `feedStatuses` records the promoted ids on the snapshot, and the sawWorking filter
  // skips them. Both were unpinned — deleting either left the suite green while restoring the
  // reported double-count for the common shape (roborev 53931). These rows are that pin.
  const pairFeed = (
    headStatus: string,
    workerStatus: string,
    rolledUpGreen: boolean,
  ) => {
    const mk = (id: string, name: string, status: string, over: Record<string, unknown>) => ({
      id, name, projectId: "p1", projectName: "sparkle", kind: "build" as const,
      status, statusColor: "#8aa0c4", statusLabel: "Done — your turn",
      band: (status === "working" ? "running" : "done") as StatusBand,
      inScope: true, muted: false, representedElsewhere: false, rolledUpGreen: false, ...over,
    });
    const agents = [
      mk("ag1", "Kraken Auth", headStatus, { topLevel: true, rolledUpGreen }),
      mk("w1", "Parser Worker", workerStatus, { topLevel: false, parentId: "ag1" }),
    ];
    const counts = { needs_you: 0, questions: 0, running: 0, done: 0 };
    return {
      projects: [
        { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents },
      ],
      counts, scopedCounts: counts, pinnedProjectId: null,
    };
  };

  it("reports only the WORKER when a promoted head's worker finishes", () => {
    // The common shape: both read `working` at the away edge, but the head's is its subtree's.
    h.feed = pairFeed("working", "working", true);
    useRuntimeStore.setState({ status: { ag1: "working", w1: "working" } });
    const { rerender } = render(<ConciergeHost feed={h.feed as unknown as ConciergeFeed} />);
    away();
    // A MID-STRETCH TICK, and it is what makes this row exercise the sawWorking filter rather than
    // only the snapshot. That effect bails on mount (presence is still `here`) and its dep is
    // `feed`, so `away()` alone never runs it — without a re-render while away, `sawWorking` stays
    // empty and `!a.rolledUpGreen` could be deleted with every test still green (roborev 53936).
    // The real feed does tick like this: it keeps updating while the window is blurred.
    clockNow += 5 * 60_000;
    rerender(
      <ConciergeHost feed={pairFeed("working", "working", true) as unknown as ConciergeFeed} />,
    );
    clockNow += 35 * 60_000;
    useRuntimeStore.setState({ status: { ag1: "idle", w1: "idle" } });
    rerender(<ConciergeHost feed={pairFeed("idle", "idle", false) as unknown as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    const rows = within(card).getAllByTestId("recap-change");
    expect(rows).toHaveLength(1);
    expect(card.textContent).toContain("Parser Worker");
    expect(card.textContent).not.toContain("Kraken Auth");
  });

  // THE CONVERSE, so the filter can't be widened into dropping genuine finishes. Same mid-stretch
  // tick, `rolledUpGreen: false` — the head reaches sawWorking and is reported.
  it("still reports a head that was working under its OWN steam", () => {
    h.feed = pairFeed("working", "working", false);
    useRuntimeStore.setState({ status: { ag1: "working", w1: "working" } });
    const { rerender } = render(<ConciergeHost feed={h.feed as unknown as ConciergeFeed} />);
    away();
    clockNow += 5 * 60_000;
    rerender(
      <ConciergeHost feed={pairFeed("working", "working", false) as unknown as ConciergeFeed} />,
    );
    clockNow += 35 * 60_000;
    useRuntimeStore.setState({ status: { ag1: "idle", w1: "idle" } });
    rerender(<ConciergeHost feed={pairFeed("idle", "idle", false) as unknown as ConciergeFeed} />);
    back();

    const card = within(thread()).getByTestId("concierge-recap");
    expect(within(card).getAllByTestId("recap-change")).toHaveLength(2);
    expect(card.textContent).toContain("Kraken Auth");
  });
});

// ══ CAPTURE / ISLAND HANDOFFS INTO THE COMPOSE BOX ═════════════════════════════════════════════
//
// THE BUG THESE ROWS EXIST FOR. The helper island's capture takeover sends `capture://send`; the
// owning window's router (services/captureSends) created or selected the build agent and then wrote
// the narration + screenshot into `handoffStore.buildDraft`. That store's ONLY reader was the
// per-agent terminal Composer inside AgentPane, which db29f0a48 deleted when the concierge box
// became a build agent's input surface. So the agent got spawned and the user's words and shot were
// dropped — no error, no receipt, and (the reason it survived) zero log output. Confirmed against
// the app logs and the history DB: the spawned agent received no prompt at all.
//
// These drive the REAL dispatch functions, not a hand-built store write, so the whole chain is
// covered: island → dispatchBuild/dispatchChat → composeHandoffStore → this host → the box.
describe("ConciergeHost — capture handoffs land in the compose box", () => {
  const SHOT = { path: "/tmp/sparkle-shot-1753.png", dataUrl: "data:image/png;base64,AAAA" };

  const projects = () =>
    [
      {
        id: "p1",
        name: "sparkle",
        rootPath: "/tmp/sparkle",
        defaultBranch: "main",
        createdAt: "2026-01-01",
        selectedAgentId: null,
        agents: [],
      },
    ] as unknown as Project[];

  beforeEach(() => {
    useProjectStore.setState({ projects: projects() });
    useComposeHandoffStore.setState({ handoff: null });
    usePendingAttachmentsStore.setState({ pending: {} });
    h.feed = feedWith("idle", "running");
  });

  afterEach(() => {
    useComposeHandoffStore.setState({ handoff: null });
    usePendingAttachmentsStore.setState({ pending: {} });
  });

  /** The box itself. `aria-label="Message"` is its accessible name — see ComposeBox. */
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const chips = () => screen.queryByTestId("concierge-attachment-chips");

  /** The agents in whatever feed `h.feed` currently holds — so a row can resolve its prompt target
   *  out of the feed the way Workspace does, instead of asserting against a literal it wrote. */
  const allFeedAgents = () =>
    (h.feed as ConciergeFeed).projects.flatMap((p) => p.agents);

  /** A feed carrying SEVERAL build agents in one project — the shape the wrong-agent race needs.
   *  `deliver` treats absence from the feed as "this agent is gone" and falls back to Sparkle, so a
   *  freshly created agent has to appear here before a send can be routed at it. */
  function feedWithAgents(ids: string[]) {
    const agents = ids.map((id) => ({
      id,
      name: id === "ag1" ? "CI Hardening" : "New Build",
      projectId: "p1",
      projectName: "sparkle",
      kind: "build" as const,
      status: "idle",
      statusColor: "#e0533f",
      statusLabel: "Approve?",
      band: "needs_you" as StatusBand,
      inScope: true,
      muted: false,
      topLevel: true,
      representedElsewhere: false,
    }));
    const counts = { needs_you: agents.length, questions: 0, running: 0, done: 0 };
    return {
      projects: [
        { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents },
      ],
      counts,
      scopedCounts: counts,
      pinnedProjectId: null,
    };
  }

  /** The island's Build ❯ → "New build agent", for real. Returns the id it spawned. */
  function captureToNewBuildAgent(text: string) {
    act(() =>
      dispatchBuild({
        mode: "build",
        projectId: "p1",
        text,
        attachments: [SHOT],
        forceNewAgent: true,
      }),
    );
    const created = useProjectStore
      .getState()
      .projects[0]!.agents.find((a) => a.kind === "build");
    expect(created).toBeTruthy();
    return created!.id;
  }

  // ── THE HEADLINE ROW ─────────────────────────────────────────────────────────────────────────
  it("a Build send to a NEWLY CREATED agent prefills the box AND stages the screenshot", async () => {
    const created = captureToNewBuildAgent("the header is misaligned on narrow windows");
    expect(created).toBeTruthy();
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);

    // The text the user narrated into the capture window is in the box they will press Enter in.
    await waitFor(() =>
      expect(box().value).toContain("the header is misaligned on narrow windows"),
    );
    // …and the shot rides along as a removable chip, not as a temp path pasted into the text.
    const chipRow = screen.getByTestId("concierge-attachment-chips");
    // The shot draws as a THUMBNAIL (the strip is shared with the transcript), so the name is the
    // item's accessible name rather than rendered text.
    expect(
      within(chipRow).getByRole("button", { name: "View sparkle-shot-1753.png" }),
    ).toBeTruthy();
    expect(box().value).not.toContain("/tmp/");
  });

  // The contract the capture flow has always had, and the one thing that must not change while
  // re-homing it: this is a DRAFT. The user reviews it and hits Enter.
  it("does NOT auto-send — nothing reaches an agent or the brain", async () => {
    captureToNewBuildAgent("look at this");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(box().value).toContain("look at this"));
    await settle();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.routeMessage).not.toHaveBeenCalled();
    expect(queryInThread("look at this")).toBeNull(); // no "you" bubble
  });

  it("a handoff arriving while the column is already up lands just the same", async () => {
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(box().value).toBe("");
    captureToNewBuildAgent("this button does nothing");
    await waitFor(() => expect(box().value).toContain("this button does nothing"));
    expect(chips()).toBeTruthy();
  });

  // The guard the deleted Composer consumer carried (roborev 25174), preserved: `take()` reads AND
  // clears, so a replay of the effect cannot paste the narration twice.
  it("consumes the handoff exactly once — the store is emptied on delivery", async () => {
    captureToNewBuildAgent("only once please");
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(box().value).toContain("only once please"));
    expect(useComposeHandoffStore.getState().handoff).toBeNull();
    rerender(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await flush();
    expect(box().value.match(/only once please/g)).toHaveLength(1);
  });

  it("a screenshot with NO narration still stages — an image alone is a message", async () => {
    act(() =>
      dispatchBuild({
        mode: "build",
        projectId: "p1",
        text: "",
        attachments: [SHOT],
        forceNewAgent: true,
      }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(chips()).toBeTruthy());
    expect(box().value).toBe("");
    // canSend treats an attachment alone as sendable, so the user can just press Send.
    //
    // `aria-disabled`, NOT the `disabled` PROPERTY. The tray declines a press it cannot honour
    // without ever disabling the pill, so that the pill stays the tray's roving tab stop
    // (Concierge/SendModeTray). Asserting `disabled` here went VACUOUS the moment that changed:
    // the attribute is now absent in both states, so the row passed whatever `canSend` said —
    // including the regression it exists to catch (roborev 56100).
    expect(screen.getByLabelText("Send").getAttribute("aria-disabled")).toBeNull();
  });

  // ── CHAT MODE (replaces Plan) ────────────────────────────────────────────────────────────────
  it("a Chat send prefills the same box and goes to SPARKLE, bypassing the router", async () => {
    act(() =>
      dispatchChat({
        mode: "chat",
        projectId: "p1",
        text: "what is this error telling me?",
        attachments: [SHOT],
      }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(box().value).toContain("what is this error telling me?"));
    expect(chips()).toBeTruthy();

    fireEvent.click(screen.getByText("Send"));
    await settle();
    // The user CHOSE the concierge by pressing Chat rather than Build, so the router is not asked
    // to guess — even though a build agent is in view and would otherwise be a candidate.
    expect(h.routeMessage).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("the Sparkle aim is consumed by ONE send — the next message routes normally", async () => {
    act(() =>
      dispatchChat({ mode: "chat", projectId: "p1", text: "first", attachments: [] }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(box().value).toContain("first"));
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // A latch that outlived its own message would silently divert every later send to chat.
    expect(h.routeMessage).toHaveBeenCalled();
  });

  it("a Build handoff leaves the aim to the router — it is not forced to Sparkle", async () => {
    captureToNewBuildAgent("add a retry here");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(box().value).toContain("add a retry here"));
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).toHaveBeenCalled();
  });

  // ── THE AIM'S RETIREMENT RULE ────────────────────────────────────────────────────────────────
  // `onTextEdit` is the ONE signal that retires `forceSparkleRef`, and these two rows are why the
  // host must keep passing it. It looked like pure text-to-speech plumbing when voice OUTPUT was
  // removed (§5) — on the older tree it only cleared a dictated-origin latch that fed TTS — but it
  // had since become the capture-Chat aim's only off switch. Dropping it leaves a latch that never
  // clears, so every message the user types after a discarded Chat capture is silently force-aimed
  // at Sparkle. Nothing else in the suite fails when that happens: hence these.

  // Emptying the box by hand retires the aim — the message typed next has nothing to do with the
  // screenshot the user just discarded.
  it("clearing the box by hand retires the Sparkle aim", async () => {
    act(() => dispatchChat({ mode: "chat", projectId: "p1", text: "never mind", attachments: [] }));
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(box().value).toContain("never mind"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).toHaveBeenCalled();
  });

  // The other half of the rule, and the one a naive "just clear it whenever the text is empty"
  // implementation gets wrong: a DICTATED segment is not a hand edit. It arrives through the
  // dictation append (`registerInsert`), never through the textarea's onChange, so it must not
  // report to `onTextEdit` and must not touch the aim. Speaking a follow-up onto a Chat capture is
  // the user continuing that thought — losing the aim there would hand their words to the router
  // and, if a build agent happens to be in view, type them into a live PTY.
  it("a DICTATED segment does not retire the Sparkle aim", async () => {
    act(() => dispatchChat({ mode: "chat", projectId: "p1", text: "about this shot", attachments: [] }));
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(box().value).toContain("about this shot"));

    // The mic, for real: the host's registered append is what the dictation hook calls.
    expect(h.dictationInsert).toBeTruthy();
    act(() => h.dictationInsert!("and what should I do about it"));
    await waitFor(() => expect(box().value).toContain("and what should I do about it"));

    fireEvent.click(screen.getByText("Send"));
    await settle();
    // Still the user's own choice of destination — the router was never consulted.
    expect(h.routeMessage).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // A FRESH COLUMN STARTS WITH NO AIM. Both the draft and the latch that aims it are per-instance,
  // so a new host must not inherit either. (The stronger property — a box remounting UNDER a
  // surviving host — is pinned in ComposeBox.test.tsx, "reports its starting text on mount"; it
  // cannot be driven from here, because unmounting this host resets the very ref under test.)
  it("a fresh column starts with no draft and no Sparkle aim", async () => {
    act(() => dispatchChat({ mode: "chat", projectId: "p1", text: "about this shot", attachments: [] }));
    const { unmount } = render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }}
      />,
    );
    await waitFor(() => expect(box().value).toContain("about this shot"));
    unmount();

    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }}
      />,
    );
    expect(box().value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).toHaveBeenCalled();
  });

  // ── THE WRONG-AGENT RACE ─────────────────────────────────────────────────────────────────────
  // The deleted Composer's guard matched on PROJECT + KIND and never on agentId, so with two build
  // agents in one project a draft meant for the newly created one could be consumed against the
  // other — whichever composer activated first won. The aim is enforced at the DISPATCH end
  // (dispatchBuild selects the named agent synchronously before queueing the draft); this end
  // asserts the invariant loudly rather than silently disagreeing, because `target` is resolved
  // live at send time on purpose and a `forceAgent` latch is ruled out by conciergeRouter.
  // The aim is DERIVED FROM THE STORE here, not handed in as a prop. Passing
  // `promptTarget={{ agentId: created }}` directly would only re-prove that the box delivers to the
  // target it was given, which is not the property at issue (roborev 53843) — the property is that
  // `dispatchBuild`'s synchronous `selectAgent` is what decides that target. So the row asserts the
  // selection first, then builds `promptTarget` out of it, the way Workspace does in the app.
  it("a Build draft aims at the agent dispatchBuild SELECTED, not at whoever was selected before", async () => {
    // Pre-existing build agent, selected before the capture arrives — the "whoever" in the title.
    act(() => useProjectStore.getState().selectAgent("p1", "ag1"));
    const created = captureToNewBuildAgent("fix this crash");
    routeToAgent();

    // THE LINK UNDER TEST: dispatching the capture moved the project's selection onto the agent it
    // named, synchronously, in the same tick it queued the draft.
    const selected = useProjectStore.getState().projects[0]!.selectedAgentId;
    expect(selected).toBe(created);
    expect(selected).not.toBe("ag1");

    // TWO build agents in one project — the shape a project+kind aim could not tell apart.
    h.feed = feedWithAgents(["ag1", created]);
    const live = allFeedAgents().find((a) => a.id === selected)!;
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: live.projectId, agentId: live.id, name: live.name }}
      />,
    );
    await waitFor(() => expect(box().value).toContain("fix this crash"));
    fireEvent.click(screen.getByText("Send"));
    await settle();
    // …and the send follows that selection, so the capture's words reach the agent it was for.
    expect(h.dispatchConciergeAnswer).toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe(created);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).not.toBe("ag1");
  });

  it("warns when the box's live aim is a DIFFERENT agent than the handoff named", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const created = captureToNewBuildAgent("this belongs to the new agent");
    // BOTH agents are in the feed, so `target` resolves and the guard reaches its id comparison —
    // the aim is genuinely a different LIVE agent, not merely an absent one.
    h.feed = feedWithAgents(["ag1", created]);
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }}
      />,
    );
    await waitFor(() => expect(box().value).toContain("this belongs to the new agent"));
    expect(warn.mock.calls.flat().join(" ")).toMatch(/aim disagrees with the compose box/i);
    warn.mockRestore();
  });

  // The emptier failure, and the likelier one: the handoff names a LOCAL, promptable agent that
  // dispatchBuild selected, and the box still has no aim at it — so the draft goes to the
  // auto-router with nothing recording that its target went missing.
  it("warns when the handoff names a local agent but the box has no live aim", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    captureToNewBuildAgent("nobody is aimed at");
    // Default feed — it holds only `ag1`, so the created agent is absent and `target` is null.
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(box().value).toContain("nobody is aimed at"));
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no live aim/i);
    warn.mockRestore();
  });

  // …but a missing aim is NOT always a fault, and a guard that cries wolf gets scrolled past.
  // `decidePromptTarget` returns null for a CLOUD build agent by design — no local PTY, so the box
  // is deliberately Sparkle-only for it — and cloud agents are `kind: "build"`, so both the capture
  // menu and dispatchBuild's reuse branch can land on one. Nothing is wrong there (roborev 53856).
  it("logs the cloud case as INFO instead of warning — that null aim is by design", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    // The INFO is asserted POSITIVELY, not just the absence of the warnings. A negative-only row
    // cannot tell a quiet branch from a DELETED one — emptying the cloud arm would leave a cloud
    // capture traceless in the very guard this exists to make truthful — nor from the guard never
    // being reached at all (roborev 53874).
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    act(() =>
      useProjectStore.setState({
        projects: [
          {
            ...useProjectStore.getState().projects[0]!,
            agents: [{ id: "cloud1", name: "Cloud Build", kind: "build", runtime: "cloud" }],
          },
        ] as unknown as Project[],
      }),
    );
    act(() =>
      dispatchBuild({
        mode: "build",
        projectId: "p1",
        text: "look at this in the cloud",
        attachments: [SHOT],
        targetAgentId: "cloud1",
      }),
    );
    // No promptTarget: exactly what Workspace passes for a cloud selection.
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(box().value).toContain("look at this in the cloud"));
    // The branch SPOKE, and named the agent — so deleting it turns this row red.
    const cloudLine = info.mock.calls.find((c) => /cloud agent/i.test(String(c[1])));
    expect(cloudLine).toBeTruthy();
    expect(cloudLine![2]).toMatchObject({ handoffAgentId: "cloud1", projectId: "p1" });
    // …and it did so INSTEAD of any of the three warnings.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/no live aim|aim disagrees|no longer has/i);
    info.mockRestore();
    warn.mockRestore();
  });

  // The other genuinely faulty shape, kept distinct from the cloud case above: the named agent is
  // not in this window's project at all, so there is nothing for the draft to be aimed at.
  it("warns when the handoff names an agent this window no longer has", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    act(() =>
      useComposeHandoffStore.getState().set({
        origin: "capture-build",
        projectId: "p1",
        agentId: "vanished",
        text: "its agent is gone",
        attachments: [],
      }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    await waitFor(() => expect(box().value).toContain("its agent is gone"));
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no longer has/i);
    warn.mockRestore();
  });

  it("stays quiet when the aim agrees — the guard is not noise on the happy path", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const created = captureToNewBuildAgent("aimed correctly");
    // The created agent must be IN THE FEED, or `target` is null and the guard short-circuits
    // before ever comparing ids — the agreeing branch would go unexercised and an inverted
    // comparison would survive this row untouched (roborev 53843).
    h.feed = feedWithAgents(["ag1", created]);
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: created, name: "New Build" }}
      />,
    );
    await waitFor(() => expect(box().value).toContain("aimed correctly"));
    // Neither branch may fire: not the mismatch, and not the no-live-aim one either.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/aim disagrees|no live aim/i);
    warn.mockRestore();
  });

  // ── THE OTHER ORPHANED HANDOFF ───────────────────────────────────────────────────────────────
  // Files dropped on "+ New Build Agent" (hooks/useNewBuildAgentDrop) were queued for an agent
  // whose composer no longer exists. Same drop, same silence — re-homed to the same box.
  it("drains files dropped on '+ New Build Agent' onto the box", async () => {
    usePendingAttachmentsStore.getState().add("ag1", ["/tmp/dropped.png"]);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await waitFor(() => expect(usePendingAttachmentsStore.getState().pending).toEqual({}));
    // DRAINED IS NOT DELIVERED. Emptying the queue and then failing to stage the file is the same
    // silent loss this whole change removes, just one surface along — the old Composer test asserted
    // the chip and gave that up when the behaviour moved here, so this row has to carry it.
    expect(h.loadAttachmentPaths).toHaveBeenCalledWith(["/tmp/dropped.png"]);
    const chipRow = await screen.findByTestId("concierge-attachment-chips");
    expect(within(chipRow).getByText("dropped.png")).toBeTruthy();
  });

  // THE CONCIERGE'S OWN WRITE, WHICH ARRIVES MID-MOUNT (roborev 55403).
  //
  // Every case above seeds the queue BEFORE render, so the target changes and the effect runs. The
  // `attachments` domain's `attach_to_message` is the other writer and it does not move the target:
  // the human is usually already talking about the agent being attached to. With the effect keyed
  // only on the target id, nothing re-ran, the queue was never drained, and the tool still replied
  // "Staged … they ride along with the next message". Assert the SIDE EFFECT — the file staged and
  // a chip on screen — not that the queue emptied, which would pass on a drain that delivered
  // nothing.
  it("stages a file queued AFTER mount for the agent already aimed at", async () => {
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }}
      />,
    );
    await flush();
    expect(h.loadAttachmentPaths).not.toHaveBeenCalled();

    // The concierge stages a file while the aim never moves.
    await act(async () => {
      usePendingAttachmentsStore.getState().add("ag1", ["/tmp/from-concierge.png"]);
    });

    await waitFor(() => expect(h.loadAttachmentPaths).toHaveBeenCalledWith(["/tmp/from-concierge.png"]));
    const chipRow = await screen.findByTestId("concierge-attachment-chips");
    expect(within(chipRow).getByText("from-concierge.png")).toBeTruthy();
  });

  it("leaves another agent's queued drop alone", async () => {
    usePendingAttachmentsStore.getState().add("someone-else", ["/tmp/theirs.png"]);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }} />);
    await flush();
    expect(usePendingAttachmentsStore.getState().drain("someone-else")).toEqual([
      "/tmp/theirs.png",
    ]);
  });
});

// ── THE CABLE REACHES THE COLUMN ──────────────────────────────────────────────────────────────
//
// `ConciergeColumn` has carried the flood and the lift since the cockpit landed, and
// `ConciergeColumn.wired.test.tsx` has asserted both — GIVEN THE PROP. Nothing passed it. The prop
// defaults to "off", so wiring an agent moved the shell root's `data-wired` and the two CSS seam
// rules while the column itself never learned: no flood, no drop to flush, both treatments dead
// code that a green unit test vouched for.
//
// This pins the WIRING rather than the unit — the half that was missing.
describe("the resized width reaches the concierge column", () => {
  // THE LAST TWO LINKS OF THE RESIZE CHAIN, on the REAL host and the REAL column.
  //
  // `Workspace.resize.test.tsx` drives a drag through the real Workspace, but it stubs this host —
  // so it can only prove the width reaches the host's prop boundary. The two links after that,
  // `ConciergeHost` forwarding `width` to `ConciergeColumn` and the column applying it as
  // `style.width`, were unasserted anywhere (roborev 55340).
  //
  // That gap is not theoretical: `ConciergeColumn` carries its OWN default (`width = 380`) which
  // DIVERGES from the shell's 360, so a dropped or shadowed prop renders a plausible-looking column
  // that simply never moves — the exact "the divider registers the drag but nothing moves" report
  // this suite exists to catch — while every other test stays green.
  beforeEach(() => {
    // `h.feed` starts null and each test supplies its own; without this these two pass only when
    // the whole file runs and an earlier test happens to have left one behind.
    h.feed = feedWith("approval");
  });

  it("forwards an explicit width onto the rendered column", () => {
    render(<ConciergeHost feed={h.feed as ConciergeFeed} width={444} />);
    expect(screen.getByLabelText("Sparkle concierge").style.width).toBe("444px");
  });

  it("moves the column when the width changes, rather than pinning a default", () => {
    const { rerender } = render(<ConciergeHost feed={h.feed as ConciergeFeed} width={300} />);
    expect(screen.getByLabelText("Sparkle concierge").style.width).toBe("300px");
    rerender(<ConciergeHost feed={h.feed as ConciergeFeed} width={520} />);
    // Asserted against a SECOND value, not just a non-default one: pinning to either component's
    // default (360 or 380) would satisfy a single-value check on the right day.
    expect(screen.getByLabelText("Sparkle concierge").style.width).toBe("520px");
  });
});

describe("the cable reaches the concierge column", () => {
  // The column reads the PROJECTED side (`useEffectiveWired`), not the raw store: a patched cable
  // whose far end holds no selected agent draws as off. Both pairs therefore need a selection here,
  // or every row below asserts the empty-far-end case by accident and proves nothing about the side.
  const wiredProjects = () =>
    [
      {
        id: "p1", name: "sparkle", rootPath: "/tmp/sparkle", defaultBranch: "main",
        createdAt: "2026-01-01", selectedAgentId: "ag1",
        agents: [{ id: "ag1", name: "Right Build", kind: "build", runtime: "local" }],
      },
      {
        id: "p2", name: "other", rootPath: "/tmp/other", defaultBranch: "main",
        createdAt: "2026-01-01", selectedAgentId: "ag2",
        agents: [{ id: "ag2", name: "Left Build", kind: "build", runtime: "local" }],
      },
    ] as unknown as Project[];

  beforeEach(() => {
    resetCable();
    useProjectStore.setState({ projects: wiredProjects(), selectedProjectId: "p1" } as never);
    useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);
  });
  afterEach(() => {
    resetCable();
    useUiStore.setState({ pairAssignment: {}, leftProjectId: null } as never);
  });

  it("is off at rest", () => {
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("off");
  });

  // THE SEAM BETWEEN "the cable is patched" AND "the pane shows that agent's transcript".
  //
  // ConciergeColumn.mounted.test.tsx proves the column renders a transcript it is HANDED; this
  // proves the host actually hands it one — the derivation (wired side → prompt target → roster row
  // → worktree) that nothing else exercises end to end. Without it, `mountedAgent` could be null in
  // the real app and every other test would still pass.
  it("swaps the thread for the mounted agent's own transcript when the cable is patched", async () => {
    h.feed = feedWith("approval");
    // The roster row needs a worktree: that is what keys the transcript, and a row without one is
    // deliberately not readable.
    const withWorktree = wiredProjects().map((p) =>
      p.id === "p1"
        ? {
            ...p,
            agents: [
              { id: "ag1", name: "Right Build", kind: "build", runtime: "local", worktreePath: "/tmp/wt/ag1" },
            ],
          }
        : p,
    ) as unknown as Project[];
    useProjectStore.setState({ projects: withWorktree, selectedProjectId: "p1" } as never);

    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "Right Build" }}
      />,
    );
    // Unpatched: the Sparkle conversation, as always.
    expect(screen.queryByTestId(MOUNTED_THREAD_TESTID)).toBeNull();
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID)).toBeTruthy();

    act(() => useCableStore.getState().patch("right", null));

    // Patched: THAT agent's thread, and the concierge thread is gone rather than merely hidden.
    // Asserted by the accessible name too, because "a thread is present" would be true either way —
    // the name is what says WHOSE conversation it is.
    await waitFor(() => expect(screen.getByTestId(MOUNTED_THREAD_TESTID)).toBeTruthy());
    expect(screen.getByLabelText("Conversation with Right Build")).toBeTruthy();
    expect(screen.queryByTestId(CONCIERGE_THREAD_TESTID)).toBeNull();
    expect(screen.queryByLabelText("Conversation with Sparkle")).toBeNull();

    // Unpatching restores it, which is the other half of the founder's requirement.
    act(() => useCableStore.getState().unbind());
    await waitFor(() => expect(screen.getByTestId(CONCIERGE_THREAD_TESTID)).toBeTruthy());
    expect(screen.queryByTestId(MOUNTED_THREAD_TESTID)).toBeNull();
  });

  it("follows the cable into either pair", () => {
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => useCableStore.getState().patch("right", null));
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("right");
    act(() => useCableStore.getState().patch("left", null));
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("left");
    act(() => useCableStore.getState().unbind());
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("off");
  });

  it("draws OFF when the patched pair has nothing selected — the column, not just the shell root", () => {
    // roborev 55386: the projection was applied at the shell root ONLY, so the root said "off"
    // while this column still flooded. That contradiction is what this row makes unrepresentable,
    // and it is asserted HERE because the root's own suite cannot see the column.
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => useCableStore.getState().patch("right", null));
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("right");
    act(() =>
      useProjectStore.setState({
        projects: [{ ...useProjectStore.getState().projects[0]!, selectedAgentId: null }],
      } as never),
    );
    expect(screen.getByLabelText("Sparkle concierge").getAttribute("data-wired")).toBe("off");
    // Read-side only: the patch survives, so re-selecting relights the flood with no second gesture.
    expect(useCableStore.getState().wired).toBe("right");
  });
});

// ══ THE CONCIERGE RELAYING ON THE USER'S BEHALF ═════════════════════════════════════════════════
// The other half of the founder's complaint, and the half that had no coverage at all (roborev
// 62737). Two paths reach an agent: he addresses one himself — covered above, and it stamps
// `target: "agent"` at dispatch — or he writes ordinary prose and the CONCIERGE decides to relay it.
// That second path wrote nothing onto his bubble; it posted a receipt line rows further down.
//
// Every test here drives the REAL seam: a `ConciergeActionReceipt` recorded through the module the
// production code subscribes to. None of them can pass against a version with the effect deleted,
// because the fixture message routes to `sparkle` and so is not a card to begin with — which is the
// vacuity trap roborev named for exactly this block.
describe("ConciergeHost — the concierge relays a message, and says so ON the bubble", () => {
  const AGENT = { id: "ag1", name: "CI Hardening" };

  /** Send one ordinary message that the concierge answers ITSELF, and return its bubble id. */
  async function sendPlain(text = "how's the booking flow?") {
    h.feed = feedWith("approval");
    h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const bubble = within(thread()).getByTestId("you-bubble");
    // PRECONDITION, ASSERTED. If this were already a card the positive case below would prove
    // nothing — it would be green before the effect ran. This is the guard on that.
    expect(bubble.dataset.sentToAgent).toBe("no");
    const row = bubble.closest("[data-message-id]") as HTMLElement | null;
    return row?.dataset.messageId ?? "";
  }

  /** Record a receipt the way the settler does, with whatever overrides the case is about. */
  function relay(over: Partial<ConciergeActionReceipt> = {}) {
    act(() =>
      recordConciergeActionReceipt({
        id: `r-${Math.random()}`,
        kind: "sent",
        ok: true,
        channel: "terminal",
        agentId: AGENT.id,
        agentName: AGENT.name,
        at: Date.now(),
        op: "terminal.send_to_agent_terminal",
        ...over,
      } as ConciergeActionReceipt),
    );
  }

  const card = () => within(thread()).getByTestId("you-bubble").dataset.sentToAgent;

  it("turns the originating bubble into a sent card, with the agent's pill inside it", async () => {
    const origin = await sendPlain();
    relay({ originBubbleId: origin });
    await waitFor(() => expect(card()).toBe("yes"));
    const row = await within(thread()).findByTestId(SENT_TO_AGENT_TESTID);
    expect(row.textContent).toContain("Sent to:");
    expect(row.textContent).toContain(AGENT.name);
  });

  // ── THE FALSE-ATTRIBUTION CASES ───────────────────────────────────────────────────────────────
  // These are the reason the join is CARRIED rather than inferred. Reading "whichever bubble is
  // awaiting" at settle time made both of these paint the card on a message that was never sent.
  it("marks NOTHING when the receipt carries no origin — an approval resumed after its turn", () => {
    // `resumeApprovedCall` settles from a click handler, arbitrarily long after the requesting turn
    // ended, and cannot know the bubble. Fail-closed: no origin, no claim.
    return sendPlain().then(() => {
      relay({ originBubbleId: undefined });
      expect(card()).toBe("no");
    });
  });

  it("marks the ORIGIN, never whatever happens to be awaiting now — the displaced turn", async () => {
    await sendPlain();
    // A reply that settles after its own turn was displaced names the bubble it actually belonged
    // to. That bubble is not in this thread, so nothing here may be marked.
    relay({ originBubbleId: "some-earlier-bubble" });
    expect(card()).toBe("no");
  });

  // ── THE EXCLUSIONS, one test each. Every one is a delivery claim that would otherwise be false.
  it.each([
    ["a refusal delivered nothing", { ok: false }],
    ["a HELD message has not arrived yet", { channel: "held" as const }],
    ["a picker press is not the user's words being forwarded", { viaPicker: true as const }],
    ["a fan-out has no single destination to name", { fanout: true as const }],
    ["a receipt with no agent id has no pill to offer", { agentId: undefined }],
    ["only a `sent` receipt is a send", { kind: "filed" as const }],
  ])("does not claim delivery when %s", async (_why, over) => {
    const origin = await sendPlain();
    relay({ originBubbleId: origin, ...over });
    expect(card()).toBe("no");
  });

  it("clears the turn origin when the column unmounts, so it cannot outlive the thread", async () => {
    // `turnOrigin` is MODULE state. Without an unmount cleanup the last bubble this column awaited
    // survives the column, and a call settling afterwards is stamped with it — message ids survive
    // rehydration, so a remounted thread can hold that very id and get marked for a turn that ended
    // long ago. Asserted as set-then-cleared on one mount, so it cannot pass by never being set.
    await sendPlain();
    expect(currentConciergeTurnOrigin()).not.toBeNull();
    cleanup();
    expect(currentConciergeTurnOrigin()).toBeNull();
  });

  it("never overwrites an agent the USER addressed himself", async () => {
    // His own aim outranks anything inferred. Renaming his destination under him is the one error
    // this whole feature exists to prevent, so it must not be reachable from the relay path.
    //
    // Stated as BEFORE and AFTER on the same bubble rather than as a single expectation, so the
    // test cannot pass by the destination having been something else all along.
    routeToAgent();
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p1", agentId: "ag1", name: "CI Hardening" }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    const before = (await within(thread()).findByTestId(SENT_TO_AGENT_TESTID)).textContent ?? "";
    expect(before).toContain("CI Hardening");

    const row = within(thread()).getByTestId("you-bubble").closest("[data-message-id]") as HTMLElement;
    // A relay receipt naming a DIFFERENT agent, against the bubble he already aimed himself.
    relay({ originBubbleId: row.dataset.messageId, agentId: "ag-other", agentName: "Some Other Agent" });
    const after = (await within(thread()).findByTestId(SENT_TO_AGENT_TESTID)).textContent ?? "";
    expect(after).toBe(before);
    expect(after).not.toContain("Some Other Agent");
  });
});

// ══ THE APP ACTUALLY DISPATCHES WHEN THE QUEUE OUTRUNS THE AGENTS (bead sparkle-6vool) ═════════════
//
// conciergeAutoDispatch.test.ts proves the pure DECIDER returns `action:"dispatch"`. That is a
// trigger object, not a side effect — a decider that returns "dispatch" while nothing calls
// `dispatchResearchTask` would pass every one of those rows and ship a feature that never runs once.
// These rows drive the host's real interval effect and assert the REAL dispatch happens (and, in the
// paired negative, does NOT happen when the queue is already served) — the wiring nothing else sees.
describe("ConciergeHost — the app DISPATCHES research when the queue outruns the agents (sparkle-6vool)", () => {
  function seedSelectedProject() {
    // The effect resolves the root from the project store and does nothing without one, exactly as
    // the `dispatch` tool route does. A dispatch without a root researches an arbitrary tree.
    useProjectStore.setState({
      projects: [
        {
          id: "p1", name: "sparkle", rootPath: "/tmp/sparkle", defaultBranch: "main",
          createdAt: "2026-01-01", selectedAgentId: "ag1",
          agents: [{ id: "ag1", name: "CI Hardening", kind: "build", runtime: "local" }],
        },
      ],
      selectedProjectId: "p1",
    } as never);
  }

  // A occupies the running slot; B waits behind it. Both clear MIN_DISPATCHABLE_CHARS (24), so the
  // only thing keeping B from dispatch is the one-minute floor and the live-agent count.
  const RUNNING_MSG = "why is the desktop build red right now";
  const WAITING_MSG = "what broke the coverage shard on origin main";

  async function sendRunningThenWaiting() {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: RUNNING_MSG } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: WAITING_MSG } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
  }

  const OK_DISPATCH = { ok: true, op: "dispatch", risk: "routine", data: { id: "r1" } } as never;

  it("calls dispatchResearchTask ONCE for the oldest waiter once it crosses the one-minute floor", async () => {
    vi.useFakeTimers();
    // Spy WITHOUT replacing: the real notice still stages, and we assert it was sent. Deleting the
    // host's `notifyConcierge(autoDispatchNotice(...))` line (ConciergeHost.tsx:863) — the "and TELLS
    // the concierge it did" half the feature's whole point rests on — must turn this row red.
    const notifySpy = vi.spyOn(conciergeNotifierModule, "notifyConcierge");
    let view: ReturnType<typeof render> | undefined;
    try {
      vi.mocked(dispatchResearchTask).mockResolvedValue(OK_DISPATCH);
      // The store HAS been read and NOTHING is running — the acute form of the condition, and the
      // one the fail-closed `researchHydrated` gate would otherwise mask.
      useResearchStore.setState({ byId: {}, hydrated: true } as never);
      seedSelectedProject();
      routeToAgent();
      h.feed = feedWith("approval");
      view = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);

      await sendRunningThenWaiting();

      // Not yet: B enqueued a moment ago, and the floor is a full minute.
      expect(dispatchResearchTask).not.toHaveBeenCalled();

      // Advance PAST SEVERAL eligible ticks (the 15s interval fires at 15/30/…/120s; B is eligible
      // from 60s on, so five ticks see it eligible). One dispatch across five eligible ticks is what
      // pins the host's OWN re-dispatch memory (`dispatched.add`, ConciergeHost.tsx:852): delete that
      // line and this becomes five metered children a minute, which `toHaveBeenCalledTimes(1)` catches
      // only because the window holds more than one eligible tick. A knife-edge 61_000 could not.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(130_000);
      });

      // THE SIDE EFFECT — the real dispatch, exactly once, for B's text, at quick depth, against the
      // selected project's root; and the concierge is told, so it does not re-research the same thing.
      expect(dispatchResearchTask).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(dispatchResearchTask).mock.calls[0]![0] as {
        question: string;
        projectId: string;
        projectRoot: string;
        depth: string;
      };
      expect(arg.question).toBe(WAITING_MSG);
      expect(arg.projectId).toBe("p1");
      expect(arg.projectRoot).toBe("/tmp/sparkle");
      expect(arg.depth).toBe("quick");
      const noticed = notifySpy.mock.calls.map((c) => String(c[0]));
      expect(noticed.some((t) => t.includes("[sparkle-auto-dispatch]") && t.includes(WAITING_MSG))).toBe(
        true,
      );
    } finally {
      // Unmount UNDER the fake clock so the effect's `clearInterval` cancels the handle the fake clock
      // minted; tearing down after `useRealTimers` would leave clearInterval resolving a foreign id.
      view?.unmount();
      vi.useRealTimers();
      notifySpy.mockRestore();
    }
  });

  it("does NOT dispatch (and sends no notice) when the queue is already served", async () => {
    // The PAIRED NEGATIVE (bead sparkle-rvf6n): same queue, same crossed floor, but a live research
    // agent already covers the single waiter. If the effect dispatched here it would be firing on the
    // timer rather than on the condition — the "served" guard proven live, not just present.
    vi.useFakeTimers();
    const notifySpy = vi.spyOn(conciergeNotifierModule, "notifyConcierge");
    let view: ReturnType<typeof render> | undefined;
    try {
      vi.mocked(dispatchResearchTask).mockResolvedValue(OK_DISPATCH);
      // liveTasks reads only `status`; one running task makes liveResearch (1) >= waiting (1).
      useResearchStore.setState({ byId: { t1: { id: "t1", status: "running" } }, hydrated: true } as never);
      seedSelectedProject();
      routeToAgent();
      h.feed = feedWith("approval");
      view = render(<ConciergeHost feed={h.feed as ConciergeFeed} />);

      await sendRunningThenWaiting();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(130_000);
      });

      expect(dispatchResearchTask).not.toHaveBeenCalled();
      // …and no auto-dispatch notice fabricated for a queue nobody needed to fan out.
      const noticed = notifySpy.mock.calls.map((c) => String(c[0]));
      expect(noticed.some((t) => t.includes("[sparkle-auto-dispatch]"))).toBe(false);
    } finally {
      view?.unmount();
      vi.useRealTimers();
      notifySpy.mockRestore();
    }
  });
});
