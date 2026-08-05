// @vitest-environment jsdom
//
// TYPING A TERSE ANSWER AT THE CONCIERGE WHILE A BUILD AGENT HAS A PICKER ON SCREEN.
//
// ══ WHY THESE ROWS LOOK NOTHING LIKE THE ONES THEY REPLACE ═══════════════════════════════════
// This suite used to pin a short-circuit in `send`: it asked `answersLivePicker` before building
// the payload and, on a true, sent the text UNPREFIXED with `staged = []`, holding the files for
// the next message. That was right while a terse unaddressed answer could still become a KEYSTROKE
// in the agent's terminal — the attachment-path prefix defeats the anchored `matchAnswerToOption`,
// and spending the files on a keystroke costs the user the picking for nothing.
//
// It stopped being right when the router's answer-detector was deleted: `routeMessage` NEVER
// returns `agent` any more, and the only thing that aims a message at a live PTY is an explicit
// `@Name`, which ConciergeHost resolves into an agent decision BEFORE the router is called. So the
// short-circuit could only ever fire on a message bound for the CONCIERGE — and there it silently
// withheld the user's screenshot from the brain, which then answered a question about a picture it
// had never been given. The chips staying on screen were the only signal (roborev 55033).
//
// The old rows could not catch that, because they MOCKED `routeMessage` to return
// `{ target: "agent" }` for unaddressed text — a verdict production cannot produce — so every
// assertion described a configuration that no longer exists and the suite stayed green straight
// through the drop.
//
// These rows run the verdict production actually gives this text (`sparkle`, pinned for real in
// services/conciergeRouter.test.ts) and assert what the CONCIERGE receives, attachments included.
// The addressed path — the one where a PTY is still reachable — is covered by
// ConciergeHost.mention.test.tsx, and the picker refusal itself by services/conciergeDispatch.test.ts.
//
// The real `attachedPayload` runs in these rows — a stubbed one would let the prefix silently stop
// being applied and every assertion here would still pass.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async (_a: string, _t: string, _o?: unknown) => ({ ok: true, path: "free-text" })),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
  pick: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  brain: {} as { done?: (e: { id: string; sessionId: string; text: string }) => void },
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  // CAPTURED, not inert: a send now QUEUES behind a running turn (sparkle-t8wsj), so a case that
  // sends twice needs a way to END the first turn or the second never dispatches.
  onConciergeDone: (cb: (e: { id: string; sessionId: string; text: string }) => void) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  // Reached only once a `done` actually fires — which this suite never did until the queue made
  // ending a turn part of the setup (sparkle-t8wsj).
  isProactiveTurn: () => false,
  SUPERSEDED_DETAILS: [],
}));
// A picker really IS on screen for ag1, and the terse text really WOULD match one of its options —
// that is the whole premise of these rows, so the stub is internally consistent rather than a bare
// `true` from a module claiming there are no options.
const OPTIONS = [
  { label: "Yes", value: "y\r" },
  { label: "No", value: "n\r" },
];
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatch,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => OPTIONS,
  isTerseAnswer: () => true,
  matchAnswerToOption: () => OPTIONS[0],
  answersLivePicker: (a: string, t: string) => h.answersLivePicker(a, t),
  onDeferredSendOutcome: () => () => {},
}));
// THE VERDICT PRODUCTION GIVES THIS TEXT. `routeMessage` cannot return `agent` — the header
// explains why, and services/conciergeRouter.test.ts pins it against the real implementation — so
// an unaddressed send goes to Sparkle no matter what is on the agent's screen. Mocked rather than
// run for real only to keep these rows off the classifier; the verdict is the true one.
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({
    target: "sparkle",
    reason: "couldn't place it — answering here is undoable",
    source: "fallback",
  })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
// The REAL attachedPayload/attachedDisplay — only the picker seam is stubbed.
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    pickAttachments: h.pick,
    // Resolves an OUTCOME, not undefined: attachPaths chains off this, so a bare vi.fn() makes
    // the drop effect throw rather than quietly no-op.
    loadAttachmentPaths: vi.fn(async () => ({ attachments: [], failed: [] })),
  };
});
vi.mock("../stores/runtimeStore", () => {
  const S = { status: { ag1: "approval" }, workflowState: {}, branchStatus: {}, workflowStage: {} };
  return {
    useRuntimeStore: Object.assign((sel: (s: typeof S) => unknown) => sel(S), {
      getState: () => S,
    }),
  };
});

import { ConciergeHost } from "./ConciergeHost";
import { armedIntents, clearAllIntents } from "../services/dispatchIntent";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { Attachment } from "./composer/attachments";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);

const shot: Attachment = {
  id: "s1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,AAA",
};

