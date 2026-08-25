// @vitest-environment jsdom
//
// THE SEAM between the concierge error handler and the reactive account rotation.
//
// The rotation's correctness fix (accountSelection: attribute a failure to the account that ACTUALLY
// ran the failing turn, not the current sticky pointer) is inert unless this call site passes that
// identity through. `turnAccounts` — the turn→account record — lives in services/concierge; the host
// reads it with `turnAccountFor(e.id)` and threads it into `rotateStickyConsumerOffFailedAccount` as
// `failedAccount`. Without this test the whole fix could ship with the host still calling the rotation
// with no `failedAccount` (the pre-fix signature), green all the way — the `sparkle-lgbwf` defaulted-
// seam trap. So this asserts the WIRE, not the rotation's internals (those are covered in
// accountSelection.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  // The turn→account map the real services/concierge keeps; a knob so a row can say which account a
  // given turn id ran under (a CLAUDE_CONFIG_DIR, or null when the turn is not remembered).
  turnAccounts: {} as Record<string, string | null>,
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; sessionId: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
    reset?: () => void;
  },
  // The spy the whole file exists to inspect.
  rotate: vi.fn(async () => ({ rotated: false as boolean })),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    ConciergeAiDisabledError: real.ConciergeAiDisabledError,
    startConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: () => false,
    // THE EXPORT UNDER TEST: the host resolves the failed turn's account through this.
    turnAccountFor: (id: string) => h.turnAccounts[id],
    onConciergeTool: () => () => {},
    onConciergeDelta: (cb: NonNullable<typeof h.brain.delta>) => {
      h.brain.delta = cb;
      return () => {};
    },
    onConciergeDone: (cb: NonNullable<typeof h.brain.done>) => {
      h.brain.done = cb;
      return () => {};
    },
    onConciergeError: (cb: NonNullable<typeof h.brain.error>) => {
      h.brain.error = cb;
      return () => {};
    },
    onConciergeTurnsAbandoned: (cb: NonNullable<typeof h.brain.reset>) => {
      h.brain.reset = cb;
      return () => {};
    },
  };
});
// Keep every OTHER accountSelection export real (the host imports CONCIERGE_ACCOUNT_KEY too); only the
// rotation is a spy so we can read the arguments the seam passed it.
vi.mock("../services/accountSelection", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/accountSelection")>();
  return { ...real, rotateStickyConsumerOffFailedAccount: h.rotate };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));

import { ConciergeHost } from "./ConciergeHost";
import { CONCIERGE_ACCOUNT_KEY } from "../services/accountSelection";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { __resetInboxForTests, __setInboxPeekForTests } from "../stores/inboxStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 1, done: 0 };

function feed(): ConciergeFeed {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "working",
    statusColor: "#e0533f",
    statusLabel: "Working",
    band: "running" as StatusBand,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts: COUNTS, scopedCounts: COUNTS, agents: [agent] },
    ],
    counts: COUNTS,
    scopedCounts: COUNTS,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

// A quota failure — one of the real 2026-07-29 strings — so `conciergeFailureNotice` classifies it as
// `quota` and the handler reaches the rotation call. (An unclassifiable string would not.)
const QUOTA_DETAIL = "You've hit your session limit · resets 8:40am (America/Bogota)";

let restoreInboxPeek: (() => void) | null = null;

beforeEach(() => {
  enableAiEnhancementsForTests();
  h.turnAccounts = {};
  h.rotate.mockClear();
  restoreInboxPeek = __setInboxPeekForTests(async () => []);
  __resetInboxForTests();
});

afterEach(() => {
  cleanup();
  restoreInboxPeek?.();
  restoreInboxPeek = null;
  __resetInboxForTests();
  vi.clearAllMocks();
});

describe("the error handler attributes the failure to the turn's OWN account", () => {
  it("passes turnAccountFor(e.id) into the rotation as failedAccount", async () => {
    // Turn "7" ran under the Work account's config dir.
    h.turnAccounts["7"] = "/data/accounts/work";
    render(<ConciergeHost feed={feed()} />);

    await act(async () => {
      h.brain.error?.({ id: "7", detail: QUOTA_DETAIL });
      await Promise.resolve();
    });

    // THE SEAM: the account that RAN turn 7 is what gets benched — not the current sticky pointer.
    // Reverting the call site to the pre-fix `rotate(KEY, "quota")` (no third arg) reds this.
    expect(h.rotate).toHaveBeenCalledWith(CONCIERGE_ACCOUNT_KEY, "quota", {
      failedAccount: "/data/accounts/work",
    });
  });

  it("degrades to failedAccount undefined when the turn's account is unknown", async () => {
    // Turn "7" is not remembered — turnAccountFor returns null. The rotation must still fire (the
    // account is dead either way) but with no attribution, i.e. its pre-fix sticky-pointer behaviour.
    h.turnAccounts["7"] = null;
    render(<ConciergeHost feed={feed()} />);

    await act(async () => {
      h.brain.error?.({ id: "7", detail: QUOTA_DETAIL });
      await Promise.resolve();
    });

    expect(h.rotate).toHaveBeenCalledWith(CONCIERGE_ACCOUNT_KEY, "quota", {
      failedAccount: undefined,
    });
  });
});
