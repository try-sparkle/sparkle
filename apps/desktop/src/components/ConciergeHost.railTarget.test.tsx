// @vitest-environment jsdom
//
// WHO THE AUTO-SEND RAIL SAYS YOUR WORDS ARE GOING TO.
//
// ══ THE DAMAGE THIS PINS ════════════════════════════════════════════════════════════════════════
// The user was answering the CONCIERGE's own design questions in the concierge compose box while a
// build agent's pane happened to be on screen. Their answers were dispatched into that build agent's
// terminal. They noticed only because the concierge's replies stopped making sense.
//
// The rail is the surface that was supposed to catch that — its whole label is "where this send is
// about to land", read at a glance during a countdown. It was fed `routingTarget?.name`: the agent
// whose pane is showing. That is an INHERITED target, chosen by navigating, not by the user saying
// anything about where their words should go — so the one warning surface was confidently naming
// the wrong destination, and with auto-send armed the countdown then fired into it hands-free.
//
// The rule now, both here and in services/conciergeRouter: the default target is ALWAYS "Concierge",
// and the only thing that can name an agent is the user @-mentioning one in THIS message.
//
// These rows assert the RENDERED LABEL — the side effect — and the last one asserts the label and
// the actual delivery together, because a label that agrees with nothing is the failure mode that
// replaces a label that lies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(async (_agentId: string, _text: string, _opts?: unknown) => ({
    ok: true,
    path: "free-text",
  })),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  /** Which side the cable is patched to. "off" = the concierge floats free (unmounted), which is
   *  what every row above the mounted block runs under. */
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
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
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
// `h.wired` NO LONGER MOUNTS ANYTHING — the mount is the CABLE's own pin as of bead sparkle-9gsjqm,
// and `useEffectiveWired` is the DRAWING projection its own header always said it was. The knob is
// kept because every row below reads off it; `wireCableTo` turns it into a real `cableStore.patch`.
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
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
  // The tray parks at Speak in `beforeEach`, and a Speak position ARMS the real microphone through
  // the shipped `useMicActions` — which refuses while out of credits (`shouldBlockMicArm`). The
  // default test user is the anonymous trial, so without a stocked balance every row below would run
  // against a mic the app was right to leave off. Vitest also throws on ACCESS to an export a
  // factory omits, so this has to be here whether or not the balance matters to the assertion.
  hasAiCredits: () => true,
}));

const RUNTIME = {
  status: { ag1: "idle", ag2: "waiting" },
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
import { armedIntents, cancelIntent, fireIntent } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useUiStore } from "../stores/uiStore";
import { useProjectStore } from "../stores/projectStore";
// THE REAL CABLE — what actually mounts, as of bead sparkle-9gsjqm.
import { useCableStore, resetCable } from "../stores/cableStore";

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
const COUNTS = { needs_you: 0, questions: 0, running: 0, done: 2 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [agent("ag1", "Blueprint UI/UX"), agent("ag2", "Kraken Auth")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** THE ON-SCREEN AGENT — the inherited target the rail used to name. Every row below runs with this
 *  set, because a rail that says "Concierge" when nothing is selected proves nothing: the bug was
 *  precisely that a selection the user never made became a destination. */
const SELECTED: ConciergePromptTarget = {
  projectId: "p1",
  agentId: "ag1",
  name: "Blueprint UI/UX",
};

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
/** The tray's Speak position. Its accessible name IS the destination while a countdown runs
 *  (see SendModeTray) — that is the mis-route safety net this file exercises. */
const speakPill = () => screen.getByRole("button", { name: /^Speak/ });

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  // PARKED AT SPEAK, because the tray only names a destination while it is counting down.
  // This is also the state the reported damage happened under — armed plus an inherited target is
  // dictated speech reaching a PTY with no deliberate act at all.
  useUiStore.setState({ conciergeSendMode: "speak" });
  h.dispatchConciergeAnswer.mockClear();
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.wired.mockReset();
  h.wired.mockReturnValue("off");
  // The cable is a module singleton and now decides the mount — a leaked patch would mount a later
  // row that never asked for one.
  resetCable();
  // THE MOUNTED NAME IS READ OFF THIS ROW, not off the feed: `mountedName` comes from the roster row
  // this pin resolves to in `projectStore` (the host needs that row's worktree path for the
  // transcript). Without it the pin is UNRESOLVABLE, and the rail says "the mounted agent" — never
  // "Concierge", but not the agent's name either, which is what most rows below are about.
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: [
          { id: "ag1", name: "Blueprint UI/UX", worktreePath: "/tmp/wt/ag1" },
          { id: "ag2", name: "Kraken Auth", worktreePath: "/tmp/wt/ag2" },
        ],
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  cleanup();
  useUiStore.setState({ conciergeSendMode: "send" });
  resetCable();
  vi.clearAllMocks();
});

