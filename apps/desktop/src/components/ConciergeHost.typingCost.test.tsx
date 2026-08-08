// @vitest-environment jsdom
//
// WHAT ONE KEYSTROKE COSTS — the founder's most frequent action, measured rather than asserted at.
//
// ══ WHY A COUNTER AND NOT A TIMING ══════════════════════════════════════════════════════════════
// Typing one character into the concierge compose box used to run the SAME @-mention scan four
// times: `ComposeBox` (for the route indicator), `MentionMirror` (for the pills), the host's
// `railTargetName` memo (for the auto-send label), and `classifyComposerRoute`'s own re-derivation
// of the addressing span. Each pass sorted a copy of the ~60-agent roster and walked the whole draft
// once per agent.
//
// Every one of those consumers was CORRECT. The pills were right, the rail named the right agent,
// the route was right — whether the work happened once or four times. So no existing assertion in
// this repo could see the defect, and none of them went red while it was there. The observable
// difference is the number of scans, which is why this file counts them: `mentionScanStats` is
// production state, incremented by the matcher itself, so what is asserted here is the shipping
// code path and not a stand-in for it.
//
// ══ WHAT WOULD MAKE THIS GO RED ═════════════════════════════════════════════════════════════════
// Re-introducing a second consumer that scans independently — a new `mentionsIn(text, …)` in a
// render body, a roster rebuilt per keystroke, a memo whose deps include the draft when they need
// not. That is exactly the change this file exists to catch, because nothing else in the suite can.
//
// The PAIRED half — that the one surviving scan still RECOMPUTES when the text or the roster really
// changes — lives in Concierge/mentions.test.ts (`scanMentions`), because a memo that always
// returned its first answer would satisfy a call-count ceiling perfectly and break every feature in
// this column.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** How many times the transcript fold has run. `vi.hoisted` because the mock factory above is
 *  hoisted with it and closes over this object. */
const folds = vi.hoisted(() => ({ count: 0 }));

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  wired: vi.fn(() => "off" as "off" | "left" | "right"),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("../hooks/useEffectiveWired", () => ({
  useEffectiveWired: () => h.wired(),
  usePairIsLive: () => false,
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    micLive: false,
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
// THE FOLD, COUNTED — the REAL implementation, wrapped. Spying rather than stubbing because the
// transcript still has to render correctly while we count: a stub returning [] would empty the
// thread and the "it recomputes when a message arrives" row below would pass against nothing.
vi.mock("./Concierge/receiptRuns", async (orig) => {
  const real = (await orig()) as typeof import("./Concierge/receiptRuns");
  return { ...real, foldReceiptRuns: (...a: Parameters<typeof real.foldReceiptRuns>) => {
    folds.count += 1;
    return real.foldReceiptRuns(...a);
  } };
});
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
  hasAiCredits: () => true,
}));

const RUNTIME = {
  status: {} as Record<string, string>,
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { findMentionSpans, mentionRoster, mentionScanStats } from "./Concierge/mentions";
import { armedIntents, cancelIntent } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useProjectStore } from "../stores/projectStore";

// ══ THE FIXTURE: A REAL FLEET AND A REAL DRAFT ══════════════════════════════════════════════════
// 60 agents, because that is the order of magnitude the founder actually runs, and the cost of the
// defect was O(agents × draftLength) PER CONSUMER — a two-agent fixture would show the same call
// counts while hiding entirely why they matter.
const FLEET_SIZE = 60;
/** Names shaped like the real ones — two or three words, some sharing a prefix, so the matcher's
 *  longest-first ordering and its boundary checks both do real work. */
const NAMES = Array.from({ length: FLEET_SIZE }, (_, i) =>
  i % 3 === 0
    ? `Blueprint UI/UX ${i}`
    : i % 3 === 1
      ? `Kraken Auth ${i}`
      : `Release Pipeline ${i}`,
);

function agent(id: string, name: string) {
  return {
    id,
    name,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    band: "done" as const,
    inScope: true,
    muted: false,
    topLevel: true,
  };
}
const COUNTS = { needs_you: 0, questions: 0, running: 0, done: FLEET_SIZE };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: NAMES.map((n, i) => agent(`ag${i}`, n)),
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

const SELECTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag0", name: NAMES[0]! };

/** ~200 characters, the length of a real dictated paragraph, with an @-mention in it so the matcher
 *  reaches its span-claiming path rather than bailing out early. */
const BASE_DRAFT =
  "@Kraken Auth 1 please take a look at the release pipeline before you land this, the notarization " +
  "step has been flaky since Tuesday and I would rather we caught it here than in the DMG that ships";

