// @vitest-environment jsdom
//
// CaptureApp smoke + behavior, following the helper island's no-backend pattern: the Tauri
// boundary (captureEvents) is mocked so a synthetic `capture://shot` can be fired by hand, and
// the app-level dictation controller is stubbed out (its own wiring is covered by
// useDictation.test / the composer dictation tests — here we only exercise CaptureApp's glue).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureSendPayload, CaptureShot } from "./types";

let shotHandler: ((shot: CaptureShot) => void) | null = null;
const emitCaptureSend = vi.fn((_: CaptureSendPayload) => Promise.resolve());
const hideCaptureWindow = vi.fn(() => Promise.resolve());

vi.mock("./captureEvents", () => ({
  onCaptureShot: (h: (shot: CaptureShot) => void) => {
    shotHandler = h;
    return Promise.resolve(() => {});
  },
  emitCaptureSend: (p: CaptureSendPayload) => emitCaptureSend(p),
  hideCaptureWindow: () => hideCaptureWindow(),
}));
// App-level ambient voice controller — a live Tauri pipeline; no-op under test.
vi.mock("../useDictation", () => ({ useAmbientVoice: () => {} }));

import { CaptureApp } from "./CaptureApp";
import { useProjectStore } from "../stores/projectStore";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import {
  LIVE_COMPOSER_PLACEHOLDER,
  PTT_COMPOSER_PLACEHOLDER,
  SPEAK_COMPOSER_PLACEHOLDER,
} from "../voice/dictationCopy";
import type { SendMode } from "../voice/sendMode";
import { useAuthStore } from "../stores/authStore";
import { LAST_FOCUSED_PROJECT_KEY } from "./lastFocusedProject";
import { LOGO_SRC } from "../components/SparkleWordmark";
import { THEME_HEX } from "../theme/colors";
import { asRgb, prefixedStyle } from "../components/statusDotTestUtils";
import type { Project } from "../types";

