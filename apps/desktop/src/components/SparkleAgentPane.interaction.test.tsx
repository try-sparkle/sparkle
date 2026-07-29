// @vitest-environment jsdom
//
// A COMPOSER SEND COUNTS AS AN INTERACTION — and for THIS pane, only because it says so.
//
// The sidebar's elapsed timer reads `max(promptHistory.at, interactionStore.lastAt[id])`. A project
// agent's Send lands in its tab's `promptHistory`, so the timer resets for free. Improve Sparkle has
// no AgentTab and therefore no promptHistory, so the ONLY thing that can reset its timer is an
// explicit `interactionStore.touch()` — without one the counter climbs while the user is actively
// prompting the agent from the box directly below it.
//
// That call had no test when it was added (roborev 54812): neither SparkleAgentPane suite exercises
// `onSubmitPrompt`, and the sidebar suite seeds interactionStore directly rather than driving it
// through the pane. Deleting the call — or passing the wrong id — left the whole suite green while
// the reported bug came back. It is also the one link in this row's "one pipeline" chain that no
// comparative assertion covers, which is why the id is asserted against the same helper the row
// reads with, not against a literal.
//
// Terminal and Composer are both mocked: mounting the real Terminal drags in xterm and a PTY, and
// the Composer's own submit path is not what's under test — the PANE's handler is.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  composer: [] as Array<{ agentId?: string; onSubmitPrompt?: (t: string) => void }>,
}));

vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return { ...real, Terminal: () => null };
});
vi.mock("./Composer", () => ({
  Composer: (props: { agentId?: string; onSubmitPrompt?: (t: string) => void }) => {
    captured.composer.push(props);
    return null;
  },
}));
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
import { useInteractionStore } from "../stores/interactionStore";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { APP_WINDOW_LABEL } from "../windowContext";

/** The id the sidebar row actually reads its timer from. Derived, not spelled — the point of the
 *  assertion is that the pane writes the key the row looks up. */
const SPARKLE_ID = sparkleAgentIdFor(APP_WINDOW_LABEL);

beforeEach(() => {
  captured.composer.length = 0;
  useInteractionStore.setState({ lastAt: {} } as never);
});
afterEach(() => cleanup());

/** Render the pane and return the props it handed the Composer. */
async function composerProps() {
  render(<SparkleAgentPane visible agentId={SPARKLE_ID} />);
  await waitFor(() => expect(captured.composer.length).toBeGreaterThan(0));
  return captured.composer[captured.composer.length - 1]!;
}

describe("SparkleAgentPane — a composer Send records an interaction", () => {
  it("writes nothing before a Send, so an untouched row shows no timer", async () => {
    await composerProps();
    expect(useInteractionStore.getState().lastAt[SPARKLE_ID]).toBeUndefined();
  });

  it("records the interaction on submit", async () => {
    const { onSubmitPrompt } = await composerProps();
    expect(onSubmitPrompt).toBeTypeOf("function");

    onSubmitPrompt!("review the changelog");

    expect(useInteractionStore.getState().lastAt[SPARKLE_ID]).toBeTypeOf("number");
  });

  // The half a "was it called" assertion misses: `touch(someOtherId)` would still write to the
  // store and still look like a pass. The row reads exactly ONE key, so that is the one to check.
  it("records it under the id the sidebar row reads, not some other key", async () => {
    const { onSubmitPrompt } = await composerProps();
    onSubmitPrompt!("review the changelog");

    expect(Object.keys(useInteractionStore.getState().lastAt)).toEqual([SPARKLE_ID]);
  });

  // The pane is handed its window's id; it must touch THAT, not the canonical constant. Today the
  // main window's id is the canonical one, so this only bites a secondary window — which is exactly
  // the case nobody would notice by hand.
  it("touches the agentId it was given, not a hardcoded one", async () => {
    cleanup();
    captured.composer.length = 0;
    render(<SparkleAgentPane visible agentId="__sparkle_self__-win-abc" />);
    await waitFor(() => expect(captured.composer.length).toBeGreaterThan(0));

    captured.composer[captured.composer.length - 1]!.onSubmitPrompt!("hello");

    expect(Object.keys(useInteractionStore.getState().lastAt)).toEqual([
      "__sparkle_self__-win-abc",
    ]);
  });
});
