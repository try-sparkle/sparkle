// @vitest-environment jsdom
//
// ANSWERING A LIVE PICKER WITH FILES STAGED — the interaction between two features that were built
// separately and collide.
//
// The compose box prefixes the quoted temp paths of every staged attachment onto the text it sends
// (`attachedPayload`). The dispatcher, when the aimed agent has a picker on screen, matches the
// text against the live options — and every arm of that matcher is anchored. So `"/tmp/shot.png"
// Yes` matched nothing and came back `ambiguous-picker`: the box restored the draft AND the chips,
// so retyping "Yes" reproduced it exactly. A loop whose only exit is realising the attachments are
// the problem — which the refusal copy ("open it and pick, or answer with just the option") never
// says, because it is written for a genuinely ambiguous ANSWER, not for a payload the box mangled.
//
// The fix asks `answersLivePicker` BEFORE building the payload: a terse answer to a live picker
// sends UNPREFIXED and HOLDS its attachments for the next message.
//
// The real `attachedPayload` runs in these rows — a stubbed one would let the prefix silently stop
// being applied and every assertion here would still pass.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(async (_a: string, _t: string, _o?: unknown) => ({ ok: true, path: "free-text" })),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
  pick: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatch,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: (a: string, t: string) => h.answersLivePicker(a, t),
  onDeferredSendOutcome: () => () => {},
}));
// Routed to the AGENT: the collision only exists on the PTY path.
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "agent", reason: "test", source: "heuristic" })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
// The REAL attachedPayload/attachedDisplay — only the picker seam is stubbed.
vi.mock("../services/conciergeAttach", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, pickAttachments: h.pick, loadAttachmentPaths: vi.fn() };
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
import { armedIntents, clearAllIntents, fireIntent } from "../services/dispatchIntent";
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
/** The text the agent's terminal actually received. */
const sentText = () => h.dispatch.mock.calls.map((c) => c[1]);

/** Stage a screenshot through the compose box's attach affordance. The paperclip rests collapsed,
 *  so the actions have to be REVEALED first — hover is the mouse path (focus is the keyboard one;
 *  ComposeBox.test.tsx covers both). What this suite cares about is only that a file is staged. */
async function attachImage() {
  h.pick.mockResolvedValue([shot]);
  fireEvent.mouseEnter(screen.getByTestId("concierge-attach"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  });
}
/**
 * Let every armed send's countdown run out.
 *
 * An agent-bound send ARMS an intent (services/dispatchIntent) the user can cancel, and only the
 * uncancelled expiry delivers — so a suite asserting what reached the PTY has to pass through the
 * gate. Fired directly rather than by advancing timers, so this suite keeps real timers.
 */
async function elapseCountdowns() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    // Generously many: the expiry re-enters the send queue and the delivery it runs is several
    // awaits deep, so too few ticks reads as "the send never happened" rather than as a race.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
  await elapseCountdowns();
}

beforeEach(() => {
  // Intents are a module-level registry, so one suite's armed send would otherwise leak into the
  // next row's `armedIntents()` and be fired against a fresh render.
  clearAllIntents();
  h.dispatch.mockClear();
  h.pick.mockReset();
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
  render(<ConciergeHost feed={FEED} promptTarget={target} />);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConciergeHost — a terse picker answer with files staged", () => {
  it("sends the answer UNPREFIXED so the matcher can still see it", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    expect(chips()).toBeTruthy(); // the file really is staged
    await send("Yes");
    expect(sentText()).toEqual(["Yes"]);
    // The exact failure: a path anywhere in the payload defeats the anchored matcher.
    expect(sentText()[0]).not.toContain("/tmp/shot.png");
  });

  it("HOLDS the attachments rather than consuming them on a keystroke", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    await send("Yes");
    // Still staged, still on screen — the picker answer was a keystroke, not a message that could
    // have carried a file, so spending them would have cost the user the picking for nothing. The
    // chips staying up is also the only signal that they weren't sent.
    expect(chips()).toBeTruthy();
    expect(screen.getByTitle("shot.png")).toBeTruthy();
  });

  it("carries those held files on the NEXT ordinary message", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await attachImage();
    await send("Yes");
    h.answersLivePicker.mockReturnValue(false); // the picker is answered and gone
    await send("now look at this");
    expect(sentText()[1]).toContain("/tmp/shot.png");
    expect(sentText()[1]).toContain("now look at this");
    // …and NOW they are consumed.
    expect(chips()).toBeNull();
  });

  // The other half of the gate. An instruction that merely opens with a yes word is NOT a picker
  // answer, so it keeps the prefix — stripping it would silently drop the user's files from a real
  // message.
  it("still prefixes a message that is not a picker answer", async () => {
    h.answersLivePicker.mockReturnValue(false);
    await attachImage();
    await send("yes, but rename the flag first");
    expect(sentText()[0]).toContain("/tmp/shot.png");
    expect(sentText()[0]).toContain("yes, but rename the flag first");
    expect(chips()).toBeNull(); // consumed, as an ordinary send does
  });

  it("changes nothing when no files are staged", async () => {
    h.answersLivePicker.mockReturnValue(true);
    await send("Yes");
    expect(sentText()).toEqual(["Yes"]);
  });

  // The predicate is asked about the agent the message is AIMED at, with the text the user actually
  // typed — never the payload, which is the thing it exists to decide the shape of.
  it("asks about the aimed agent, using the typed text", async () => {
    await attachImage();
    await send("Yes");
    expect(h.answersLivePicker).toHaveBeenCalledWith("ag1", "Yes");
  });
});
