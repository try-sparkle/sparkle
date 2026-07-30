// @vitest-environment jsdom
//
// PUSH TO TALK AND SPEAK, IN THE REAL COMPOSER — the end-to-end rows.
//
// WHY THIS FILE EXISTS. The send tray was designed on a standalone HTML prototype and stayed there
// for a dozen review rounds; `grep -r "push-to-talk" apps/desktop/src` returned nothing while the
// feature was being called finished. These rows are the ones that cannot pass against a prototype:
// they mount the SHIPPING ConciergeHost, hold ⌘ on the real window, and assert that the real
// microphone went live and the real send path ran.
//
// Each row fails against the previous code by construction — before the tray there was no mode to
// park at, no key bound to the microphone, and no inert state. The unit files
// (voice/sendMode.test.ts, voice/usePushToTalk.test.tsx, Concierge/SendModeTray.test.tsx) pin the
// rules; this pins that the app is actually WIRED to them.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  // Mirror EVERY export the tree touches: Vitest throws on ACCESS to an export a factory omits, so
  // a partial mock breaks the whole file the moment the host reaches for one more symbol — which is
  // exactly what a rebase onto a moved `main` does.
  onConciergeIdentityReset: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", micLive: false, registerInsert: vi.fn() }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
// The mic REFUSES TO ARM while out of credits (components/MicButton `shouldBlockMicArm`), and the
// default test user is the anonymous trial. Without a stocked balance every row here would assert
// against a microphone the app was right to leave off — a green suite proving nothing.
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
  hasAiCredits: () => true,
}));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { clearAllIntents } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";
import { PARTIAL_SETTLE_CAP_MS } from "../voice/useSendMode";

const FEED = {
  projects: [],
  counts: { needs_you: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, running: 0, done: 0 },
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  useUiStore.setState({ conciergeSendMode: "send" });
  useDictationStore.setState({ enabled: false, phase: "passive", focusOwner: "other", interim: "" });
});
afterEach(() => {
  cleanup();
  clearAllIntents();
  useUiStore.setState({ conciergeSendMode: "send" });
  useDictationStore.setState({ enabled: false, phase: "passive", focusOwner: "other", interim: "" });
  vi.clearAllMocks();
});

function mount() {
  render(<ConciergeHost feed={FEED} promptTarget={null} />);
}

const tray = () => screen.getByTestId("send-mode-tray");
const pill = (m: string) =>
  tray().querySelector<HTMLButtonElement>(`[data-mode-pill="${m}"]`)!;
const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

