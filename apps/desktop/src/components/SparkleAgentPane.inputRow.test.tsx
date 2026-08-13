// @vitest-environment jsdom
//
// TYPING INTO IMPROVE SPARKLE'S ROW REACHES `__sparkle_self__`'s PTY.
//
// Founder, 2026-08-12 (dictated): "There's a problem where the improved sparkle agent doesn't have a
// row to type into." The agent was sitting BLOCKED ON HIM — it had shipped a release and was asking
// him a direct question — with no visible way to answer. His decided fix: typed text goes STRAIGHT
// INTO ITS PTY, not through the concierge relay.
//
// SO THE ASSERTIONS HERE ARE ON THE `pty_write` PAYLOAD, for that agent id. "A textarea rendered" and
// "a submit handler was bound" would both have been true of a row that delivered nowhere, and this
// pane already has a documented instance of exactly that shape (a composer whose drop handler read
// the file and dropped it on the floor — see SparkleAgentPane.drop.test.tsx). `../pty` is therefore
// DELIBERATELY NOT MOCKED: the real `submitPrompt` is what frames the bracketed paste, waits, and
// sends the carriage return, and the Tauri bridge underneath it is the last observable point before
// the bytes leave the webview.
//
// Terminal is mocked because mounting the real one drags in xterm and a second PTY.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  terminal: [] as Array<{ onReady?: () => void }>,
  /** Every Tauri command this pane issued, in order. The PTY writes are read out of here. */
  invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  /** When set, `pty_write` rejects with this message instead of resolving. */
  writeError: { message: null as string | null },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    captured.invokes.push({ cmd, args: args ?? {} });
    if (cmd === "pty_write" && captured.writeError.message) {
      return Promise.reject(new Error(captured.writeError.message));
    }
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => new Promise<() => void>(() => {}),
  }),
}));
vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return {
    ...real,
    Terminal: (props: { onReady?: () => void }) => {
      captured.terminal.push(props);
      return null;
    },
  };
});
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
vi.mock("../services/sparkleTranscript", () => ({ registerSparkleTranscript: vi.fn() }));
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
    checkSubmitCapability: vi.fn(() => Promise.resolve({ verdict: "canSubmit", repo: "o/r" })),
  };
});

import { SparkleAgentPane } from "./SparkleAgentPane";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import { SPARKLE_INPUT_LABEL, SPARKLE_INPUT_PTY_GONE } from "./SparkleAgentInputRow";

/** The PTY writes this pane made, in order, for one agent id. */
function writesTo(id: string): string[] {
  return captured.invokes
    .filter((c) => c.cmd === "pty_write" && c.args.id === id)
    .map((c) => String(c.args.data));
}

beforeEach(() => {
  captured.terminal.length = 0;
  captured.invokes.length = 0;
  captured.writeError.message = null;
});
afterEach(() => cleanup());

/** Render the pane, wait for `ready`, and let the mocked terminal report its PTY up. */
async function readyPane({ ptyUp = true }: { ptyUp?: boolean } = {}) {
  render(<SparkleAgentPane visible agentId={SPARKLE_AGENT_ID} />);
  await waitFor(() => expect(captured.terminal.length).toBeGreaterThan(0));
  if (ptyUp) {
    await act(async () => {
      captured.terminal[captured.terminal.length - 1]!.onReady?.();
    });
  }
  return screen.getByLabelText(SPARKLE_INPUT_LABEL) as HTMLTextAreaElement;
}

describe("SparkleAgentPane — the input row delivers to __sparkle_self__'s PTY", () => {
  it("writes the typed text, then a carriage return, to THIS agent's pty (Enter)", async () => {
    const box = await readyPane();

    fireEvent.change(box, { target: { value: "done" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // The paste lands first…
    await waitFor(() => {
      expect(writesTo(SPARKLE_AGENT_ID).some((d) => d.includes("done"))).toBe(true);
    });
    // …and then, after submitPrompt's paste→CR beat, the Enter that actually sends it. Without the
    // second write the text sits unsent on the CLI's input line, which is the founder's complaint
    // one step further along, so both halves are asserted.
    await waitFor(() => {
      expect(writesTo(SPARKLE_AGENT_ID)).toContain("\r");
    });
    // The whole delivery went to the app-owned id — nothing was addressed to any other agent.
    expect(captured.invokes.filter((c) => c.cmd === "pty_write").every((c) => c.args.id === SPARKLE_AGENT_ID)).toBe(true);
    // …and the box is cleared once it landed, so the next question starts empty.
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("does the same from the Send button", async () => {
    const box = await readyPane();

    fireEvent.change(box, { target: { value: "6 relogins finished" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(writesTo(SPARKLE_AGENT_ID).some((d) => d.includes("6 relogins finished"))).toBe(true);
    });
    await waitFor(() => expect(writesTo(SPARKLE_AGENT_ID)).toContain("\r"));
  });

  it("Shift+Enter does not send — it is a newline, like every other compose surface", async () => {
    const box = await readyPane();

    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    await new Promise((r) => setTimeout(r, 120));
    expect(writesTo(SPARKLE_AGENT_ID)).toEqual([]);
    expect(box.value).toBe("line one");
  });

  it("sends nothing while the PTY is still coming up, and keeps what was typed", async () => {
    // `submitPrompt` is strict about a dead PTY for a reason; there is no process to write to yet,
    // and a write that silently went nowhere is the failure mode this pane has already paid for.
    const box = await readyPane({ ptyUp: false });

    fireEvent.change(box, { target: { value: "too early" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 120));
    expect(writesTo(SPARKLE_AGENT_ID)).toEqual([]);
    expect(box.value).toBe("too early");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a dead PTY is REPORTED, and the user's words are kept rather than swallowed", async () => {
    const box = await readyPane();
    captured.writeError.message = "no such pty";

    fireEvent.change(box, { target: { value: "answer he cannot afford to retype" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(screen.getByText(SPARKLE_INPUT_PTY_GONE)).toBeTruthy());
    expect(box.value).toBe("answer he cannot afford to retype");
  });

  it("an empty or whitespace-only box sends nothing", async () => {
    const box = await readyPane();

    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 120));
    expect(writesTo(SPARKLE_AGENT_ID)).toEqual([]);
  });
});
