// @vitest-environment jsdom
//
// THE CUTOVER EDGE for local→cloud agent PROMOTION
// (docs/superpowers/specs/2026-07-31-agent-promotion-design.md).
//
// Promotion moves a RUNNING local agent into an E2B sandbox, and its identity decision is that the
// tab keeps everything — same id, same name, same goal, same row. `runtime` is the only field that
// changes. Terminal's mount effect is what SELECTS the transport (`getTransport({ id, runtime })`),
// so that flip has to re-run it. It used to be keyed `[agentId, attempt]` only: `agentId` never
// changes and `attempt` is Terminal's own "Start again" counter, which promotion cannot reach from
// outside. So a promoted pane went on holding the LocalTransport for its dead PTY and never emitted
// `watch` for the sandbox — the sidebar row would say "cloud", the terminal would stream nothing,
// and there is no error anywhere to explain it.
//
// Both assertions here fail against the pre-change dep array, which is what makes them worth having:
// the rebind never happened, and the old transport was never detached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// Every transport getTransport hands out, in creation order, each with its own spy set. The test
// reads this to prove a SECOND transport was built for the new runtime and the FIRST was released.
//
// The array is typed off the FACTORY, not hand-annotated: a hand-written shape listing only the
// verbs the first draft happened to assert on is a `tsc --noEmit` failure waiting for the next
// assertion (vitest transpiles without typechecking, so the test runs green while the typecheck job
// goes red — a split verdict nobody looks for).
function makeTransport(runtime: string) {
  return {
    runtime,
    spawn: vi.fn(() => Promise.resolve()),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    onOutput: vi.fn((_cb: (e: { chunk: string; bytes: number }) => void) => () => {}),
    onExit: vi.fn((_cb: (e: { exitCode?: number }) => void) => () => {}),
    setPaused: vi.fn(),
    ack: vi.fn(),
  };
}

const { built, selections, handlers } = vi.hoisted(() => ({
  built: [] as Array<ReturnType<typeof makeTransport>>,
  selections: [] as string[],
  // The live transport's output/exit subscribers, so a test can drive a cloud attach that yields
  // nothing and then exits.
  handlers: {
    output: undefined as undefined | ((e: { chunk: string; bytes: number }) => void),
    exit: undefined as undefined | ((e: { exitCode?: number }) => void),
  },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        type: "normal",
        length: 1,
        getLine: (_i: number) => ({ translateToString: (_t?: boolean) => "$ " }),
      },
    };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    constructor(_opts: Record<string, unknown>) {}
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      parent.appendChild(el);
      this.element = el;
    }
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    refresh(): void {}
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
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