const SHOT: CaptureShot = { path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AAAA" };
const projects = [
  { id: "proj-1", name: "Alpha", agents: [] },
  { id: "proj-2", name: "Beta", agents: [] },
] as unknown as Project[];

const fireShot = (shot: CaptureShot = SHOT) => act(() => shotHandler?.(shot));

beforeEach(() => {
  shotHandler = null;
  emitCaptureSend.mockClear();
  hideCaptureWindow.mockClear();
  localStorage.clear();
  useProjectStore.setState({ projects });
});
afterEach(() => cleanup());

/** The takeover's send buttons, by the label a user actually reads. They render an icon beside that
 *  label, so `getByText` on a concatenated "Chat ❯" string no longer finds them. */
function sendButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("CaptureApp", () => {
  // The capture window renders its own React root with NO AuthGate, so unless it loads auth itself,
  // `me` stays null → hasAiCredits false → the mic falsely reports "out of credits" and gets
  // force-disabled (LogoWaveform), making its status disagree with the signed-in main window. It
  // must refresh auth on mount AND every time the takeover opens (a top-up done while it was closed
  // must be reflected before the user can touch the mic).
  it("refreshes auth on mount and on each shot so the credit balance isn't stale", () => {
    const original = useAuthStore.getState().refresh;
    const refresh = vi.fn(() => Promise.resolve());
    useAuthStore.setState({ refresh });
    try {
      render(<CaptureApp />);
      expect(refresh).toHaveBeenCalledTimes(1); // mount

      fireShot();
      expect(refresh).toHaveBeenCalledTimes(2); // takeover opened

      fireShot({ path: "/tmp/shot2.png", dataUrl: "data:image/png;base64,BBBB" });
      expect(refresh).toHaveBeenCalledTimes(3); // re-capture
    } finally {
      useAuthStore.setState({ refresh: original });
    }
  });

  it("renders nothing until a shot arrives, then scrim + the two send buttons", async () => {
    render(<CaptureApp />);
    expect(screen.queryByTestId("capture-scrim")).toBeNull();

    fireShot();

    expect(screen.getByTestId("capture-scrim")).toBeTruthy();
    expect(screen.getByAltText("Captured screenshot")).toBeTruthy();
    expect(sendButton("Chat")).toBeTruthy();
    // "Plan" is RETIRED, not renamed away from a still-live route — the Chief PRD pipeline
    // behind it is gone (see CaptureSendMode). Pinned so a revert has to be deliberate.
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    // Build OPENS A MENU rather than sending, so it carries a down caret where Chat carries a
    // send chevron. Both are react-icons now (this repo bans emoji-as-icons), so the distinction
    // is the icon each button renders, not a glyph baked into its label.
    expect(sendButton("Build")).toBeTruthy();
    expect(sendButton("Chat").querySelector("svg")).toBeTruthy();
    expect(sendButton("Build").querySelector("svg")).toBeTruthy();
  });

  it("paints the SAME masked wordmark the rest of the app does, not the raw cyan asset", () => {
    // The takeover kept its own `<img src="/sparkle-logo.svg">` when the concierge column's mark
    // became an alpha mask over gold, so the app showed two wordmarks that disagreed (roborev
    // 53986). Both windows now render `SparkleWordmark`; the raw asset must not come back as an
    // image, because an `<img>` here paints the asset's own cyan→blue gradient.
    render(<CaptureApp />);
    fireShot();
    const mark = screen.getByRole("img", { name: "Sparkle" });
    expect(mark.tagName).toBe("SPAN");
    // The mask that is actually applied, and the dark literal behind it — this window pins
    // data-theme=dark, so the themed var would be the wrong paint here.
    expect(mark.style.maskImage).toBe(`url(${LOGO_SRC})`);
    // The prefixed spellings too: the shipped WebView is WebKit-based, so those are the ones that
    // actually paint (roborev 54033). Same pair the concierge column's mark pins, read through the
    // shared `prefixedStyle` helper, which records where jsdom keeps them.
    expect(prefixedStyle(mark, "WebkitMaskImage")).toBe(`url(${LOGO_SRC})`);
    expect(mark.style.maskSize).toBe("contain");
    expect(prefixedStyle(mark, "WebkitMaskSize")).toBe("contain");
    expect(mark.style.background).toBe(asRgb(THEME_HEX.dark.goldInk));
    expect(document.querySelector('img[src="/sparkle-logo.svg"]')).toBeNull();
  });

  it("defaults the project switcher to the last-focused project", () => {
    localStorage.setItem(
      LAST_FOCUSED_PROJECT_KEY,
      JSON.stringify({ projectId: "proj-2", at: 1 }),
    );
    render(<CaptureApp />);
    fireShot();
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("proj-2");
  });

  it("Chat sends the full payload (text may be empty) and hides the window", () => {
    render(<CaptureApp />);
    fireShot();

    fireEvent.click(sendButton("Chat"));

    expect(emitCaptureSend).toHaveBeenCalledWith({
      mode: "chat",
      projectId: "proj-1", // no last-focused record → first project
      text: "",
      attachments: [{ path: SHOT.path, dataUrl: SHOT.dataUrl }],
    });
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    // Session is cleared for the next capture.
    expect(screen.queryByTestId("capture-scrim")).toBeNull();
  });

  it("Build opens the options menu (does NOT send); 'New build agent' sends with forceNewAgent", () => {
    render(<CaptureApp />);
    fireShot();

    fireEvent.click(sendButton("Build"));
    // Menu is open, nothing sent yet.
    expect(emitCaptureSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("build-menu")).toBeTruthy();

    fireEvent.click(screen.getByTestId("build-menu-new"));
    expect(emitCaptureSend).toHaveBeenCalledWith({
      mode: "build",
      projectId: "proj-1",
      text: "",
      attachments: [{ path: SHOT.path, dataUrl: SHOT.dataUrl }],
      forceNewAgent: true,
    });
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("capture-scrim")).toBeNull();
  });

  it("Build menu lists existing build agents by display name; picking one routes targetAgentId", () => {
    const projWithBuilds = [
      {
        id: "proj-1",
        name: "Alpha",
        agents: [
          { id: "b1", kind: "build", name: "Build 1", autoNameVariants: null },
          {
            id: "b2",
            kind: "build",
            name: "fallback name",
            autoNameVariants: { title: "Fix login", description: "" },
          },
          { id: "w1", kind: "worker", name: "Ideation", autoNameVariants: null },
        ],
      },
    ] as unknown as Project[];
    useProjectStore.setState({ projects: projWithBuilds });
    render(<CaptureApp />);
    fireShot();

    fireEvent.click(sendButton("Build"));
    // Only build agents are listed (the worker agent is not), and autoNameVariants.title wins.
    expect(screen.queryByText("Ideation")).toBeNull();
    expect(screen.getByText("Build 1")).toBeTruthy();
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.queryByText("fallback name")).toBeNull();

    fireEvent.click(screen.getByText("Fix login"));
    expect(emitCaptureSend).toHaveBeenCalledWith({
      mode: "build",
      projectId: "proj-1",
      text: "",
      attachments: [{ path: SHOT.path, dataUrl: SHOT.dataUrl }],
      targetAgentId: "b2",
    });
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
  });

  it("clicking the Build menu backdrop closes the menu without closing the takeover", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.click(sendButton("Build"));
    expect(screen.getByTestId("build-menu")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("build-menu-backdrop"));
    expect(screen.queryByTestId("build-menu")).toBeNull();
    expect(hideCaptureWindow).not.toHaveBeenCalled();
    expect(screen.getByTestId("capture-scrim")).toBeTruthy();
  });

  it("send buttons are disabled with no project to select", () => {
    useProjectStore.setState({ projects: [] });
    render(<CaptureApp />);
    fireShot();
    expect(sendButton("Build").disabled).toBe(true);
    fireEvent.click(sendButton("Build"));
    // Disabled Build must not open the menu nor send.
    expect(screen.queryByTestId("build-menu")).toBeNull();
    expect(emitCaptureSend).not.toHaveBeenCalled();
  });

  it("Esc with an empty textarea hides immediately (no confirm)", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard capture?")).toBeNull();
  });

  it("Esc with narration shows the inline confirm; Discard then hides", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.change(screen.getByPlaceholderText(/Narrate what you captured/), {
      target: { value: "the login button is broken" },
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(hideCaptureWindow).not.toHaveBeenCalled();
    expect(screen.getByText("Discard capture?")).toBeTruthy();

    fireEvent.click(screen.getByText("Keep editing"));
    expect(screen.queryByText("Discard capture?")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByText("Discard"));
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("capture-scrim")).toBeNull();
  });

  it("scrim click closes immediately with an empty textarea", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.mouseDown(screen.getByTestId("capture-scrim"));
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
  });

  it("scrim click ALWAYS closes immediately — no confirm even with narration", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.change(screen.getByPlaceholderText(/Narrate what you captured/), {
      target: { value: "note to self" },
    });
    fireEvent.mouseDown(screen.getByTestId("capture-scrim"));
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard capture?")).toBeNull();
    expect(screen.queryByTestId("capture-scrim")).toBeNull();
  });

  it("a click bubbling up from the card does NOT close the modal", () => {
    render(<CaptureApp />);
    fireShot();
    // A mousedown on the card (not the scrim itself) must not trigger the scrim's close.
    fireEvent.mouseDown(screen.getByTestId("capture-card"));
    expect(hideCaptureWindow).not.toHaveBeenCalled();
    expect(screen.getByTestId("capture-scrim")).toBeTruthy();
  });

  it("the corner Cancel button closes immediately, even with narration (no confirm)", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.change(screen.getByPlaceholderText(/Narrate what you captured/), {
      target: { value: "keep or not" },
    });
    fireEvent.click(screen.getByTestId("capture-cancel"));
    expect(hideCaptureWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard capture?")).toBeNull();
    expect(screen.queryByTestId("capture-scrim")).toBeNull();
  });

  it("a re-capture keeps unsent narration but resets the shot", () => {
    render(<CaptureApp />);
    fireShot();
    fireEvent.change(screen.getByPlaceholderText(/Narrate what you captured/), {
      target: { value: "keep this thought" },
    });

    fireShot({ path: "/tmp/shot2.png", dataUrl: "data:image/png;base64,BBBB" });

    const ta = screen.getByPlaceholderText(/listening|Narrate/i) as HTMLTextAreaElement;
    expect(ta.value).toBe("keep this thought");
    expect((screen.getByAltText("Captured screenshot") as HTMLImageElement).src).toContain("BBBB");
  });

  it("portrait shots put the composer to the right of the image", () => {
    render(<CaptureApp />);
    fireShot();
    const img = screen.getByAltText("Captured screenshot") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 400 });
    Object.defineProperty(img, "naturalHeight", { value: 900 });
    fireEvent.load(img);
    expect(screen.getByTestId("capture-card").style.flexDirection).toBe("row");
  });

  it("reconciles the selection when the chosen project disappears mid-capture", () => {
    localStorage.setItem(
      LAST_FOCUSED_PROJECT_KEY,
      JSON.stringify({ projectId: "proj-2", at: 1 }),
    );
    render(<CaptureApp />);
    fireShot();
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("proj-2");

    act(() => {
      useProjectStore.setState({ projects: projects.slice(0, 1) }); // proj-2 deleted elsewhere
    });
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("proj-1");
  });
});

