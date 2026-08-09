import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  useDictationStore,
  DICTATION_PERSIST_KEY,
  micMuteTransitionLine,
  OUT_OF_CREDITS_NOTICE_MS,
} from "./dictationStore";
import { log } from "../logger";

const reset = () =>
  useDictationStore.setState({
    enabled: true,
    phase: "passive",
    insertTarget: null,
  });

describe("dictationStore — ambient fields", () => {
  beforeEach(reset);

  it("defaults: enabled true, phase passive", () => {
    const s = useDictationStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("passive");
  });

  it("togglePhase flips passive↔active", () => {
    useDictationStore.getState().togglePhase();
    expect(useDictationStore.getState().phase).toBe("active");
    useDictationStore.getState().togglePhase();
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("insert() routes to the registered target", () => {
    const seen: string[] = [];
    useDictationStore.getState().registerInsert((t) => seen.push(t));
    useDictationStore.getState().insert("hello world");
    expect(seen).toEqual(["hello world"]);
  });

  it("insert() is a no-op when no target is registered", () => {
    expect(() => useDictationStore.getState().insert("x")).not.toThrow();
  });

  it("setEnabled toggles the enabled flag", () => {
    useDictationStore.getState().setEnabled(false);
    expect(useDictationStore.getState().enabled).toBe(false);
    useDictationStore.getState().setEnabled(true);
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  it("setPhase sets the phase directly", () => {
    useDictationStore.getState().setPhase("active");
    expect(useDictationStore.getState().phase).toBe("active");
    useDictationStore.getState().setPhase("passive");
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("persists phase to the shared blob so active/paused carries across windows", () => {
    // The active/paused status the user selects must survive cross-window rehydration, exactly like
    // `enabled` (on/off) already does. That means `phase` must land in the persisted localStorage
    // blob (partialize), not stay window-local runtime state.
    useDictationStore.getState().setPhase("active");
    const raw = localStorage.getItem(DICTATION_PERSIST_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.phase).toBe("active");

    useDictationStore.getState().setPhase("passive");
    expect(JSON.parse(localStorage.getItem(DICTATION_PERSIST_KEY)!).state.phase).toBe("passive");
  });

  it("registerInsert(null) deregisters — insert() no longer calls old fn", () => {
    const seen: string[] = [];
    useDictationStore.getState().registerInsert((t) => seen.push(t));
    useDictationStore.getState().registerInsert(null);
    useDictationStore.getState().insert("should not appear");
    expect(seen).toEqual([]);
  });
});

// The app logged NOTHING when the mic was enabled or disabled, which is why one of the two
// candidate causes of the founder's app-wide freeze could not be ruled out from the logs: there was
// no way to know what the master mute was doing at the time (bead sparkle-thm9o). The trace's
// keydown line now carries `micPhase`, but that only fires on a keystroke — the transition itself
// has to be its own record, or a freeze with no keystrokes at all still says nothing.
describe("micMuteTransitionLine", () => {
  it("is null when nothing changed — the contract is TRANSITION, not per-poll", () => {
    expect(micMuteTransitionLine(true, true, "toggle")).toBeNull();
    expect(micMuteTransitionLine(false, false, "toggle")).toBeNull();
  });

  it("names both ends of the transition and the reason", () => {
    expect(micMuteTransitionLine(false, true, "toggle")).toBe("mic master-mute: off -> on (toggle)");
    expect(micMuteTransitionLine(true, false, "toggle")).toBe("mic master-mute: on -> off (toggle)");
  });
});

describe("dictationStore — mic master-mute transitions are logged", () => {
  beforeEach(() => {
    useDictationStore.setState({ enabled: false, outOfCreditsNotice: false });
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs once when setEnabled actually flips the mute", () => {
    useDictationStore.getState().setEnabled(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect((log.info as any).mock.calls[0][1]).toBe("mic master-mute: off -> on (toggle)");
  });

  it("logs NOTHING when setEnabled is called with the value it already has", () => {
    useDictationStore.getState().setEnabled(true);
    vi.clearAllMocks();
    useDictationStore.getState().setEnabled(true);
    useDictationStore.getState().setEnabled(true);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs the reverse transition too", () => {
    useDictationStore.getState().setEnabled(true);
    vi.clearAllMocks();
    useDictationStore.getState().setEnabled(false);
    expect((log.info as any).mock.calls[0][1]).toBe("mic master-mute: on -> off (toggle)");
  });

  // The out-of-credits countdown forces the mute on WITHOUT going through setEnabled. An
  // unattributed "the mic went off" line is exactly the kind of half-signal that sent today's
  // investigation down a blind alley, so this path names itself.
  it("attributes the out-of-credits auto-deactivate to its own reason", () => {
    vi.useFakeTimers();
    useDictationStore.getState().setEnabled(true);
    vi.clearAllMocks();
    useDictationStore.getState().showOutOfCreditsNotice();
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS);
    expect(useDictationStore.getState().enabled).toBe(false);
    expect((log.info as any).mock.calls[0][1]).toBe(
      "mic master-mute: on -> off (out-of-credits auto-deactivate)",
    );
  });

  it("does not log the out-of-credits deactivate when the mic was already off", () => {
    vi.useFakeTimers();
    useDictationStore.getState().showOutOfCreditsNotice();
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS);
    expect(log.info).not.toHaveBeenCalled();
  });

  describe("the held-hold transcript (the founder's clipboard recovery hatch)", () => {
    beforeEach(() => {
      useDictationStore.setState({ heldSegments: [] });
    });

    it("accumulates everything spoken during one hold, in order", () => {
      const s = useDictationStore.getState();
      s.appendHeldSegment("open the");
      s.appendHeldSegment("pod bay doors");
      expect(useDictationStore.getState().takeHeldTranscript()).toBe("open the pod bay doors");
    });

    it("belongs to ONE hold — taking clears it, so the next hold cannot inherit these words", () => {
      // The failure this prevents is the worst kind for a clipboard feature: a hold that recorded
      // nothing would otherwise copy the PREVIOUS hold's sentence, and the user would paste words
      // they did not just say without any signal that it was stale.
      const s = useDictationStore.getState();
      s.appendHeldSegment("first hold");
      expect(useDictationStore.getState().takeHeldTranscript()).toBe("first hold");
      expect(useDictationStore.getState().takeHeldTranscript()).toBe("");
      expect(useDictationStore.getState().heldSegments).toEqual([]);
    });

    it("reports an empty string for a hold that recorded nothing", () => {
      // This is the (a) case — the mic never started. The empty result is what the release edge
      // keys on to leave the clipboard ALONE, rather than blanking whatever he had copied earlier
      // at the exact moment dictation failed him.
      expect(useDictationStore.getState().takeHeldTranscript()).toBe("");
    });

    it("normalises whitespace so a paste is not littered with the segment boundaries", () => {
      const s = useDictationStore.getState();
      s.appendHeldSegment("  ragged   spacing ");
      s.appendHeldSegment("\nand a newline");
      expect(useDictationStore.getState().takeHeldTranscript()).toBe("ragged spacing and a newline");
    });

    it("is NOT persisted — a relaunch must not put last session's speech on the clipboard", () => {
      // partialize keeps only `enabled` and `phase`; anything else surviving a relaunch would mean
      // the first release after launch copies words spoken before the app was quit.
      useDictationStore.getState().appendHeldSegment("secret");
      const persisted = JSON.parse(localStorage.getItem(DICTATION_PERSIST_KEY) ?? "{}");
      expect(persisted.state?.heldSegments).toBeUndefined();
    });
  });
});
