// @vitest-environment jsdom
//
// A STOPPED TERMINAL MUST SAY SO, AND MUST NOT SWALLOW WHAT YOU TYPE (bead sparkle-l2xgf).
//
// The founder typed into agent ea0662ec-… and nothing happened. Its PTY was dead, but the pane was
// still painting the last frame of the session — the CLI's prompt chevron and its block cursor
// included — so it was indistinguishable from a terminal waiting for input. Every keystroke went to
// `pty_write`, which errored "no such pty"; both `writePty` and `LocalTransport.write` substring-
// match that error and discard it, so the input vanished with nothing logged and nothing shown.
//
// The old `Terminal.tsx` set its retryable state only when the PTY died having emitted NOTHING
// (`if (!gotOutputRef.current) setSpawnFail("exited")`). An agent that ran, printed thousands of
// lines and then exited took the do-nothing branch — the overwhelmingly common case.
//
// WHY A RUNTIME TEST AND NOT JUST terminalOverlay.test.ts. The resolver is pure and easy to pin, and
// pinning it alone proves nothing about the app: delete `setPtyStopped(true)` from the exit handler
// and every resolver test stays green while the founder's bug is fully restored. That is the
// untested-production-call-site shape AGENTS.md names. These tests drive the real component through
// the real PTY-exit event and assert the rendered side effect.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";

