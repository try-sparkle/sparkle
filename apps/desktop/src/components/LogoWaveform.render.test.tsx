// @vitest-environment jsdom
//
// Honest-listening render gating. The pure helpers (captionFor/barFraction) are covered in
// logoWaveform.test.ts; this exercises the regression-prone render branch that the helpers
// can't reach: the caption must switch on ACTUAL capture (`status === "listening"`), not on
// the armed `enabled` flag, so an armed-but-focus-paused mic never claims to be hearing you.
//
// SINCE THE SEND TRAY BECAME THE ONLY MIC CONTROL, this surface also has to agree with the tray's
// position — so most cases set `conciergeSendMode` as well as the dictation store. The two are not
// independent inputs the component reconciles: the position decides what the mic DRAWS and which
// caption it shows, and the dictation store decides only whether capture is genuinely live.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The permission notice's "Open System Settings" button deep-links through the Tauri opener; mock
// it so the click is observable without a real IPC (same shape as the Composer voice tests).
const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { LogoWaveform } from "./LogoWaveform";
import { BACKEND_MIC_DENIED } from "../voice/backendVoiceErrors";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { C } from "../theme/colors";

// jsdom has no rAF by the time the effect runs in some setups; stub a no-op so the live
// loop can schedule without throwing. We assert on the rendered caption, not animation frames.
beforeEach(() => {
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  useDictationStore.setState({
    level: 0,
    phase: "passive",
    enabled: true,
    status: "idle",
    error: null,
    modelProgress: null,
    outOfCreditsNotice: false,
  });
  // Push to talk is the position that matches the dictation defaults above (armed, not routing), so
  // the health-ladder cases below read exactly as they did before the tray existed. Cases about the
  // live/off states set their own.
  useUiStore.setState({ conciergeSendMode: "ptt" });
  // Arming the mic now requires credits (MicButton.shouldBlockMicArm) and the sidebar force-offs an
  // armed mic when the balance is empty. Seed a credited user so the honest-listening cases behave
  // as before; the out-of-credits behavior is exercised in its own describe block below.
  useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 } });
});
afterEach(() => cleanup());

