import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeDictationToTerminal, type TerminalSinkDeps } from "./dictationTerminalSink";
import { registerScrollback } from "./terminalScrollback";
import { registerViewport, resetViewportRegistry } from "./terminalViewport";
import { usePresenceStore } from "../stores/presenceStore";

const AGENT = "agent-1";

const IDLE_SCREEN = [
  "● Ran the suite — all green.",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
].join("\n");

/** Deliberately leaves `viewport` unset so the sink reads the REAL registry — that wiring is what
 *  the anti-deadlock case below exists to pin. */
function deps(over: Partial<TerminalSinkDeps> = {}): TerminalSinkDeps {
  return {
    focusedAgentId: () => AGENT,
    canAcceptInput: () => true,
    write: vi.fn(async () => {}),
    ...over,
  };
}

function mountTerminal(text: string, alternateBuffer = false) {
  registerViewport(AGENT, () => ({ text, alternateBuffer }));
}

beforeEach(() => {
  resetViewportRegistry();
});

describe("routeDictationToTerminal", () => {
  // ══ THE ANTI-DEADLOCK CASE ═══════════════════════════════════════════════════════════════════
  // The failure this whole viewport registry exists to prevent, and the one a reasonable
  // implementation walks straight into: `getAgentScrollback` is the registry that already existed,
  // it is right there, and it returns a plausible-looking screen. But it returns 300 lines of
  // HISTORY — so the FIRST approval prompt of the session stays in it forever, `screenAwaitsInput`
  // matches that stale `(y/n)`, and dictation is refused for the rest of the session.
  //
  // This test wires the two registries to DISAGREE: history says a prompt is up, the live screen
  // says it was answered long ago. Delivering proves the sink reads the screen. Swap the sink back
  // to `getAgentScrollback` and this goes red.
  it("delivers when the SCROLLBACK holds an old (y/n) but the live viewport is a clean prompt", async () => {
    registerScrollback(AGENT, () =>
      ["$ rm -rf build", "Overwrite the existing branch? (y/n)", "y", ...IDLE_SCREEN.split("\n")].join(
        "\n",
      ),
    );
    mountTerminal(IDLE_SCREEN);
    const d = deps();

    const out = await routeDictationToTerminal("run the tests again", d);

    expect(out).toEqual({ kind: "delivered", agentId: AGENT, text: "run the tests again" });
    expect(d.write).toHaveBeenCalledWith(AGENT, "run the tests again");
  });

  // ══ TYPE, DO NOT SUBMIT ══════════════════════════════════════════════════════════════════════
  it("never writes a carriage return, so the human still presses Enter", async () => {
    mountTerminal(IDLE_SCREEN);
    const write = vi.fn(async () => {});

    await routeDictationToTerminal("deploy to production\rand restart", deps({ write }));

    expect(write).toHaveBeenCalledTimes(1);
    const [, payload] = write.mock.calls[0] as unknown as [string, string];
    // Both halves matter: the submit byte is gone AND the text after it survived (rather than the
    // phrase being truncated at the newline, which would silently drop half of what was said).
    expect(payload).not.toMatch(/[\r\n]/);
    expect(payload).toBe("deploy to production and restart");
  });

  // ══ THE REFUSALS ═════════════════════════════════════════════════════════════════════════════
  it("refuses, and writes NOTHING, on the alternate screen buffer (vim/less/htop)", async () => {
    mountTerminal(IDLE_SCREEN, true);
    const write = vi.fn(async () => {});

    const out = await routeDictationToTerminal("delete the second paragraph", deps({ write }));

    expect(out).toEqual({ kind: "refused", agentId: AGENT, reason: "alternate-screen" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses, and writes NOTHING, when a live prompt is awaiting an answer", async () => {
    mountTerminal("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend");
    const write = vi.fn(async () => {});

    const out = await routeDictationToTerminal("yes go ahead", deps({ write }));

    expect(out).toEqual({ kind: "refused", agentId: AGENT, reason: "awaiting-input" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses when no terminal holds the caret, rather than picking an agent", async () => {
    mountTerminal(IDLE_SCREEN);
    const write = vi.fn(async () => {});

    const out = await routeDictationToTerminal("hello", deps({ focusedAgentId: () => null, write }));

    expect(out).toEqual({ kind: "refused", agentId: null, reason: "no-terminal" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses when the terminal is not mounted at all (fail closed, not fail quiet)", async () => {
    // No mountTerminal() — the registry has no provider for this agent.
    const write = vi.fn(async () => {});

    const out = await routeDictationToTerminal("hello", deps({ write }));

    expect(out).toEqual({ kind: "refused", agentId: AGENT, reason: "no-viewport" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a cloud agent, which has no local pty", async () => {
    mountTerminal(IDLE_SCREEN);
    const write = vi.fn(async () => {});

    const out = await routeDictationToTerminal(
      "hello",
      deps({ canAcceptInput: () => false, write }),
    );

    expect(out).toEqual({ kind: "refused", agentId: AGENT, reason: "not-writable" });
    expect(write).not.toHaveBeenCalled();
  });

  it("reports a dead pty as failed rather than swallowing it as delivered", async () => {
    mountTerminal(IDLE_SCREEN);
    const boom = new Error("pty gone");
    const out = await routeDictationToTerminal(
      "hello",
      deps({
        write: vi.fn(async () => {
          throw boom;
        }),
      }),
    );

    expect(out).toEqual({ kind: "failed", agentId: AGENT, error: boom });
  });

  // ══ PRESENCE ═════════════════════════════════════════════════════════════════════════════════
  // `noteInput` is fed only by xterm's `onData` (keystrokes), so a voice-only session looks idle and
  // trips IDLE_AWAY_MS mid-conversation. Assert the SIDE EFFECT on the store, not that a spy was
  // called — the store is what the idle timer actually reads.
  it("counts a delivered phrase as user input, so a voice-only session never goes Away", async () => {
    mountTerminal(IDLE_SCREEN);
    usePresenceStore.setState({ lastInputAt: 0 });

    await routeDictationToTerminal("keep going", deps());

    expect(usePresenceStore.getState().lastInputAt).toBeGreaterThan(0);
  });

  it("does NOT count a refused phrase as input — nothing reached the agent", async () => {
    mountTerminal(IDLE_SCREEN, true); // alt buffer → refused
    usePresenceStore.setState({ lastInputAt: 0 });

    await routeDictationToTerminal("keep going", deps());

    expect(usePresenceStore.getState().lastInputAt).toBe(0);
  });
});