/** THE MOUNTING GESTURE, spelled as `AgentRow` spells it, driven off the same `h.wired` knob the
 *  rows already set. `"off"` unbinds — which is what those rows have always meant by it. */
function wireCableTo(target: ConciergePromptTarget | null) {
  const side = h.wired();
  act(() => {
    if (side === "off" || !target) useCableStore.getState().unbind();
    else useCableStore.getState().patch(side, target.agentId);
  });
}
function mount() {
  wireCableTo(SELECTED);
  return render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
}

/** Type into the compose box. The caret is asserted onto the node because the mention query reads
 *  it, and the host's `composedText` arrives through an effect — hence the act flush. */
async function type(text: string) {
  const ta = box();
  await act(async () => {
    fireEvent.change(ta, {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
    await Promise.resolve();
  });
}

/** What the tray says this send would reach, right now. */
async function railTarget(): Promise<string> {
  const name = speakPill().getAttribute("aria-label") ?? "";
  return name.replace(/^Speak → /, "");
}

describe("the rail names the CONCIERGE unless the user named an agent", () => {
  // ── THE REPORTED BUG ────────────────────────────────────────────────────────────────────────
  // Before the fix this read "Blueprint UI/UX" — the pane on screen — for text the user wrote to
  // the concierge.
  it("REGRESSION: says Concierge for unaddressed text, even with a build agent selected", async () => {
    mount();
    await type("yes, use the second option");
    expect(await railTarget()).toBe("Concierge");
    expect(await railTarget()).not.toBe("Blueprint UI/UX");
  });

  // The terse answer to a live ask is the exact shape that used to be captured — by the router's
  // removed heuristic on the send side, and by the inherited target on the label side. `ag2` is in
  // `waiting` in the runtime store above, so an on-screen agent really is mid-question.
  it("REGRESSION: a bare yes is still for the concierge", async () => {
    mount();
    await type("yes");
    expect(await railTarget()).toBe("Concierge");
  });

  it("says Concierge when the box is empty", async () => {
    mount();
    expect(await railTarget()).toBe("Concierge");
  });

  // An @ that names nobody in the fleet resolves to no mention at all (Concierge/mentions is
  // derive-from-text and fails CLOSED), so the label must fall back, not guess.
  it("says Concierge when the text names an agent that does not exist", async () => {
    mount();
    await type("@Nobody At All ship it");
    expect(await railTarget()).toBe("Concierge");
  });

  // The selection is not an aim, but merely MENTIONING the selected agent is — this pins that the
  // fix did not turn into "never name an agent".
  it("names the selected agent once the user actually @-mentions it", async () => {
    mount();
    await type("@Blueprint UI/UX move it 5px");
    expect(await railTarget()).toBe("Blueprint UI/UX");
  });
});

describe("the rail names the agent the TEXT addresses, not the one on screen", () => {
  it("names the @-mentioned agent over the selected one", async () => {
    mount();
    await type("@Kraken Auth ship the DMG");
    expect(await railTarget()).toBe("Kraken Auth");
  });

  // One destination per message — `send` routes `mentions[0]`, so the label has to agree.
  it("names the FIRST mention when the message names two", async () => {
    mount();
    await type("@Kraken Auth and @Blueprint UI/UX both ship");
    expect(await railTarget()).toBe("Kraken Auth");
  });

  // Editing the address away drops the aim (derive-from-text), so the label must drop with it —
  // a stale agent name over concierge-bound words is the original bug in miniature.
  it("goes back to Concierge when the mention is edited out", async () => {
    mount();
    await type("@Kraken Auth ship the DMG");
    expect(await railTarget()).toBe("Kraken Auth");
    await type("ship the DMG");
    expect(await railTarget()).toBe("Concierge");
  });

  // ── THE DESTINATION LIVES IN THE ACCESSIBLE NAME, NOT THE VISIBLE TEXT ──────────────────────
  // This row used to assert the opposite ("draws the destination as visible text too"). The founder
  // asked for the pill to read exactly "Speak" — no arrow, no destination — because the composed
  // `Speak → <target>` label set the width pressure for all three `flex: 1` pills and truncated the
  // whole tray to "S… P… S…" in a narrow concierge column. The destination was unreadable there
  // anyway, AND it took the three position names down with it.
  //
  // The safety net is not gone, it MOVED: `title` + `aria-label` still track the target, which the
  // rows above already exercise through `railTarget()`. What is pinned here is the new contract, so
  // the visible label cannot silently regrow the target — the mistake would otherwise be invisible
  // at the widths a developer usually looks at.
  it("keeps the destination OUT of the visible text while the accessible name still tracks it", async () => {
    mount();
    await type("@Kraken Auth ship the DMG");
    // Visible: the position's name, and nothing else — at every target.
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak");
    expect(screen.getByTestId("send-mode-tray").textContent).not.toContain("Kraken Auth");
    // Accessible: the target, tracked live off the composed text.
    expect(await railTarget()).toBe("Kraken Auth");

    await type("ship the DMG");
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak");
    expect(screen.getByTestId("send-mode-tray").textContent).not.toContain("Concierge");
    expect(await railTarget()).toBe("Concierge");

    // NO WCAG-containment assertion here, deliberately. One lived at this spot and was VACUOUS
    // (roborev 56202): `speakPill()` queries `getByRole("button", { name: /^Speak/ })`, so the
    // accessible name is already required to start with "Speak" before the assertion runs — and the
    // visible string is pinned to "Speak" two lines up. `expect(name).toContain("Speak")` could not
    // fail. The containment invariant is tested where it can actually break: across widths in
    // SendModeTray.test.tsx, and across the two label tables in voice/sendMode.test.ts.
  });
});

// ══ AND WHILE MOUNTED, THE DEFAULT DESTINATION IS THE MOUNTED AGENT — SO THE RAIL MUST SAY SO ═══
// The damage at the top of this file, with the destinations swapped. Once a plain mounted message
// started routing to the mounted agent's TERMINAL, this rail still announced "Concierge" for it —
// so the founder dictating hands-free reads "Sending to Concierge shortly", lets the countdown
// fire, and his words land on a PTY. One value feeds both surfaces (`useAutoSend` returns
// `targetName` to the tray and to `voice/autoSendTimer`'s "Sending to X shortly." / "Sent to X."),
// so pinning the pill's accessible name pins the spoken announcement too.
//
// EVERY ROW HERE IS A PAIR — the same text mounted and unmounted. A single mounted expectation
// would pass against a rail hard-coded to the mount, and the unmounted half of this file would not
// catch that alone; stating both is what makes the MOUNT the thing being measured.
describe("the rail names the MOUNTED agent when nothing in the text overrides it", () => {
  it("REGRESSION: says the mounted agent for plain text, and Concierge without the mount", async () => {
    h.wired.mockReturnValue("left");
    mount();
    await type("move the button 5px left");
    expect(await railTarget()).toBe("Blueprint UI/UX");
    expect(await railTarget()).not.toBe("Concierge");

    cleanup();
    h.wired.mockReturnValue("off");
    mount();
    await type("move the button 5px left");
    expect(await railTarget()).toBe("Concierge");
  });

  // THE ESCAPE HATCH, rendered. A leading @Sparkle beats the mount in `classifyComposerRoute`, so
  // the label has to leave the mounted agent's name — otherwise the one way out of the mount is the
  // one send the rail misreports.
  it("says Concierge for a leading @Sparkle, mounted or not", async () => {
    h.wired.mockReturnValue("left");
    mount();
    await type("@Sparkle what is the status of the build?");
    expect(await railTarget()).toBe("Concierge");
    expect(await railTarget()).not.toBe("Blueprint UI/UX");
  });

  // AN ADDRESS OVERRULES THE MOUNT, so the label follows the address rather than the cable.
  it("names an addressed agent over the mounted one", async () => {
    h.wired.mockReturnValue("left");
    mount();
    await type("@Kraken Auth ship the DMG");
    expect(await railTarget()).toBe("Kraken Auth");
  });

  // ══ AND IT MUST NOT SAY "Concierge" WHEN THE MOUNT HAS NO projectStore ROW (roborev 59212) ═════
  // Every other mounted row here seeds that row, so all of them passed while a `?? "Concierge"`
  // still closed the expression — the fallback was unreachable from this suite and the lie was
  // invisible exactly where it mattered. `mountedName` is `mountedRow?.name ?? (mountedIsSparkle ?
  // … )`, so it is `undefined` for a mounted agent with no row that is not the app-owned Sparkle
  // one, while `routableMountedAgentId` stays non-null and the send still aims at that PTY.
  //
  // Bead `sparkle-gw8yi` records a real agent in exactly that state, so this is a shape the app
  // has already produced once. The rail must name the target the send aims at, and above all must
  // NOT name the concierge over a message bound for a terminal.
  //
  // ══ WHAT IT NAMES CHANGED, AND THE CHANGE IS THE FIX (bead sparkle-9gsjqm) ═════════════════════
  // It used to fall back to `promptTarget.name`, i.e. the SELECTION's name. That is the wrong agent
  // in the founder's reproduction B — with the Improve-Sparkle pane visible over a mounted build
  // agent the selection is `__sparkle_self__`, so the rail would have promised "Sparkle" over words
  // bound for that build agent's PTY, which is the same lie this row exists against wearing a
  // different name. The placeholder is the honest answer for a mount this window cannot name; what
  // the row still pins, and pins first, is that it is never "Concierge".
  it("REGRESSION: names the mount, not Concierge, when the agent has no projectStore row", async () => {
    useProjectStore.setState({
      projects: [] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
    });
    h.wired.mockReturnValue("left");
    mount();
    await type("move the button 5px left");
    // The lie this row exists to catch. Asserted first and on its own, so a future refactor that
    // returns some third string still cannot quietly reintroduce "Concierge" here.
    expect(await railTarget()).not.toBe("Concierge");
    // …and it says a mount is where this is going, without inventing a name for it.
    expect(await railTarget()).toBe("the mounted agent");
  });

  // ── A NAME THAT DOES NOT LEAD IS THE SENTENCE'S SUBJECT ──────────────────────────────────────
  // This rail used to read `mentionsIn(...)[0]` by ORDINAL while the send routed POSITIONALLY, so
  // this message was announced as going to Kraken Auth and delivered to the mount. Deriving the
  // label from `classifyComposerRoute` is what closes that, and this is the row that proves it —
  // the pair below shows the same text becomes a real address once the name leads.
  it("follows the mount for a mid-sentence name, and the name once it leads", async () => {
    h.wired.mockReturnValue("left");
    mount();
    await type("why is @Kraken Auth just sitting there?");
    expect(await railTarget()).toBe("Blueprint UI/UX");

    await type("@Kraken Auth why are you just sitting there?");
    expect(await railTarget()).toBe("Kraken Auth");
  });
});

// THE ANTI-DRIFT ROW. Replacing a label that lies with a label that merely disagrees with delivery
// would be no better, so this asserts BOTH ENDS of one send: what the rail promised, and which
// terminal actually received it.
describe("the label and the destination are computed the same way", () => {
  it("delivers to exactly the agent the rail named", async () => {
    mount();
    await type("@Kraken Auth ship the DMG");
    const promised = await railTarget();
    expect(promised).toBe("Kraken Auth");

    await act(async () => {
      // PRESS THE SELECTED POSITION. The tray is parked at Speak here, so Speak is what sends —
      // pressing the unselected Send pill would move the tray instead, which is the tray's whole
      // point (one control, one press target) and would silently send nothing.
      fireEvent.click(speakPill());
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    await act(async () => {
      for (const i of armedIntents()) fireIntent(i.id);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    await waitFor(() => expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1));
    // "Kraken Auth" is ag2; the SELECTED agent is ag1. The rail named the one that got the words.
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
  });

  // And the other direction: what the rail calls "Concierge" must not reach a terminal at all.
  it("sends nothing to a terminal when the rail says Concierge", async () => {
    mount();
    await type("yes, use the second option");
    expect(await railTarget()).toBe("Concierge");

    await act(async () => {
      // PRESS THE SELECTED POSITION. The tray is parked at Speak here, so Speak is what sends —
      // pressing the unselected Send pill would move the tray instead, which is the tray's whole
      // point (one control, one press target) and would silently send nothing.
      fireEvent.click(speakPill());
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    await act(async () => {
      for (const i of armedIntents()) fireIntent(i.id);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });
});