describe("CaptureApp — the live voice copy is the capture window's own, never the tray's", () => {
  // THE GAP THIS CLOSES (roborev 57795). This window briefly rendered the concierge tray's copy,
  // and both of that copy's promises are false here: it has no auto-send (`useAutoSend` is mounted
  // only by ConciergeHost), so "pause when you're done" promises a dispatch that never comes; and a
  // push-to-talk hold claims `voiceSurface: "concierge"`, so "Hold ⌘ to talk" points at a gesture
  // that fills a different column.
  //
  // The only live-copy assertion this file had was `getByPlaceholderText(/listening|Narrate|wake
  // word/i)` — a regex satisfied by the old tray-keyed strings, the new sentence AND the muted
  // fallback alike, so reverting either half of the fix left it green. These pin both halves: WHICH
  // sentence, and the CONDITION (a hot mic paints it whatever the tray says, where the tray-keyed
  // version fell through to the muted fallback on the default `send`).
  const liveMic = () =>
    act(() => {
      useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    });

  afterEach(() => {
    act(() => {
      useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
      useUiStore.getState().setConciergeSendMode("send");
    });
  });

  it("says the mic is hot in EVERY tray position, and never borrows the tray's sentence", () => {
    for (const mode of ["send", "ptt", "speak"] as SendMode[]) {
      act(() => useUiStore.getState().setConciergeSendMode(mode));
      render(<CaptureApp />);
      fireShot();
      liveMic();
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(ta.placeholder, mode).toBe(LIVE_COMPOSER_PLACEHOLDER);
      expect(ta.placeholder, mode).not.toBe(PTT_COMPOSER_PLACEHOLDER);
      expect(ta.placeholder, mode).not.toBe(SPEAK_COMPOSER_PLACEHOLDER);
      // The muted fallback is what the tray-keyed version fell through to on the default `send`,
      // leaving a live microphone with no cue at all.
      expect(ta.placeholder, mode).not.toMatch(/Narrate what you captured/);
      cleanup();
    }
  });

  it("falls back to its own muted copy when the mic is NOT live", () => {
    // The other half: without this, "always shows the live sentence" would also pass.
    render(<CaptureApp />);
    fireShot();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toMatch(/Narrate what you captured/);
    expect(ta.placeholder).not.toBe(LIVE_COMPOSER_PLACEHOLDER);
  });
});