describe("LogoWaveform — the error caption reports the REAL failure", () => {
  // This caption was the app's ONLY consumer of dictationStore.error, and it used the value as a
  // mere boolean: every failure — no mic hardware, an exotic sample format, an offline model
  // download, a full disk — rendered the same hardcoded "check System Settings → Privacy →
  // Microphone". The payload plumbed here from the dictation://error listener was discarded, so a
  // first-run user with no internet could never discover the true cause.
  it("an offline download failure does NOT blame microphone privacy", () => {
    useDictationStore.setState({ error: "Dns Failed: resolve error", status: "error" });
    render(<LogoWaveform />);
    expect(document.body.textContent).toMatch(/couldn't download the voice model/i);
    expect(document.body.textContent).not.toMatch(/Privacy/);
  });

  it("a real permission failure still gets the Privacy remedy", () => {
    useDictationStore.setState({ error: "microphone permission denied", status: "error" });
    render(<LogoWaveform />);
    expect(document.body.textContent).toMatch(/can't use the microphone/i);
    expect(document.body.textContent).toMatch(/Privacy & Security → Microphone/);
  });

  it("no input device gets its own remedy, not the permission one", () => {
    useDictationStore.setState({ error: "no input device available", status: "error" });
    render(<LogoWaveform />);
    expect(document.body.textContent).toMatch(/no microphone found/i);
  });

  it("an unrecognized error shows its raw text rather than a guessed cause", () => {
    useDictationStore.setState({ error: "app_data_dir() failed: no home", status: "error" });
    render(<LogoWaveform />);
    expect(document.body.textContent).toContain("app_data_dir() failed: no home");
  });

  it("the error outranks the download caption (a failed download isn't still downloading)", () => {
    useDictationStore.setState({
      error: "No space left on device (os error 28)",
      status: "error",
      modelProgress: { done: 1, total: 482_000_000 },
    });
    render(<LogoWaveform />);
    expect(document.body.textContent).toMatch(/disk space/i);
    expect(document.body.textContent).not.toMatch(/setting up voice/i);
  });
});

// This surface renders the same notice as the composer, so it needs the same way out — a remedy
// that exists in only one of the two places is a remedy the user may never be looking at
// (roborev 37737). The backend counterpart is src-tauri/src/mic_permission.rs.
describe("LogoWaveform — a denied microphone gets the same one-click remedy as the composer", () => {
  const DENIED = BACKEND_MIC_DENIED;

  // The console.warn spy is installed/removed HERE rather than inside the one test that needs it.
  // Restoring at the end of a test body only runs if every assertion before it passed, so a single
  // failure would leave console.warn mocked for the rest of the file — swallowing warnings in
  // unrelated tests and turning one red test into a confusing several (roborev 37848). afterEach
  // runs regardless.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    openUrl.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("opens the Microphone privacy pane directly", () => {
    useDictationStore.setState({ error: DENIED, status: "error" });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openUrl).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
  });

  it("offers System Settings ONLY for permission — never for a failure it cannot fix", () => {
    for (const raw of [
      "Dns Failed: resolve error",
      "No space left on device (os error 28)",
      "no input device available",
      "Permission denied (os error 13)", // a MODEL-DIR write failure, not the mic
    ]) {
      cleanup();
      useDictationStore.setState({ error: raw, status: "error" });
      render(<LogoWaveform />);
      expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
    }
  });

  it("keeps the notice readable when the pane itself fails to open", async () => {
    // The `.catch` on openUrl claims the notice survives a rejected open — the detail line spells
    // out the path, so it stays the user's way through even when the shortcut breaks. Asserted
    // rather than left to the comment (roborev 37737).
    //
    // The console.warn assertion is what gives this teeth: rendering-survives alone passes even
    // with the `.catch` deleted (verified — vitest does not fail this test on an unhandled
    // rejection), so it would pin nothing. Observing the warn proves the catch actually ran.
    openUrl.mockImplementationOnce(() => Promise.reject(new Error("no handler for URL scheme")));
    useDictationStore.setState({ error: DENIED, status: "error" });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      "voice: open microphone settings failed",
      expect.any(Error),
    );
    expect(document.body.textContent).toMatch(/Privacy & Security → Microphone/);
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeTruthy();
  });
});

describe("LogoWaveform — the first-run model download caption", () => {
  it("shows setting-up with progress while the model comes down", () => {
    useDictationStore.setState({ modelProgress: { done: 241_000_000, total: 482_000_000 } });
    render(<LogoWaveform />);
    expect(document.body.textContent).toContain("Setting up voice (50%)");
  });

  it("WARM start (no download in flight) shows no setting-up caption at all", () => {
    useDictationStore.setState({ modelProgress: null, status: "listening" });
    render(<LogoWaveform />);
    expect(document.body.textContent).not.toMatch(/setting up voice/i);
  });
});