/** How many characters we "type". Enough that per-keystroke averages are stable, few enough that a
 *  jsdom render loop stays well inside a normal test budget. */
const KEYSTROKES = 25;

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.wired.mockReset();
  h.wired.mockReturnValue("off");
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: NAMES.map((n, i) => ({
          id: `ag${i}`,
          name: n,
          worktreePath: `/tmp/wt/ag${i}`,
        })),
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  cleanup();
  vi.clearAllMocks();
});

/** One keystroke, the way the box actually receives one: a change event carrying the whole new
 *  value and the caret, then the effect flush that lifts the draft into the host's `composedText`
 *  (which is what re-renders the rail). Both halves are part of what a character costs. */
async function typeOne(value: string) {
  const ta = box();
  await act(async () => {
    fireEvent.change(ta, {
      target: { value, selectionStart: value.length, selectionEnd: value.length },
    });
    await Promise.resolve();
  });
}

interface Measurement {
  scans: number;
  rosterSorts: number;
  ms: number;
  perKeystroke: number;
}

/** Type `KEYSTROKES` characters onto the end of a ~200-char draft and report what it cost. */
async function measureTyping(): Promise<Measurement> {
  render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
  // Seed the draft OUTSIDE the measured window: the first keystroke also mounts pickers and runs
  // one-shot effects, and counting that would flatter or slander the steady state depending on the
  // day. What is measured is the steady state — the 26th character of a paragraph.
  await typeOne(BASE_DRAFT);

  const before = { ...mentionScanStats };
  const t0 = performance.now();
  let draft = BASE_DRAFT;
  for (let i = 0; i < KEYSTROKES; i += 1) {
    draft += "x";
    await typeOne(draft);
  }
  const ms = performance.now() - t0;
  const scans = mentionScanStats.spans - before.spans;
  return {
    scans,
    rosterSorts: mentionScanStats.rosterSorts - before.rosterSorts,
    ms,
    perKeystroke: scans / KEYSTROKES,
  };
}

/**
 * THE MATCHER'S OWN COST, measured without React in the way.
 *
 * The end-to-end wall time above is dominated by jsdom's render machinery and swings by 3-4x run to
 * run on a loaded laptop, so it cannot carry a before/after claim on its own — which is exactly why
 * the scan COUNT is the primary number. This measures the thing the count is counting: what one
 * keystroke's worth of matching costs at the fixture's size, at the old rate of 14 scans and the new
 * rate of 1. It is deterministic, attributable, and it is the work that actually left the keystroke.
 */
function measureMatcherCost(scansPerKeystroke: number): number {
  const roster = mentionRoster(
    NAMES.map((n, i) => ({
      id: `ag${i}`,
      name: n,
      projectId: "p1",
      projectName: "sparkle",
      band: "done" as const,
      canAcceptInput: true,
    })),
    null,
  );
  const reps = 200;
  let best = Number.POSITIVE_INFINITY;
  // BEST OF FIVE, not a mean: a mean measures the machine's other tenants, the minimum measures the
  // work. Each pass re-mints the draft string so no cache anywhere can answer for it.
  for (let pass = 0; pass < 5; pass += 1) {
    const t0 = performance.now();
    for (let r = 0; r < reps; r += 1) {
      const draft = `${BASE_DRAFT}${r}`;
      for (let s = 0; s < scansPerKeystroke; s += 1) findMentionSpans(draft, roster);
    }
    best = Math.min(best, (performance.now() - t0) / reps);
  }
  return best;
}

