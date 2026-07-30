// @vitest-environment jsdom
//
// IMPROVE SPARKLE HAS NO COMPOSER OF ITS OWN — and still has its consent row.
//
// Founder, 2026-07-29, on two screenshots of this pane:
//   • "the improved Sparkle agent has some old composer window functionality that should be stripped
//     out so that it works like other build agents do" — the BOTTOM row: the mic, the "I'm listening"
//     placeholder, the screenshot button, Send.
//   • "I don't want you to strip out the top functionality here… Just this bottom composer
//     functionality." — the TOP row: "Can we use your logs & crash reports to automatically improve
//     Sparkle?" with Always / Case by case / Never.
//
// So this file is a pair of opposed guards on ONE pane: the compose surface must be gone, and the
// consent surface must NOT be. Half of it would be satisfied by deleting the whole pane.
//
// WHY THE COMPOSER IS MOCKED AS A STAND-IN RATHER THAN OMITTED. The absence assertions have to be
// about "a composer of any kind", not about one import path — otherwise re-adding the row by
// inlining a textarea would sail past. So `./Composer` is replaced by a stand-in rendering the three
// affordances the founder actually pointed at, matching the real component's own markup:
//   a <textarea> (Composer.tsx ~1628), the screenshot button titled "Capture a region of your
//   screen" (~1806), and a <button>Send</button> (~1829).
// Every assertion below therefore FAILS if `<Composer>` comes back (the stand-in renders) AND fails
// if an equivalent box is hand-rolled in the pane (the roles/title appear either way).
//
// Terminal is mocked because mounting the real one drags in xterm and a PTY — but its REAL
// `composerFocusRequest` action map is kept, because the ⌘J case below has to route through the same
// map Terminal routes its own call sites through.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  terminal: [] as Array<{
    composerOverlay?: boolean;
    onRequestFocus?: () => void;
    onUserRequestFocus?: () => void;
    onReady?: () => void;
    focusRef?: { current: (() => void) | null };
  }>,
  focusCalls: { n: 0 },
}));

vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return {
    ...real,
    Terminal: (props: {
      composerOverlay?: boolean;
      focusRef?: { current: (() => void) | null };
      onReady?: () => void;
    }) => {
      captured.terminal.push(props);
      // The real Terminal publishes its focus lever through this ref; the pane's reveal effect calls
      // it. Standing in for that is what makes "the terminal takes the caret" observable here.
      if (props.focusRef) props.focusRef.current = () => (captured.focusCalls.n += 1);
      return null;
    },
  };
});
// The stand-in for ANY per-pane compose surface. See the header.
vi.mock("./Composer", () => ({
  Composer: () => (
    <div data-testid="pane-composer">
      <textarea aria-label="Message the Sparkle agent" />
      <button data-hint="screenshot" title="Capture a region of your screen">
        Screenshot
      </button>
      <button>Send</button>
    </div>
  ),
}));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
// SparkleConsentBanner is deliberately NOT mocked — it is the thing being guarded.
vi.mock("../services/worktree", () => ({
  createAgentWorktree: vi.fn(() =>
    Promise.resolve({ path: "/wt/sparkle-self", branch: "sparkle/agent-self" }),
  ),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
  // registerSparkleTranscript reaches for this; stubbed so the pane's fire-and-forget transcript
  // registration doesn't log a mock-shape error on every case.
  claudeLatestSessionPath: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../services/sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() =>
      Promise.resolve({
        repoPath: "/app-data/",
        logDir: "/app-data/logs/sparkle",
        defaultBranch: "main",
      }),
    ),
  };
});

import { SparkleAgentPane } from "./SparkleAgentPane";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";
// NOT from the mock: the action map is a module-level export and it is what Terminal routes through.
import { composerFocusRequest } from "./Terminal";

const SPARKLE_ID = "__sparkle_self__";

beforeEach(() => {
  captured.terminal.length = 0;
  captured.focusCalls.n = 0;
  useDictationStore.setState({ voiceSurface: "concierge" });
  useSettingsStore.setState({ sparkleImprovementConsent: "case_by_case" } as never);
});
afterEach(() => cleanup());

