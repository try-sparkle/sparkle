// @vitest-environment jsdom
//
// WHICH FOCUS REQUEST RE-AIMS THE MICROPHONE.
//
// The pane hands Terminal two ways to ask for the caret, and the whole point is that they are not
// interchangeable:
//
//   onRequestFocus      the reveal effect — pane shown, agent changed, layout re-fit. The APP.
//   onUserRequestFocus  the ⌘J composer chord. The USER naming the box they want.
//
// Only the second may move dictationStore.voiceSurface. Getting it backwards is a shipped bug in
// either direction: revealing a pane silently steals the mic from the Sparkle box, or a keyboard
// user chords into a composer and their words keep landing in the other column. Both have happened
// on this branch (roborev 54245 / 54252 / 54259), which is why the wiring is pinned here and not
// only at the service seam — the service cannot tell you which callback a call site was given.
//
// Terminal's COMPONENT is mocked (mounting the real one drags in xterm and a PTY), but its
// `composerFocusRequest` action map is kept real — that map is how Terminal's two call sites reach
// these callbacks, so running the assertions through it pins the wiring on both sides of the prop.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  props: [] as Array<{ onRequestFocus?: () => void; onUserRequestFocus?: () => void }>,
}));

vi.mock("./Terminal", async (importOriginal) => {
  // Keep the REAL composerFocusRequest — it is what the assertions run through — and stub only the
  // component, which would otherwise drag in xterm and a PTY.
  const real = await importOriginal<typeof import("./Terminal")>();
  return {
    ...real,
    Terminal: (props: { onRequestFocus?: () => void; onUserRequestFocus?: () => void }) => {
      captured.props.push(props);
      return null;
    },
  };
});
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
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
// NOT from the mock: the action map is a module-level export, and it is the thing under test.
import { composerFocusRequest } from "./Terminal";

beforeEach(() => {
  captured.props.length = 0;
  useDictationStore.setState({ voiceSurface: "concierge" });
});
afterEach(() => cleanup());

/** Render the pane and return the focus callbacks it handed Terminal. */
async function focusHooks() {
  render(<SparkleAgentPane visible agentId="__sparkle_self__" />);
  await waitFor(() => expect(captured.props.length).toBeGreaterThan(0));
  return captured.props[captured.props.length - 1]!;
}

describe("SparkleAgentPane — which focus request re-aims the mic", () => {
  it("the ⌘J chord's request names this composer as the voice surface", async () => {
    const { onUserRequestFocus } = await focusHooks();
    expect(onUserRequestFocus).toBeTypeOf("function");

    onUserRequestFocus!();

    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });

  it("the reveal request does NOT — nobody asked for it", async () => {
    // The regression that shipped twice on this branch. A pane becoming visible is not a statement
    // about where the user wants to talk.
    const { onRequestFocus } = await focusHooks();
    expect(onRequestFocus).toBeTypeOf("function");

    onRequestFocus!();

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("Terminal's CHORD call site reaches the user callback; its REVEAL call site does not", async () => {
    // The half the pane cannot answer for itself, and the one that regressed three times: the pane
    // can hand over two perfectly good callbacks and Terminal still call the wrong one. Asserting
    // the two props are different objects proved nothing — they are inline arrows, so that held
    // unconditionally, even if both bodies were the reveal's quiet focus. Compare EFFECTS, through
    // the same action map Terminal actually routes its two call sites through.
    const handlers = await focusHooks();

    composerFocusRequest.reveal(handlers);
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");

    composerFocusRequest.chord(handlers);
    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });
});