describe("typing into the concierge compose box", () => {
  // ── THE MEASUREMENT ──────────────────────────────────────────────────────────────────────────
  // Printed as well as asserted: the number is the deliverable, and a bare pass/fail hides whether
  // a later change moved it from 1.0 to 1.9 while staying under a ceiling of 2.
  it("scans the draft for mentions ONCE per keystroke", async () => {
    const m = await measureTyping();
    // The number is the deliverable, so it is PRINTED as well as asserted: a bare pass/fail hides
    // whether a later change moved it from 1.0 to 1.9 while staying under a ceiling of 2.
    console.log(
      `[typing cost] ${FLEET_SIZE} agents, ${BASE_DRAFT.length}-char draft, ${KEYSTROKES} keystrokes: ` +
        `${m.scans} scans (${m.perKeystroke.toFixed(2)}/keystroke), ` +
        `${m.rosterSorts} roster sorts, ${m.ms.toFixed(1)}ms end-to-end ` +
        `(${(m.ms / KEYSTROKES).toFixed(2)}ms/keystroke, jsdom — render-dominated and noisy)`,
    );
    console.log(
      `[matcher cost] at this fixture size: ` +
        `14 scans/keystroke = ${measureMatcherCost(14).toFixed(3)}ms, ` +
        `1 scan/keystroke = ${measureMatcherCost(1).toFixed(3)}ms`,
    );
    // ONE full-roster scan per character. Not "fewer than four" — a ceiling that leaves slack is a
    // ceiling a regression fits under.
    expect(m.perKeystroke).toBeLessThanOrEqual(1);
    // And it must still be doing the work at all: a scan count of zero would mean the composer had
    // stopped resolving mentions, which every other assertion about pills and routing depends on.
    expect(m.scans).toBeGreaterThan(0);
  });

  // ── AND THE ROSTER IS NOT REBUILT PER CHARACTER ──────────────────────────────────────────────
  // `railTargetName` used to run `mentionRoster` inside a memo whose deps included the draft, so
  // every character re-sorted the whole fleet by match score and re-built the label map. That work
  // does not depend on the text at all. Counted through the same seam: the length-ordering the
  // matcher does is the only sort left on this path, so one sort per keystroke means one scan per
  // keystroke and no roster rebuild riding along with it.
  it("does not re-sort the fleet for every character", async () => {
    const m = await measureTyping();
    // ZERO, not "at most one". The fleet does not change while somebody types a sentence, so the
    // correct number of times to re-order it during 25 keystrokes is none — the ordering computed
    // when the roster was built is still the ordering. Before this change it was 14 per character.
    expect(m.rosterSorts).toBe(0);
  });
});

// ══ THE TRANSCRIPT IS NOT RE-FOLDED FOR EVERY CHARACTER ═════════════════════════════════════════
// `foldReceiptRuns` walks the WHOLE message list and allocates a fresh `ThreadRow[]`. It ran inline
// in `ConciergeThread`'s JSX, so it re-ran on every render of that container — and the container
// re-renders on every keystroke, because the draft is lifted into the host's state. So typing one
// character re-folded the entire conversation, at a cost that grows with the length of the
// conversation rather than with anything the keystroke changed.
//
// The message ROWS were already memoized and bail out, so this was never row cost. Counting the
// fold is the only way to see it: the rendered transcript is byte-identical either way.
describe("the transcript fold", () => {
  /** A thread with enough in it that a full walk is real work — and with a run of receipts, so the
   *  fold reaches its collapsing path rather than passing everything through. */
  function seedThread() {
    setConciergeChat(() => [
      { id: "u1", kind: "you", text: "what needs me?" },
      { id: "a1", kind: "sparkle", text: "Two agents are waiting on you." },
      { id: "u2", kind: "you", text: "ship the first one" },
      { id: "a2", kind: "sparkle", text: "Sent to Blueprint UI/UX 0." },
      { id: "u3", kind: "you", text: "and the other" },
      { id: "a3", kind: "sparkle", text: "Sent to Kraken Auth 1." },
    ]);
  }

  it("does not re-fold the whole conversation on every keystroke", async () => {
    seedThread();
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await typeOne(BASE_DRAFT);

    const before = folds.count;
    let draft = BASE_DRAFT;
    for (let i = 0; i < 10; i += 1) {
      draft += "x";
      await typeOne(draft);
    }
    console.log(`[fold cost] 10 keystrokes over a 6-message thread: ${folds.count - before} folds`);
    // NONE. The transcript did not change, so there is nothing to re-fold — this is not a ceiling
    // with slack in it. Before the memo it was one per render of the thread container, per
    // character.
    expect(folds.count - before).toBe(0);
  });

  // ── THE PAIRED HALF ──────────────────────────────────────────────────────────────────────────
  // A memo that never recomputed would satisfy the row above perfectly and freeze the transcript at
  // whatever was on screen when the box was first focused — every reply the concierge sends would
  // simply never appear. This is the row that would catch that.
  it("DOES re-fold when a message arrives, and the new message renders", async () => {
    seedThread();
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await typeOne(BASE_DRAFT);

    const before = folds.count;
    await act(async () => {
      setConciergeChat((prev) => [
        ...prev,
        { id: "a4", kind: "sparkle", text: "One more thing about the DMG." },
      ]);
      await Promise.resolve();
    });
    expect(folds.count).toBeGreaterThan(before);
    // …and the fold really did carry the new row through, rather than merely being called.
    expect(screen.getByText(/One more thing about the DMG/)).toBeTruthy();
  });
});