/**
 * Render the pane, wait until it reaches `ready` (the phase that used to hold the composer), and let
 * the terminal report its PTY up — which is the transition the caret-handoff effect keys on.
 */
async function readyPane() {
  render(<SparkleAgentPane visible agentId={SPARKLE_ID} />);
  await waitFor(() => expect(captured.terminal.length).toBeGreaterThan(0));
  const last = () => captured.terminal[captured.terminal.length - 1]!;
  await act(async () => {
    last().onReady?.();
  });
  return last();
}

describe("SparkleAgentPane — the bottom composer is gone", () => {
  it("renders no compose surface at all", async () => {
    await readyPane();
    // The import path…
    expect(screen.queryByTestId("pane-composer")).toBeNull();
    // …and the affordances, so an inlined replacement is caught too.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByTitle("Capture a region of your screen")).toBeNull();
  });

  it("does not ask the terminal to yield its mouse mode to an overlaying composer", async () => {
    // `composerOverlay` is not decoration: terminalSelectionReclaim reads it to turn a plain drag
    // over a mouse-tracking TUI into a text selection, which is only the right call when a composer
    // is floating over the terminal (roborev 46485-M). This pane was that prop's last consumer, so
    // leaving it set would keep re-interpreting drags for a box that no longer exists.
    const props = await readyPane();
    expect(props.composerOverlay ?? false).toBe(false);
  });

  it("hands Terminal no composer-focus callbacks", async () => {
    const props = await readyPane();
    expect(props.onRequestFocus).toBeUndefined();
    expect(props.onUserRequestFocus).toBeUndefined();
  });

  // ── THE DICTATION CONTRACT SURVIVES THE REMOVAL ─────────────────────────────────────────────
  //
  // The old pane's ⌘J handler said `setVoiceSurface("agent")` — correct while it owned a box the
  // user could be chording INTO, and wrong the moment that box went: it would point the microphone
  // at a pane with nowhere to put a transcript. Asserting the props are undefined (above) is a
  // statement about the pane; this is the statement about the OUTCOME, driven through the same
  // action map Terminal uses, which is the half the props cannot answer for.
  it("neither focus request can re-aim the microphone at this pane any more", async () => {
    const props = await readyPane();

    composerFocusRequest.reveal(props);
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");

    composerFocusRequest.chord(props);
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  // ── WHAT REPLACED THE COMPOSER AS THIS PANE'S INPUT SURFACE ─────────────────────────────────
  it("gives the caret to the terminal once the pane is visible and ready", async () => {
    await readyPane();
    await waitFor(() => expect(captured.focusCalls.n).toBeGreaterThan(0));
  });

  it("but never out from under a half-typed message elsewhere", async () => {
    // The concierge box is the one compose surface now, so an agent finishing its start-up must not
    // steal the caret mid-sentence. Guarded on UNSENT TEXT, not on mere focus (engine/focusGuard).
    const box = document.createElement("textarea");
    box.value = "half a sentence to the other column";
    document.body.appendChild(box);
    box.focus();

    await readyPane();
    // Give the reveal effect's rAF the same room the passing case above gets.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(captured.focusCalls.n).toBe(0);
    box.remove();
  });
});

describe("SparkleAgentPane — the consent row STAYS (the founder said so)", () => {
  it("still asks the question, with the three-way control", async () => {
    await readyPane();

    expect(screen.getByRole("region", { name: "Sparkle improvement consent" })).toBeTruthy();
    expect(
      screen.getByText("Can we use your logs & crash reports to automatically improve Sparkle?"),
    ).toBeTruthy();
    for (const label of ["Always", "Case by case", "Never"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("still reflects — and can change — the stored consent mode", async () => {
    // Present-but-inert would satisfy a bare "is it in the DOM" check. The segmented control's whole
    // job is to carry the user's answer, so assert the pressed state tracks the store.
    await readyPane();

    expect(screen.getByRole("button", { name: "Case by case" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Never" }).getAttribute("aria-pressed")).toBe("false");

    act(() => {
      useSettingsStore.setState({ sparkleImprovementConsent: "never" } as never);
    });

    expect(screen.getByRole("button", { name: "Never" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Case by case" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
