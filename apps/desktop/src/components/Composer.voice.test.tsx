// @vitest-environment jsdom
//
// The first-run voice surface in the COMPOSER — the place the user is actually looking when they
// click the composer mic. Two confirmed bugs are pinned here:
//
//  1. The composer lied for the entire multi-minute first-run model download. useDictation sets
//     status "listening" optimistically BEFORE start_dictation, so with phase "passive" the
//     composer painted wakePlaceholder() — "Mic paused. Say Hey Sparkle to activate" — inviting the
//     user to talk to a model that was still coming down the wire. Composer never read
//     modelProgress at all, so the download was entirely absent from this surface.
//  2. Dictation errors were reported ONLY under the sidebar logo, in 10px muted gray, as one
//     hardcoded "check Privacy → Microphone" sentence — a different region of the screen from the
//     mic the user clicked, and the wrong cause for most failures.
//
// Boundary mocks mirror Composer.dictation.test.tsx.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => ({
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/trialMeter", () => ({
  trialSendAllowed: () => true,
  recordTrialSend: vi.fn(() => Promise.resolve()),
}));
// The permission notice's "Open System Settings" button deep-links through the Tauri opener; mock
// it so the click is observable without a real IPC (same shape as SettingsDialog/ToolsPane tests).
const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { Composer } from "./Composer";
import { BACKEND_MIC_DENIED } from "../voice/backendVoiceErrors";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import { WAKE_PHRASE } from "../voice/dictationCopy";

// Mid-download: the optimistic "listening" status + passive phase is EXACTLY the state that used to
// render the wake-word invitation. modelProgress is what distinguishes it from a ready mic.
const DOWNLOADING = { done: 241_000_000, total: 482_000_000 };

