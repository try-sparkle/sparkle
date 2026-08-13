// @vitest-environment jsdom
//
// IMPROVE SPARKLE HAS NO *BESPOKE* COMPOSER — it has a plain input row, and it still has its
// consent row.
//
// ── THE DECISION THIS FILE PINS, IN TWO PARTS ───────────────────────────────────────────────────
//
// Founder, 2026-07-29, on two screenshots of this pane:
//   • "the improved Sparkle agent has some old composer window functionality that should be stripped
//     out so that it works like other build agents do" — the BOTTOM row: the mic, the "I'm listening"
//     placeholder, the screenshot button, Send.
//   • "I don't want you to strip out the top functionality here… Just this bottom composer
//     functionality." — the TOP row: "Can we use your logs & crash reports to automatically improve
//     Sparkle?" with Always / Case by case / Never.
//
// Founder, 2026-08-12 (dictated), superseding the FIRST half of that and only the first half:
//   • "There's a problem where the improved sparkle agent doesn't have a row to type into."
// Said while this agent sat BLOCKED ON HIM — it had shipped a release and was asking him a direct
// question, and he had no visible way to answer it. His decided fix, same dictation: typed text goes
// STRAIGHT INTO ITS PTY, the same path a build agent's prompt takes, NOT through the concierge relay.
//
// THIS FILE USED TO SAY "no compose surface of any kind", AND THAT IS WHY THE BUG LASTED. The July
// instruction was about the BESPOKE composer — it ends "so that it works like other build agents
// do", i.e. stop being special, not stop having input. Reading it as "no input" is what produced an
// agent nobody could answer, and the assertion recording that reading is exactly the kind of
// superseded-decision LOCK this repo has already paid for twice (AGENTS.md; the header of
// Concierge/MountedAgentThread.tsx). So the absence assertions are now scoped to the AFFORDANCES he
// pointed at rather than to "a textbox exists", and the row that replaced them is asserted here for
// presence and, in SparkleAgentPane.inputRow.test.tsx, for actual DELIVERY to `__sparkle_self__`'s
// PTY — because "the box is on screen" is a precondition and proves nothing about where text goes.
//
// So this file is a set of opposed guards on ONE pane: the bespoke compose surface must be gone, the
// plain input row must be there, and the consent surface must NOT be gone. Any one of them alone
// would be satisfied by deleting the whole pane.
//
// WHY THE COMPOSER IS MOCKED AS A STAND-IN RATHER THAN OMITTED. The absence assertions have to be
// about "the old composer, however it comes back", not about one import path — otherwise re-adding
// the row by inlining it would sail past. So `./Composer` is replaced by a stand-in rendering the
// affordances the founder actually pointed at, matching the real component's own markup:
//   the screenshot button titled "Capture a region of your screen" (Composer.tsx ~1806), the mic's
//   "I'm listening" placeholder, and a <textarea> (~1628).
// Every assertion below therefore FAILS if `<Composer>` comes back (the stand-in renders) AND fails
// if an equivalent box is hand-rolled in the pane (the title/placeholder appear either way).
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
// The stand-in for the OLD BESPOKE compose surface. See the header. It renders the affordances the
// founder pointed at on 2026-07-29 — the mic placeholder and the screenshot button — plus its own
// textarea, so a returning composer is caught by three independent tells rather than by the fact
// that a textbox exists (which is now true by design).
vi.mock("./Composer", () => ({
  Composer: () => (
    <div data-testid="pane-composer">
      <textarea aria-label="Message the Sparkle agent" placeholder="I'm listening…" />
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
import {
  SPARKLE_INPUT_LABEL,
  SPARKLE_INPUT_PLACEHOLDER,
  SPARKLE_INPUT_ROW_LABEL,
} from "./SparkleAgentInputRow";
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

describe("SparkleAgentPane — the OLD bespoke composer is gone", () => {
  it("renders none of the affordances the founder pointed at", async () => {
    await readyPane();
    // The import path…
    expect(screen.queryByTestId("pane-composer")).toBeNull();
    // …and the affordances, so an inlined replacement is caught too. NOT "no textbox exists" any
    // more — see the header: that assertion recorded a reading of the July instruction the founder
    // has since corrected, and it is what kept this agent unanswerable.
    expect(screen.queryByTitle("Capture a region of your screen")).toBeNull();
    expect(screen.queryByPlaceholderText(/i'm listening/i)).toBeNull();
  });

  it("has EXACTLY ONE text box, and it is the new input row's", async () => {
    // This is the discriminating half: the old composer coming back alongside the row would show up
    // as a second textbox even if every title/placeholder above were reworded. One box, and it is
    // the one whose text goes to the PTY (SparkleAgentPane.inputRow.test.tsx pins where it goes).
    await readyPane();

    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.getAttribute("aria-label")).toBe(SPARKLE_INPUT_LABEL);
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

  // ── THE TERMINAL IS STILL AN INPUT SURFACE TOO ──────────────────────────────────────────────
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

describe("SparkleAgentPane — but there IS a row to type into (the founder said so, 2026-08-12)", () => {
  it("renders the input row, with a plain placeholder and a Send button", async () => {
    await readyPane();

    expect(screen.getByRole("region", { name: SPARKLE_INPUT_ROW_LABEL })).toBeTruthy();
    const box = screen.getByLabelText(SPARKLE_INPUT_LABEL);
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("placeholder")).toBe(SPARKLE_INPUT_PLACEHOLDER);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("puts the row BELOW the terminal rather than over it", async () => {
    // Not cosmetics: a box floating over the terminal is what `composerOverlay` describes, and the
    // case above asserts that prop stays false. A sibling row keeps that true and keeps the
    // terminal's own drag region (SparkleAgentPane.drop.test.tsx) the pane's only drop surface.
    await readyPane();

    const row = screen.getByRole("region", { name: SPARKLE_INPUT_ROW_LABEL });
    const terminalBox = document.querySelector("[data-dnd-target]")!;
    expect(terminalBox.contains(row)).toBe(false);
    expect(
      row.compareDocumentPosition(terminalBox) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  // WHERE THE TEXT GOES is the assertion that actually matters, and it is NOT here: see
  // SparkleAgentPane.inputRow.test.tsx, which drives this row and asserts the `pty_write` payload
  // reaching `__sparkle_self__`. Everything in this describe is a precondition for that.
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