function type(text: string) {
  act(() => {
    fireEvent.change(box(), {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
  });
}

/** The microphone as the SHIPPED store reports it — not a spy on the tray. `enabled` is the mic
 *  being armed at all; `phase === "active"` is it routing speech at the box. */
const mic = () => {
  const s = useDictationStore.getState();
  return { enabled: s.enabled, phase: s.phase };
};

describe("the tray IS the microphone", () => {
  it("mounts with a real three-position tray in the concierge composer", () => {
    // The blunt one. Before this, apps/desktop had a Send button and an auto-send switch; there was
    // no tray, no Push to talk and no Speak anywhere in the shipping tree.
    mount();
    expect(pill("send")).toBeTruthy();
    expect(pill("ptt")).toBeTruthy();
    expect(pill("speak")).toBeTruthy();
    expect(tray().getAttribute("data-mode")).toBe("send");
  });

  it("Send leaves the microphone OFF — an off state for the mic, not for the control", () => {
    mount();
    expect(mic().enabled).toBe(false);
    // …and the control is the most actionable it ever gets in exactly that state.
    expect(pill("send").getAttribute("aria-pressed")).toBe("true");
  });

  it("sliding to Speak takes the real microphone LIVE", () => {
    mount();
    act(() => fireEvent.click(pill("speak")));
    expect(mic()).toEqual({ enabled: true, phase: "active" });
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("sliding to Push to talk ARMS the mic without routing speech at the box", () => {
    // Armed, not hot. Anything else would make "push to talk" an always-on microphone with a
    // decorative key.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    expect(mic()).toEqual({ enabled: true, phase: "passive" });
  });

  it("sliding back to Send RELEASES the microphone", () => {
    mount();
    act(() => fireEvent.click(pill("speak")));
    expect(mic().enabled).toBe(true);
    act(() => fireEvent.click(pill("send")));
    expect(mic().enabled).toBe(false);
  });

  it("does NOT release a mic armed somewhere else — the mount reconcile stands down", () => {
    // The tray's default is `send`, whose mic call RELEASES the microphone. The mic is armable from
    // surfaces this tray knows nothing about (the header ring, the voice menu, another window, a
    // persisted `enabled: true`), so an unconditional reconcile would have the concierge mounting
    // quietly switch off a mic the user had just turned on. Releasing is the one direction that
    // destroys state set elsewhere.
    useDictationStore.setState({ enabled: true, phase: "active" });
    useUiStore.setState({ conciergeSendMode: "send" });
    mount();
    expect(mic()).toEqual({ enabled: true, phase: "active" });
  });

  it("…and it does NOT promote that mic into Speak, which would arm auto-send nobody asked for", () => {
    // An earlier version "adopted" the position describing the mic, which quietly turned "the user
    // armed the mic in the header" into "the user consented to auto-send" — the one position that
    // dispatches irreversible instructions on its own, and one uiStore's own contract says has to be
    // switched on deliberately, once, by the user. A remount is not that (roborev 55971).
    useDictationStore.setState({ enabled: true, phase: "active" });
    useUiStore.setState({ conciergeSendMode: "send" });
    mount();
    expect(tray().getAttribute("data-mode")).toBe("send");
    expect(useUiStore.getState().conciergeSendMode).toBe("send");
  });

  it("…nor demote a LISTENING mic by adopting Push to talk instead", () => {
    // The other adoption that looks safe and is not: the mode setter DRIVES the mic, so landing on
    // `ptt` would push `passive` onto a mic the user had set to `listening` — the same clobber the
    // stand-down exists to avoid, just gentler.
    useDictationStore.setState({ enabled: true, phase: "active" });
    useUiStore.setState({ conciergeSendMode: "send" });
    mount();
    expect(mic().phase).toBe("active");
    expect(tray().getAttribute("data-mode")).not.toBe("ptt");
  });

  it("a DELIBERATE move to Send still releases the mic — adoption is a mount rule, not a veto", () => {
    // The distinction the adoption rule has to preserve: "nobody chose this position" is not the
    // same as "the user just chose it". Without it, Send would become unreachable the moment the
    // mic was on — a tray you cannot switch off.
    mount();
    act(() => fireEvent.click(pill("speak")));
    expect(mic().enabled).toBe(true);
    act(() => fireEvent.click(pill("send")));
    expect(mic().enabled).toBe(false);
    expect(tray().getAttribute("data-mode")).toBe("send");
  });

  it("a mode restored from the persisted blob still drives the mic on mount", () => {
    // Nobody CLICKED, so nothing ran the mode's mic call — the tray would come back reading "Speak"
    // over a released microphone, which is the two-controls-disagreeing failure the tray exists to
    // delete. The reconcile-on-mount effect is what closes it.
    useUiStore.setState({ conciergeSendMode: "speak" });
    mount();
    expect(mic()).toEqual({ enabled: true, phase: "active" });
  });
});

describe("hold ⌘ anywhere to talk; release sends", () => {
  it("holding ⌘ takes the mic live, and releasing puts it back to armed", () => {
    mount();
    act(() => fireEvent.click(pill("ptt")));
    expect(mic().phase).toBe("passive");

    act(() => fireEvent.keyDown(window, { key: "Meta" }));
    expect(mic()).toEqual({ enabled: true, phase: "active" });

    act(() => fireEvent.keyUp(window, { key: "Meta" }));
    expect(mic()).toEqual({ enabled: true, phase: "passive" });
  });

  it("the hold works with focus NOWHERE NEAR the compose box", () => {
    // "Anywhere" is the feature. A push-to-talk that only works while the caret is parked in the
    // textarea is not one — the whole point is reading the thread, or a diff, and still speaking.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    act(() => document.body.focus());
    act(() => fireEvent.keyDown(window, { key: "Meta" }));
    expect(mic().phase).toBe("active");
  });

  it("RELEASING sends what is in the box, through the composer's own send path", async () => {
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("ship the staging branch");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(h.startConciergeTurn).toHaveBeenCalledWith(
      expect.stringContaining("ship the staging branch"),
    );
    // Through the BOX's submit, not a send assembled out here — so the words leave the textarea
    // with the message rather than sitting behind it.
    expect(box().value).toBe("");
  });

  it("⌘Tab away mid-hold sends NOTHING and leaves the draft intact", async () => {
    // ⌘Tab never delivers its keyup, so blur is the only end this hold gets. Abandoning is the safe
    // direction: a send nobody asked for is the failure this feature exists to make impossible.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("half a thought");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.blur(window);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("half a thought");
    // …and the mic is back to armed rather than stuck hot behind the user's back.
    expect(mic().phase).toBe("passive");
  });

  it("holding ⌘ in Speak or Send does NOT hijack the key", async () => {
    // ⌘ is the OS's modifier everywhere else. Binding it outside Push to talk would break ⌘C, ⌘V
    // and ⌘↩ in the one box the user types in.
    mount();
    act(() => fireEvent.click(pill("speak")));
    type("still typing");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("still typing");
  });
});

// ── RELEASE SENDS. FULL STOP — and it sends the WHOLE phrase ────────────────────────────────────
//
// The founder closed the spec's one open question in his own words: "on push-to-talk release, it
// should immediately send." No countdown, no grace period, no confirmation step. These rows pin the
// two things that follow, because both are easy to get wrong in ways nothing else would catch.
describe("release sends immediately, and sends everything", () => {
  it("the DELIBERATE mode never inherits the automatic one's timer", () => {
    // Push to talk must not run — or wait on — the auto-send countdown. That is the exact
    // laggy-feeling failure the spec worried about: a timer after an explicit "I'm done" makes the
    // deliberate mode feel slower than the hands-free one. Asserted as the absence of the SWEEP,
    // which is the countdown's only visible existence, rather than as a timer that is hard to prove
    // absent.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("ship it");
    expect(screen.queryByTestId("send-tray-sweep")).toBeNull();
    expect(tray().getAttribute("data-counting")).toBeNull();
  });

  it("sends in the keyup's own tick when nothing is still resolving", () => {
    // No fake timers, and nothing advanced: if a delay had crept in, this row could not pass.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("ship it");
    act(() => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
    });
    expect(box().value).toBe("");
  });

  it("RELEASE WITH A PENDING PARTIAL sends the COMPLETE phrase, not a truncated one", async () => {
    // THE ROW THAT MATTERS MOST. On the cloud path Deepgram publishes a live `interim` and only
    // later commits it as a segment that reaches the composer. Sending in the keyup's own tick with
    // an interim outstanding delivers half a sentence — or, for one short utterance, an empty box
    // and no message at all. So the release waits for the interim to CLEAR (the commit landing) and
    // sends then: the whole phrase, with no delay anyone chose.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("ship the");
    act(() => useDictationStore.getState().setInterim("staging branch"));

    act(() => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
    });
    // Nothing has gone out yet — the phrase is still arriving.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("ship the");

    // …the segment commits: the words reach the box and the interim clears.
    type("ship the staging branch");
    await act(async () => {
      useDictationStore.getState().setInterim("");
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(h.startConciergeTurn).toHaveBeenCalledWith(
      expect.stringContaining("ship the staging branch"),
    );
    expect(box().value).toBe("");
  });

  it("…and the wait is not a fixed delay — it ends when the transcript lands, not on a clock", async () => {
    // The distinction between "waits for the commit" and "waits 1.5s". With real timers and nothing
    // advanced, the send happens the instant the interim clears; a fixed-delay implementation could
    // not pass this row.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("deploy it");
    act(() => useDictationStore.getState().setInterim("now"));
    act(() => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    await act(async () => {
      useDictationStore.getState().setInterim("");
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  it("a commit that never arrives still sends, rather than stranding the message", async () => {
    // The backstop. If the socket drops or capture is torn down mid-utterance the interim never
    // clears, and a message swallowed forever is worse than a possibly-truncated one.
    vi.useFakeTimers();
    try {
      mount();
      act(() => fireEvent.click(pill("ptt")));
      type("half a thought");
      act(() => useDictationStore.getState().setInterim("and the rest"));
      act(() => {
        fireEvent.keyDown(window, { key: "Meta" });
        fireEvent.keyUp(window, { key: "Meta" });
      });
      expect(h.startConciergeTurn).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(PARTIAL_SETTLE_CAP_MS + 10);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaking again CANCELS a release still waiting — the phrase is not finished after all", async () => {
    // A new hold means the user carried on talking, so what they were about to send is no longer the
    // whole of what they mean to say. Without this the pending send fires under the new utterance.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("ship the");
    act(() => useDictationStore.getState().setInterim("staging"));
    act(() => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
    });
    // …they press ⌘ again before the commit lands.
    act(() => fireEvent.keyDown(window, { key: "Meta" }));
    await act(async () => {
      useDictationStore.getState().setInterim("");
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("ship the");
  });

  it("an ABANDONED hold never waits on a partial — it was never going to send", async () => {
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("half a thought");
    act(() => useDictationStore.getState().setInterim("and the rest"));
    act(() => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.blur(window);
    });
    await act(async () => {
      useDictationStore.getState().setInterim("");
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("half a thought");
  });
});

describe("a terminal owning the keyboard makes the tray inert", () => {
  it("goes flat grey while KEEPING the selected mode", () => {
    mount();
    act(() => fireEvent.click(pill("speak")));
    act(() => useDictationStore.getState().setFocusOwner("terminal"));

    expect(tray().style.filter).toBe("grayscale(1)");
    expect(tray().getAttribute("data-inert")).toBe("true");
    // Not reset — merely not receiving you.
    expect(tray().getAttribute("data-mode")).toBe("speak");
    expect(pill("speak").getAttribute("aria-pressed")).toBe("true");
  });

  it("colour returns the instant focus leaves the terminal", () => {
    mount();
    act(() => useDictationStore.getState().setFocusOwner("terminal"));
    expect(tray().style.filter).toBe("grayscale(1)");
    act(() => useDictationStore.getState().setFocusOwner("other"));
    expect(tray().style.filter).toBe("");
  });

  it("the hold gesture stands down while a PTY owns the keyboard", async () => {
    // Every keystroke is going to another process; taking ⌘ from it would be this app reaching
    // across a boundary it deliberately respects everywhere else.
    mount();
    act(() => fireEvent.click(pill("ptt")));
    type("not for the terminal");
    act(() => useDictationStore.getState().setFocusOwner("terminal"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "Meta" });
      fireEvent.keyUp(window, { key: "Meta" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(box().value).toBe("not for the terminal");
  });
});