beforeEach(() => {
  useDictationStore.setState({
    insertTarget: null,
    enabled: true,
    status: "listening",
    phase: "passive",
    interim: "",
    error: null,
    modelProgress: null,
    outOfCreditsNotice: false,
  });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

const renderComposer = () => render(<Composer agentId="a1" active onSubmitPrompt={vi.fn()} />);
const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
/** The full visible text of the composer, native placeholder included — the overlay and the native
 *  placeholder are two renderings of the same slot, so assertions must cover both. */
const composerText = () => `${document.body.textContent ?? ""} ${textarea().placeholder}`;

describe("Composer — the voice model is still downloading (first run)", () => {
  it("does NOT invite the user to say the wake word while the model is downloading", () => {
    useDictationStore.setState({ modelProgress: DOWNLOADING });
    renderComposer();
    // THE bug: "Mic paused. Say Hey Sparkle to activate (or you can type here instead)."
    expect(composerText()).not.toContain("to activate");
    expect(composerText()).not.toMatch(new RegExp(`Say\\s+${WAKE_PHRASE}`));
  });

  it("says the voice model is being set up, with progress", () => {
    useDictationStore.setState({ modelProgress: DOWNLOADING });
    renderComposer();
    expect(composerText()).toMatch(/setting up voice/i);
    expect(composerText()).toContain("50%"); // 241/482
  });

  it("omits the percentage when the backend reports no total (no fake number)", () => {
    useDictationStore.setState({ modelProgress: { done: 5_000_000, total: null } });
    renderComposer();
    expect(composerText()).toMatch(/setting up voice/i);
    expect(composerText()).not.toContain("%");
  });

  it("still tells the user they can type meanwhile (the composer stays usable)", () => {
    useDictationStore.setState({ modelProgress: DOWNLOADING });
    renderComposer();
    // Specifically the preparing copy's tail — the old wake-word placeholder also contains the
    // words "type here", so a loose match here would pass against the very bug being fixed.
    expect(composerText()).toMatch(/type here meanwhile/i);
    expect(textarea().disabled).toBe(false);
  });

  it("never claims to be listening mid-download, even in the ACTIVE phase", () => {
    // Reachable: the user picks "Listening" from the mic pill while the download runs.
    useDictationStore.setState({ modelProgress: DOWNLOADING, phase: "active" });
    renderComposer();
    expect(composerText()).not.toContain("I'm listening");
  });

  // THE regression guard for the warm/founder install: model on disk → no progress events → the
  // composer must read exactly as it always has.
  it("WARM start (no download) shows the ordinary wake-word prompt, never a setting-up state", () => {
    useDictationStore.setState({ modelProgress: null });
    renderComposer();
    expect(composerText()).not.toMatch(/setting up voice/i);
    expect(composerText()).toContain(WAKE_PHRASE);
  });

  it("WARM + active phase still shows the mic-hot copy untouched", () => {
    useDictationStore.setState({ modelProgress: null, phase: "active" });
    renderComposer();
    expect(composerText()).toContain("I'm listening");
    expect(composerText()).not.toMatch(/setting up voice/i);
  });

  it("the download finishing hands back to the normal wake-word prompt", () => {
    useDictationStore.setState({ modelProgress: DOWNLOADING });
    const { rerender } = renderComposer();
    expect(composerText()).toMatch(/setting up voice/i);
    // dictation://level and ://partial null modelProgress the moment capture truly starts.
    useDictationStore.setState({ modelProgress: null });
    rerender(<Composer agentId="a1" active onSubmitPrompt={vi.fn()} />);
    expect(composerText()).not.toMatch(/setting up voice/i);
    expect(composerText()).toContain(WAKE_PHRASE);
  });
});

describe("Composer — voice errors surface where the user's mic is", () => {
  it("shows a download failure honestly instead of the old mic-permission sentence", () => {
    useDictationStore.setState({ error: "Dns Failed: resolve error", status: "error" });
    renderComposer();
    expect(composerText()).toMatch(/couldn't download the voice model/i);
    expect(composerText()).toMatch(/internet connection/i);
    // The old lie, in the old place, for a failure that has nothing to do with the microphone.
    expect(composerText()).not.toMatch(/Privacy/);
  });

  it("shows the Privacy remedy ONLY for a real permission failure", () => {
    useDictationStore.setState({ error: "microphone permission denied", status: "error" });
    renderComposer();
    expect(composerText()).toMatch(/can't use the microphone/i);
    expect(composerText()).toMatch(/Privacy/);
  });

  it("surfaces an unrecognized error's raw text rather than inventing a cause", () => {
    useDictationStore.setState({ error: "app_data_dir() failed: no home", status: "error" });
    renderComposer();
    expect(composerText()).toContain("app_data_dir() failed: no home");
  });

  it("is dismissible — clearing it returns the composer to its normal placeholder", () => {
    useDictationStore.setState({ error: "no input device available", status: "error" });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss voice error" }));
    expect(useDictationStore.getState().error).toBeNull();
  });

  it("the error outranks the download progress (a failed download isn't still downloading)", () => {
    useDictationStore.setState({
      error: "No space left on device (os error 28)",
      status: "error",
      modelProgress: DOWNLOADING,
    });
    renderComposer();
    expect(composerText()).toMatch(/disk space/i);
    expect(composerText()).not.toMatch(/setting up voice/i);
  });

  it("no error → no notice (the healthy case renders nothing extra)", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Dismiss voice error" })).toBeNull();
  });
});

// The TCC-denied mic (src-tauri/src/mic_permission.rs). Before that module the composer could not
// render anything here at all: CoreAudio hands a denied user a stream that "succeeds" and then
// delivers zeros forever, so there was no error to show — the mic just died in silence behind an
// amber ring and a "Say Hey Sparkle" invitation it could never hear.
describe("Composer — a denied microphone offers a way out, not just a diagnosis", () => {
  const DENIED = BACKEND_MIC_DENIED;

  // Installed/removed here, not inside the one test that needs it: restoring at the end of a test
  // body only runs if every assertion before it passed, so a single failure would leave
  // console.warn mocked for the rest of the file, swallowing warnings in unrelated tests
  // (roborev 37848). afterEach runs regardless.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("names the microphone as the cause and the Privacy pane as the remedy", () => {
    useDictationStore.setState({ error: DENIED, status: "error" });
    renderComposer();
    expect(composerText()).toMatch(/can't use the microphone/i);
    expect(composerText()).toMatch(/Privacy & Security/);
  });

  it("opens the Microphone privacy pane directly rather than making the user hunt for it", () => {
    useDictationStore.setState({ error: DENIED, status: "error" });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    // The `Privacy_Microphone` anchor is the difference between landing ON the microphone list and
    // landing at the top of Privacy & Security with the real work still to do.
    expect(openUrl).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
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
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      "voice: open microphone settings failed",
      expect.any(Error),
    );
    expect(composerText()).toMatch(/Privacy & Security/);
  });

  it("still lets the user dismiss it (the remedy is an addition, not a replacement)", () => {
    useDictationStore.setState({ error: DENIED, status: "error" });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss voice error" }));
    expect(useDictationStore.getState().error).toBeNull();
  });

  it("offers System Settings ONLY for permission — never for a failure it cannot fix", () => {
    // The misattribution guard, rendered. Sending a user whose wifi dropped (or whose disk is
    // full) into the Microphone pane wastes their time on a switch that is already on — the exact
    // failure this whole notice was built to stop.
    for (const raw of [
      "Dns Failed: resolve error",
      "No space left on device (os error 28)",
      "no input device available",
      "Permission denied (os error 13)", // a MODEL-DIR write failure, not the mic
    ]) {
      cleanup();
      useDictationStore.setState({ error: raw, status: "error" });
      renderComposer();
      expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
    }
  });
});