const { fit, ptyHandlers, writes, onDataHandler, spawnCalls } = vi.hoisted(() => ({
  fit: vi.fn(),
  writes: [] as string[],
  spawnCalls: [] as unknown[],
  // The handlers Terminal registers with the PTY layer, captured so a test can fire them.
  ptyHandlers: {
    exit: undefined as undefined | (() => void),
    output: undefined as undefined | ((chunk: string) => void),
  },
  // xterm's onData callback — this is the keystroke path under test.
  onDataHandler: { current: undefined as undefined | ((d: string) => void) },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = { fontSize: 12 };
    buffer = { active: { type: "normal", length: 0, getLine: () => undefined } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      // 720px at fontSize 12 => an implied cell of 9px for 80 cols (0.75em). Plausible, so the
      // width guard stays out of the way of the tests in THIS file.
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      parent.appendChild(el);
      this.element = el;
    }
    onData(cb: (d: string) => void): void {
      onDataHandler.current = cb;
    }
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    refresh(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(_d: string, cb?: () => void): void {
      cb?.();
    }
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void { fit(); } } }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_h: unknown) {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

vi.mock("../pty", () => ({
  spawnPty: vi.fn((opts: unknown) => {
    spawnCalls.push(opts);
    return Promise.resolve(spawnCalls.length);
  }),
  // The sink the bug hid in. Recording every write is what lets us prove the replay happened AND
  // that nothing was written while the PTY was dead.
  writePty: vi.fn((_id: string, data: string) => {
    writes.push(data);
    return Promise.resolve();
  }),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
  // LocalTransport.ack calls this on every parsed chunk (PTY read backpressure). Omitting it makes
  // vitest throw from the flow-control batcher, not from anything under test.
  ptyAck: vi.fn(() => Promise.resolve()),
  onPtyOutput: vi.fn((_id: string, cb: (e: { chunk: string; bytes: number }) => void) => {
    ptyHandlers.output = (chunk: string) => cb({ chunk, bytes: chunk.length });
    return Promise.resolve(() => {});
  }),
  // NOTE the payload key is `id`, not `agentId` — agentTransport.onExit filters on `e.id`, so a
  // mock with the wrong key never invokes the handler and every test here would pass vacuously.
  onPtyExit: vi.fn((cb: (e: { id: string; epoch: number }) => void) => {
    ptyHandlers.exit = () => cb({ id: "agent-1", epoch: 1 });
    return Promise.resolve(() => {});
  }),
  ignorePtyGone: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../engine/statusEngine", () => ({
  StatusEngine: class {
    constructor(_opts: unknown) {}
    ingest(): void {}
    exit(): void {}
    dispose(): void {}
  },
}));
vi.mock("../theme/theme", () => ({ useResolvedTheme: () => "dark" }));

import { Terminal } from "./Terminal";
import { REPLAY_SETTLE_MS } from "./Terminal";

const baseProps = {
  agentId: "agent-1",
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  active: true,
  onStatus: () => {},
};

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Drive the pane into the founder's exact state: it ran, it printed, then it died. */
const ranThenDied = async () => {
  render(<Terminal {...baseProps} />);
  await flush();
  await act(async () => {
    ptyHandlers.output?.("a long session of real output\r\n");
    await flush();
  });
  await act(async () => {
    ptyHandlers.exit?.();
    await flush();
  });
};

beforeEach(() => {
  fit.mockClear();
  writes.length = 0;
  spawnCalls.length = 0;
  ptyHandlers.exit = undefined;
  ptyHandlers.output = undefined;
  onDataHandler.current = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Terminal — a PTY that ran and then exited", () => {
  it("REGRESSION: shows a stopped footer with a restart, where it used to show nothing", async () => {
    await ranThenDied();
    // Delete `setPtyStopped(true)` from the exit handler and this is the founder's bug, exactly.
    const footer = screen.getByTestId("terminal-stopped-footer");
    expect(footer.textContent).toContain("Terminal stopped");
    expect(footer.textContent).toContain("Restart");
  });

  it("does not show it while the process is alive and streaming", async () => {
    // The positive anchor for the negative assertion below it: without this, a footer that NEVER
    // rendered (a broken mock, a component that threw) would pass the "not present" test too.
    render(<Terminal {...baseProps} />);
    await flush();
    await act(async () => {
      ptyHandlers.output?.("still working\r\n");
      await flush();
    });
    expect(screen.queryByTestId("terminal-stopped-footer")).toBeNull();
  });

  it("clears the footer once the restarted child speaks", async () => {
    await ranThenDied();
    expect(screen.queryByTestId("terminal-stopped-footer")).not.toBeNull();
    await act(async () => {
      ptyHandlers.output?.("hello again\r\n");
      await flush();
    });
    // A live child must not keep wearing its own death notice — the sparkle-heb11 shape.
    expect(screen.queryByTestId("terminal-stopped-footer")).toBeNull();
  });
});

describe("Terminal — typing into a stopped terminal", () => {
  it("REGRESSION: restarts the PTY instead of silently swallowing the keystroke", async () => {
    await ranThenDied();
    const spawnsBefore = spawnCalls.length;
    await act(async () => {
      onDataHandler.current?.("h");
      await flush();
    });
    // Before the fix this wrote to a dead PTY and pty_write's "no such pty" error was discarded
    // by two separate substring matches, so the count stayed put and nothing else happened.
    expect(spawnCalls.length).toBe(spawnsBefore + 1);
  });

  it("writes NOTHING to the dead PTY — the keystroke is held, not sent into the sink", async () => {
    await ranThenDied();
    writes.length = 0;
    await act(async () => {
      onDataHandler.current?.("h");
      await flush();
    });
    expect(writes).toEqual([]);
  });

  it("replays the held keystrokes once the restarted child has spoken and gone quiet", async () => {
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    await flush();
    await act(async () => {
      ptyHandlers.output?.("first life\r\n");
      await flush();
    });
    await act(async () => {
      ptyHandlers.exit?.();
      await flush();
    });
    // Type a whole line, one onData call per keystroke — the buffer must accumulate, not overwrite.
    await act(async () => {
      for (const ch of ["h", "i", "\r"]) onDataHandler.current?.(ch);
      await flush();
    });
    writes.length = 0;
    // The new child speaks. THE REPLAY MUST NOT FIRE YET: `pty_spawn` returning means the child was
    // forked, not that its TUI is reading, and writing into that window is how the trailing \r gets
    // eaten and the user's text is left sitting un-submitted.
    await act(async () => {
      ptyHandlers.output?.("banner\r\n");
      await flush();
    });
    expect(writes).toEqual([]);
    // …and once it has been quiet for the settle window, everything typed arrives, in order, once.
    await act(async () => {
      vi.advanceTimersByTime(REPLAY_SETTLE_MS + 10);
      await flush();
    });
    expect(writes).toEqual(["hi\r"]);
  });

  it("spawns ONE replacement for a burst of keystrokes, not one per character", async () => {
    await ranThenDied();
    const spawnsBefore = spawnCalls.length;
    await act(async () => {
      // A paste arrives as several onData calls in the same tick, before React can re-render. The
      // ref must latch down synchronously or this spawns a PTY per character.
      for (const ch of ["p", "a", "s", "t", "e"]) onDataHandler.current?.(ch);
      await flush();
    });
    expect(spawnCalls.length).toBe(spawnsBefore + 1);
  });
});
