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
// A STAND-IN THAT RENDERS ITS PROMPT, not a null mock — same reasoning as the Composer stand-in
// above. The pinned header is also gone from this pane (see below), and a `() => null` mock would
// make that absence assertion vacuous: it would pass just as well with the element still there.
vi.mock("./PinnedPrompt", () => ({
  PinnedPrompt: ({ prompt }: { prompt: string }) => <div data-testid="pane-pinned-prompt">{prompt}</div>,
}));
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

describe("SparkleAgentPane — the pinned header is gone (the founder said so)", () => {
  // Founder, 2026-07-30: the text goes, not a reword. Two assertions on purpose — the element, so
  // re-adding `<PinnedPrompt prompt="…">` fails (the stand-in renders), and the literal string, so
  // hand-inlining the same label as a plain <div> fails too. The pane's OWN identity strings in
  // services/sparkleAgent.ts (the persona, the self-introduction) are behaviour, not chrome, and are
  // deliberately untouched — SparkleAgentPane.spawn.test.tsx still guards those.
  it("renders no pinned prompt header, and no label of any kind naming the agent", async () => {
    await readyPane();

    expect(screen.queryByTestId("pane-pinned-prompt")).toBeNull();
    expect(screen.queryByText(/making Sparkle better from your usage/i)).toBeNull();
  });

  it("leaves the consent row as the pane's top chrome, with nothing above it", async () => {
    // The removal must close up, not leave a gap. PinnedPrompt carried its own padding and bottom
    // hairline, so the consent row inherits the top edge — assert it is literally the first child of
    // the pane rather than trusting that no spacer was left behind.
    await readyPane();

    const consent = screen.getByRole("region", { name: "Sparkle improvement consent" });
    const pane = consent.parentElement!;
    expect(pane.firstElementChild).toBe(consent);
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