describe("LogoWaveform — honest listening", () => {
  // The live caption splits across TWO lines / many nodes ("Mic paused." + "Say" /
  // <span>Hey Sparkle</span> / "to activate"), so match the element whose text carries both the
  // status line and the wake phrase — a stable signal that can't be fooled by the bare word
  // "Sparkle" turning up elsewhere (an aria-label or title). It is a DIV now, not a button: the
  // caption used to toggle phase on click, which was a second mic control.
  const wakeHint = () => {
    const t = document.body.textContent?.replace(/\s+/g, " ") ?? "";
    return /Mic paused\./.test(t) && /Hey Sparkle/.test(t) ? t : null;
  };

  it("armed + actually listening → shows the live wake hint, not 'Listening paused'", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(wakeHint()).not.toBeNull();
    expect(screen.queryByText(/Listening paused/)).toBeNull();
  });

  it("armed but paused (not listening) → 'Listening paused' hint, not the wake hint", () => {
    useDictationStore.setState({ enabled: true, status: "idle", phase: "passive" });
    render(<LogoWaveform />);
    expect(
      screen.getByText(
        "Listening paused: Will auto-resume when you re-focus on this project.",
      ),
    ).toBeTruthy();
    // The wake-hint caption must NOT render when paused.
    expect(wakeHint()).toBeNull();
  });

  it("Speak + listening → 'Actively listening' status with the Sparkle, pause command", () => {
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    const t = document.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(t).toMatch(/Actively listening/);
    expect(t).toMatch(/Sparkle, pause/);
    // The passive wake hint must NOT show while actively dictating.
    expect(wakeHint()).toBeNull();
  });

  it("muted → no caption at all", () => {
    useUiStore.setState({ conciergeSendMode: "send" });
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    expect(screen.queryByText(/Listening paused/)).toBeNull();
    expect(wakeHint()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The mic INDICATOR — one state with the send tray, and no longer a control
// ---------------------------------------------------------------------------
//
// The ring, the waveform strip and the caption were three separate click targets that moved
// `enabled`/`phase` behind the tray's back. Each of them could put the mic into a state the tray
// contradicted — the wake word alone did it, flipping `phase` and turning the ring green under a
// tray parked on "Push to talk". These assert the ring now RENDERS the tray's position and does
// nothing at all when operated.
describe("LogoWaveform — the mic indicator is a read-out of the send tray", () => {
  /** The ring, found by the anchor attribute rather than by role — the point of these tests is that
   *  it no longer HAS an interactive role. */
  const ring = () => document.querySelector('[data-hint="mic"]') as HTMLElement;

  it("paints the tray's three positions in three distinct colours", () => {
    // Probe jsdom's normalized form of each token so the assertions are format-agnostic, and assert
    // the tokens are DISTINCT first: if cssstyle ever declined one of these assignments, `probe`
    // would keep the previous value and two of the three checks below would silently become the
    // same check (roborev 54231).
    const probe = document.createElement("span");
    probe.style.color = C.successInk;
    const GREEN = probe.style.color;
    probe.style.color = C.amber;
    const ORANGE = probe.style.color;
    probe.style.color = C.muted;
    const GREY = probe.style.color;
    expect(new Set([GREEN, ORANGE, GREY]).size, "two indicator colours normalized to the same string — the assertions below would be vacuous").toBe(3);

    // Speak → GREEN. Live capture is set up too, but it is the POSITION that decides the colour.
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    expect(ring().style.color).toBe(GREEN);
    cleanup();

    // Push to talk → ORANGE.
    useUiStore.setState({ conciergeSendMode: "ptt" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(ring().style.color).toBe(ORANGE);
    cleanup();

    // Send → GREY.
    useUiStore.setState({ conciergeSendMode: "send" });
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
    render(<LogoWaveform />);
    expect(ring().style.color).toBe(GREY);
  });

  it("stays ORANGE on Push to talk even after the WAKE WORD moves the phase", () => {
    // THE desync, reproduced at its actual trigger. `phase` is not the tray's to set — the wake
    // matcher flips it with no click anywhere — so an indicator reading the dictation store went
    // green while the tray still said "Push to talk". Nothing about the tray changed here.
    const probe = document.createElement("span");
    probe.style.color = C.amber;
    const ORANGE = probe.style.color;
    probe.style.color = C.successInk;
    const GREEN = probe.style.color;
    expect(ORANGE).not.toBe(GREEN);

    useUiStore.setState({ conciergeSendMode: "ptt" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    expect(ring().style.color).toBe(ORANGE);
    expect(ring().style.color).not.toBe(GREEN);
    // …and the caption agrees with it, rather than announcing a dictation the tray never entered.
    expect(document.body.textContent).toMatch(/Mic paused\./);
    expect(document.body.textContent).not.toMatch(/Actively listening/);
  });

  it("is not a control: no button role, no click handler, no hover pill", () => {
    useUiStore.setState({ conciergeSendMode: "ptt" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    const el = ring();
    // Not a button by role, and not a <button> by tag — either would be operable by keyboard.
    expect(el.tagName).not.toBe("BUTTON");
    expect(el.getAttribute("role")).toBe("img");
    // No onClick: React attaches nothing, so clicking cannot move the store. Asserted at the SIDE
    // EFFECT rather than by inspecting props — a handler that ran and happened to be a no-op would
    // still be a control waiting to grow a body.
    const before = { ...useDictationStore.getState() };
    fireEvent.click(el);
    fireEvent.mouseEnter(el);
    fireEvent.mouseDown(el);
    expect(useDictationStore.getState().enabled).toBe(before.enabled);
    expect(useDictationStore.getState().phase).toBe(before.phase);
    // The three-option hover pill is gone with it — hovering must not open a menu.
    expect(screen.queryByRole("menu", { name: "Microphone mode" })).toBeNull();
  });

  it("never claims OFF over a live capture — the mic armed from another surface", () => {
    // The state useSendMode's reconcile deliberately creates (it stands down rather than release a
    // mic armed elsewhere), and it SURVIVES A RELAUNCH: dictationStore persists {enabled, phase}
    // while conciergeSendMode defaults to "send". Deriving the ring from the position alone drew a
    // slashed grey mic labelled "Microphone: off" beside a waveform strip sweeping with real audio.
    useUiStore.setState({ conciergeSendMode: "send" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).not.toMatch(/off/i);
    const probe = document.createElement("span");
    probe.style.color = C.muted;
    expect(ring().style.color).not.toBe(probe.style.color);
  });

  it("never draws a READY mic while the voice model is still downloading", () => {
    // MicButton documents the download glyph as deliberately not a mic shape, "so it cannot be
    // mistaken for a ready mic at a glance". The position cannot know a download is in flight, so
    // deriving from it alone painted the green live mic under "Setting up voice (50%)".
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      modelProgress: { done: 241_000_000, total: 482_000_000 },
    });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).toMatch(/setting up voice/i);
    // The caption directly beneath says the same thing, rather than arguing with it.
    expect(document.body.textContent).toContain("Setting up voice (50%)");
  });

  it("never draws the live GREEN mic while capture is focus-paused", () => {
    // Speak with `status: "idle"` — armed, not capturing. The caption reads "Listening paused…",
    // and a green mic above it would be the adjacent-elements contradiction, one state over.
    const probe = document.createElement("span");
    probe.style.color = C.successInk;
    const GREEN = probe.style.color;
    probe.style.color = C.amber;
    const ORANGE = probe.style.color;
    expect(GREEN).not.toBe(ORANGE);

    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({ enabled: true, status: "idle", phase: "active" });
    render(<LogoWaveform />);
    expect(ring().style.color).toBe(ORANGE);
    expect(ring().getAttribute("aria-label")).not.toMatch(/actively listening/i);
    expect(document.body.textContent).toMatch(/Listening paused/);
  });

  it("names the STATE it is showing, so a screen reader is not promised an action", () => {
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).toBe("Microphone: actively listening");
    // The old action labels must not survive anywhere on this surface.
    expect(screen.queryByRole("button", { name: /microphone|listening|Activate Sparkle voice/i })).toBeNull();
  });

  it("nothing else on this surface toggles the mic either — the strip and caption are read-outs", () => {
    // The waveform strip and the caption were both `onClick={togglePhase}`. Removing only the ring's
    // handler would leave the same defect reachable by two other click targets.
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    const { container } = render(<LogoWaveform />);
    const before = useDictationStore.getState().phase;
    for (const b of Array.from(container.querySelectorAll("button"))) fireEvent.click(b);
    expect(useDictationStore.getState().phase).toBe(before);
    expect(useDictationStore.getState().enabled).toBe(true);
  });
});

describe("LogoWaveform — out of credits", () => {
  it("this surface offers NO arming affordance at all — the refusal moved to the tray with the arm", () => {
    // The refusal itself (`shouldBlockMicArm`) now lives entirely on the tray's path: this sidebar
    // stopped being a mic control, so the arm it used to attempt cannot be attempted from here.
    //
    // Asserted as the ABSENCE OF THE AFFORDANCE, not as "enabled stayed false" — that was already
    // true before the click and passes against the pre-change component too (the old control
    // refused the arm and left `enabled` false), which is the canonical vacuous shape AGENTS.md
    // names. The claim this test's name makes is "there is nothing to press", so it asserts that.
    useAuthStore.setState({ me: null }); // no credits
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: false });
    render(<LogoWaveform />);
    // No control anywhere on this surface whose name offers to operate the microphone.
    expect(
      screen.queryByRole("button", { name: /microphone|listening|dictat|voice|activate/i }),
    ).toBeNull();
    // …and the ring specifically is a read-out, not a button that merely renamed itself.
    const ring = document.querySelector('[data-hint="mic"]') as HTMLElement;
    expect(ring.getAttribute("role")).toBe("img");
    expect(ring.tagName).not.toBe("BUTTON");
  });

  it("clicking Refill deep-opens the ⋯ settings dialog on the Credits pane", () => {
    useAuthStore.setState({ me: null });
    useUiStore.setState({ settingsRequest: null });
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));
    // The link requests the Credits category; TopBar consumes settingsRequest to open the dialog.
    expect(useUiStore.getState().settingsRequest).toBe("credits");
    useDictationStore.getState().clearOutOfCreditsNotice();
  });

  it("renders the two-line notice whenever the shared flag is set (both surfaces stay in sync)", () => {
    useAuthStore.setState({ me: null }); // still out of credits, so the notice isn't auto-cleared
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    expect(screen.getByText("You are out of credits.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refill" })).toBeTruthy();
    // The normal paused/wake caption must not co-render.
    expect(screen.queryByText(/Mic paused/)).toBeNull();
    useDictationStore.getState().clearOutOfCreditsNotice();
  });

  it("safety: an armed mic is forced off when the balance is empty", () => {
    // Credits ran out mid-session while the mic was on. The sidebar effect releases it so voice
    // detection can't keep running without credits.
    useAuthStore.setState({ me: null });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("a lingering notice is dropped once credits arrive (never sits next to a usable mic)", () => {
    // beforeEach seeds a credited user, so the effect should clear the notice on mount.
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
    expect(screen.queryByText("You are out of credits.")).toBeNull();
  });
});

describe("the ring reflects the CARET, not just the tray — through the component", () => {
  // ── WHY THESE LIVE HERE AND NOT IN micPresentation.test.ts (roborev 56706) ────────────────────
  // The pure table is already tested there. What was NOT tested is the only production line the
  // terminal work adds: the `terminalRoutes` wiring in this component. Every other new row calls
  // `micIndicatorFor` with a hand-written literal, so hard-coding the prop true, hard-coding it
  // false, or deleting it outright left the whole suite green — the assertion held against a
  // different function than the one that changed. These drive the store, like the rest of this file.
  const ring = () => screen.getByRole("img", { name: /microphone/i });

  it("draws the grey OFF ring when the caret is in a terminal that cannot receive", () => {
    // The founder's rule, at the surface where he actually sees it. Wake gate shut (phase passive),
    // so the terminal is a pause rather than a destination.
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      focusOwner: "terminal",
      windowFocused: true,
    });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).toMatch(/off/i);
  });

  it("keeps the ring HONEST when that terminal is receiving the phrase", () => {
    // The exact regression from the commit before last: an unconditional demotion painted
    // "Microphone: off" while dictation was typing into this terminal.
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      focusOwner: "terminal",
      windowFocused: true,
    });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).toMatch(/actively listening/i);
  });

  it("does NOT claim a routing terminal in a BACKGROUND window", () => {
    // `terminalRoutingArmed` is only the mic-state half; the shipped `isTerminalRoutable` also
    // requires the window. Two Sparkle windows, caret in a terminal here, focus moved to the other:
    // this window types nothing, so the ring must not paint green (roborev 56706).
    useUiStore.setState({ conciergeSendMode: "speak" });
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "active",
      focusOwner: "terminal",
      windowFocused: false,
    });
    render(<LogoWaveform />);
    expect(ring().getAttribute("aria-label")).toMatch(/off/i);
    // ── AND THE SENTENCE PRINTED UNDER IT (roborev 56775) ────────────────────────────────────────
    // Asserting the ring alone certified the half that was corrected and was blind to the half that
    // still lied: `captionFor` reads `status === "listening"`, which the per-window blur path
    // deliberately never demotes, so this state rendered "Actively listening: just say <stop> to
    // finish" directly beneath a grey "Microphone: off" ring — the ring denying its own caption,
    // which is the same contradiction shape the window term was added to remove.
    expect(document.body.textContent).not.toMatch(/actively listening/i);
  });
});