const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };
const COUNTS = { needs_you: 1, running: 0, done: 0 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [
        {
          id: "ag1",
          name: "CI Hardening",
          projectId: "p1",
          projectName: "sparkle",
          kind: "build" as const,
          status: "approval",
          statusColor: "#e0533f",
          statusLabel: "Approve?",
          band: "needs_you" as const,
          inScope: true,
          muted: false,
        },
      ],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const chips = () => screen.queryByTestId("concierge-attachment-chips");
const threadEl = () => screen.getByTestId("concierge-thread");
/** What the CONCIERGE was actually asked — the prompt snapshot `askSparkle` builds, which carries
 *  the user's payload verbatim after "The user says:". This is the destination every row here
 *  reaches, so it is where the attachments have to show up. */
const askedSparkle = () => h.startConciergeTurn.mock.calls.map((c) => c[0]);

/** Stage a screenshot through the compose box's attach affordance. The paperclip rests collapsed,
 *  so the actions have to be REVEALED first — hover is the mouse path (focus is the keyboard one;
 *  ComposeBox.test.tsx covers both). What this suite cares about is only that a file is staged. */
async function attachImage() {
  h.pick.mockResolvedValue({ attachments: [shot], failed: [] });
  fireEvent.mouseEnter(screen.getByTestId("concierge-attach"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  });
}
/**
 * Let the send queue drain.
 *
 * A concierge-bound send goes through `enqueue` and then several awaits of `deliver` (the route
 * call among them) before `askSparkle` runs, so too few ticks reads as "the message never went"
 * rather than as a race. Generously many, and no timers are involved on this path — a `sparkle`
 * verdict arms no countdown, which is itself part of what these rows assert.
 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
  await flush();
}

beforeEach(() => {
  // Intents are a module-level registry, so one suite's armed send would otherwise leak into the
  // next row's `armedIntents()` and be fired against a fresh render.
  clearAllIntents();
  h.dispatch.mockClear();
  h.startConciergeTurn.mockClear();
  h.pick.mockReset();
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
  render(<ConciergeHost feed={FEED} promptTarget={target} />);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConciergeHost — a terse answer, a live picker on screen, and files staged", () => {
  // THE REGRESSION, stated as the side effect: the brain is asked about the picture. Under the old
  // short-circuit `staged` was emptied, `attachedPayload` had nothing to prefix, and Sparkle was
  // handed a bare "Yes" — it answered a question about a screenshot it was never given.
  it("hands the CONCIERGE the staged file along with the answer", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    expect(chips()).toBeTruthy(); // the file really is staged
    await send("Yes");
    expect(askedSparkle()).toHaveLength(1);
    expect(askedSparkle()[0]).toContain("/tmp/shot.png");
    expect(askedSparkle()[0]).toContain("Yes");
    // …and nothing went near a terminal. The verdict is `sparkle`, so no countdown is armed and no
    // dispatch happens — which is exactly why withholding the file bought nothing.
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  // The user-visible half of the same fact, and the one the reporter actually saw. The chips used
  // to STAY UP — which reads as "still ready to send", not as "your picture was withheld". They now
  // clear, and the file reappears where a sent file belongs: on the bubble that sent it.
  it("CONSUMES those attachments — the chips clear and the bubble keeps the file", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    await send("Yes");
    expect(chips()).toBeNull();
    expect(within(threadEl()).getByTitle("shot.png")).toBeTruthy();
  });

  // The other end of consuming them: the next message starts clean. Under the short-circuit the
  // held file rode this second send instead, arriving one message later than the user meant.
  it("does not re-send the file on the NEXT message", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    await send("Yes");
    h.answersLivePicker.mockReturnValue(false); // the picker is answered and gone
    await send("now look at this");
    // The second send QUEUES now (sparkle-t8wsj), so end the first turn to let it dispatch. What
    // this case is about — that the attachment does not ride along on the NEXT message — is
    // unchanged; only the point at which the second turn starts moved.
    await act(async () => {
      h.brain.done?.({ id: "1", sessionId: "s1", text: "" });
    });
    await flush();
    expect(askedSparkle()[1]).toContain("now look at this");
    expect(askedSparkle()[1]).not.toContain("/tmp/shot.png");
  });

  // The control row: a message that was never picker-shaped behaved correctly all along, and must
  // keep doing so. If this and the first row ever disagree, the short-circuit is back.
  it("treats a non-answer message exactly the same way", async () => {
    h.answersLivePicker.mockReturnValue(false);
    await attachImage();
    await send("yes, but rename the flag first");
    expect(askedSparkle()[0]).toContain("/tmp/shot.png");
    expect(askedSparkle()[0]).toContain("yes, but rename the flag first");
    expect(chips()).toBeNull();
  });

  it("sends the bare text when no files are staged", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await send("Yes");
    expect(askedSparkle()[0]).toContain("The user says: Yes");
    expect(askedSparkle()[0]).not.toContain("/tmp/");
  });





  // STRUCTURAL, and the reason it is worth an assertion: the predicate still exists and is still
  // exported, so the cheapest way to re-introduce the drop is to consult it here again. The host
  // must not ask — where a message goes no longer depends on what is on the agent's screen.
  it("never consults the picker mirror on an unaddressed send", async () => {
    await attachImage();
    await send("Yes");
    expect(h.answersLivePicker).not.toHaveBeenCalled();
  });
});