// The seam under test. The real module picks LocalTransport vs CloudTransport off `runtime`; here we
// only need to observe THAT IT WAS ASKED, and with which runtime.
vi.mock("../services/agentTransport", () => ({
  getTransport: (agent: { id: string; runtime?: string }) => {
    const runtime = agent.runtime ?? "local";
    selections.push(runtime);
    const t = makeTransport(runtime);
    // Capture the subscribers so a test can drive an exit with no output — the failed-cutover case.
    t.onOutput.mockImplementation((cb) => {
      handlers.output = cb;
      return () => {};
    });
    t.onExit.mockImplementation((cb) => {
      handlers.exit = cb;
      return () => {};
    });
    built.push(t);
    return t;
  },
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

import { act } from "react";
import { Terminal } from "./Terminal";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";

const baseProps = {
  agentId: "agent-promoted",
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  active: true,
  onStatus: () => {},
};

beforeEach(() => {
  built.length = 0;
  selections.length = 0;
  handlers.output = undefined;
  handlers.exit = undefined;
  useTerminalOverlayStore.setState({ drafts: {} });
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("promotion cutover: the transport follows `runtime`", () => {
  it("re-selects a cloud transport when a live pane's runtime flips local→cloud", async () => {
    const { rerender } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    expect(selections).toEqual(["local"]);

    // The promotion cutover: the SAME tab (same id, same everything) is now a cloud agent.
    rerender(<Terminal {...baseProps} runtime="cloud" />);

    // A second transport must have been built, and it must be the cloud one. Asserting the last
    // selection rather than just `built.length > 1` is the point — a re-run that re-selected "local"
    // would be a rebind that fixed nothing.
    await waitFor(() => expect(built.length).toBe(2));
    expect(selections[selections.length - 1]).toBe("cloud");
    // …and it actually attached. For CloudTransport, spawn() IS the attach (it emits `watch`), so a
    // transport that was constructed but never spawned would stream nothing.
    await waitFor(() => expect(built[1]!.spawn).toHaveBeenCalled());
  });

  it("releases the old local transport on the flip, which is what ends the local PTY", async () => {
    const { rerender } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    const local = built[0]!;
    expect(local.detach).not.toHaveBeenCalled();

    rerender(<Terminal {...baseProps} runtime="cloud" />);

    // detach(), not kill(): for a LocalTransport detach IS kill (a PTY has no life beyond its pane),
    // while for a cloud transport it is unwatch-only — which is why the teardown must never call
    // kill() and why this assertion is on detach.
    await waitFor(() => expect(local.detach).toHaveBeenCalledTimes(1));
    expect(local.kill).not.toHaveBeenCalled();
  });

  // ══ THE REBIND'S OWN FAILURE MODE ═════════════════════════════════════════════════════════════
  // `firstOutput` / `gotOutputRef` / `spawnFail` describe "has THIS binding produced anything yet",
  // and until promotion they were reset only by `retry()`. A runtime flip re-runs the effect WITHOUT
  // going through retry, so they carried the LOCAL session's `true` into the cloud binding. The
  // consequence is not cosmetic: the loading affordance is suppressed and, worse, the exit handler's
  // `if (!gotOutputRef.current) setSpawnFail("exited")` never fires — so a cloud attach that streams
  // nothing and dies shows no error at all. That is the same silent-nothing this commit exists to
  // remove, one layer down.
  it("shows the loading affordance again while the cloud attach is in flight", async () => {
    const { rerender, findByText } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    // Local streamed something, so the overlay is gone and firstOutput is true.
    act(() => handlers.output?.({ chunk: "hello from the mac\r\n", bytes: 19 }));
    await waitFor(() => expect(document.body.textContent).not.toContain("Starting…"));

    rerender(<Terminal {...baseProps} runtime="cloud" />);

    // The new binding has produced nothing yet, so the pane must say so rather than sit blank.
    expect(await findByText("Starting…")).toBeTruthy();
  });

  it("surfaces an explicit failure when the cloud attach exits without streaming anything", async () => {
    const { rerender, findByText } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    act(() => handlers.output?.({ chunk: "local output\r\n", bytes: 14 }));

    rerender(<Terminal {...baseProps} runtime="cloud" />);
    await waitFor(() => expect(built.length).toBe(2));

    // The sandbox never streamed and the session ended. With a stale `gotOutputRef` this exit was
    // read as "exited after output" — a normal end — and painted nothing.
    act(() => handlers.exit?.({ exitCode: 1 }));
    expect(await findByText("Agent exited.")).toBeTruthy();
  });

  // "The tab keeps everything, only the transport changes" makes preserving the pending-input flag
  // across the cutover look obviously right. It is the opposite. `drafts[agentId]` is a BOOLEAN
  // claim that an unsubmitted line is sitting at the CLI prompt; the text lives in the local
  // Claude's readline buffer, inside the PTY the cutover kills. So the line dies either way, and a
  // surviving flag is a claim about something that no longer exists — with a real consequence,
  // because ConciergeSuggestions hides the recommended-action pill while it is set, and the flag's
  // only writer is the per-binding lineScan fed by keystrokes in THIS terminal, which on a promoted
  // pane may never come again. Stuck true, pill hidden, for the life of the tab (roborev 57372).
  it("clears the pending-input flag on the cutover, so the action pill is not hidden forever", async () => {
    const { rerender } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    act(() => useTerminalOverlayStore.getState().setDraft(baseProps.agentId, true));

    rerender(<Terminal {...baseProps} runtime="cloud" />);
    await waitFor(() => expect(built.length).toBe(2));

    expect(useTerminalOverlayStore.getState().drafts[baseProps.agentId]).toBeUndefined();
  });

  it("clears it on a real teardown too (the pre-existing contract, unchanged)", async () => {
    const { unmount } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));
    act(() => useTerminalOverlayStore.getState().setDraft(baseProps.agentId, true));

    unmount();

    expect(useTerminalOverlayStore.getState().drafts[baseProps.agentId]).toBeUndefined();
  });

  it("does not churn the transport when runtime is unchanged (every non-promoted agent)", async () => {
    const { rerender } = render(<Terminal {...baseProps} runtime="local" />);
    await waitFor(() => expect(built.length).toBe(1));

    // A prop that is not part of the binding decision must not tear down a live PTY.
    rerender(<Terminal {...baseProps} runtime="local" calm />);
    rerender(<Terminal {...baseProps} runtime="local" />);

    expect(built.length).toBe(1);
    expect(built[0]!.detach).not.toHaveBeenCalled();
  });
});
