// @vitest-environment jsdom
//
// A REJECTED SPAWN HAS TO REACH THE OWNER, not just this terminal's own overlay.
//
// The bug: `Terminal` caught a rejected spawn chain, set its local "Couldn't start the agent" state,
// and told nobody. `AgentPane` therefore never reached its `error` phase, so `noteBriefFailed` never
// fired and the opening brief stayed marked in-flight — `spawn_build_agent` then answered `launching`
// ("give it a moment rather than re-sending") 45 seconds after the pane had already said the agent
// could not start. Two surfaces contradicting each other about one launch.
//
// WHY A RUNTIME TEST AND NOT A SOURCE GREP. The first attempt pinned the `onSpawnFailed` PROP on the
// AgentPane side. The prop is optional, so deleting the invocation from Terminal's catch compiled
// cleanly and left the entire suite green while restoring the bug — the vacuous shape AGENTS.md
// names, asserting the caller's input instead of the side effect. Verified: with the invocation
// deleted, 613 tests passed. These two assert the CALL, and its `disposed` guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { fit, refresh, disposed, ptyHandlers, spawnFail, calls } = vi.hoisted(() => ({
  spawnFail: { promise: Promise.resolve() as Promise<void>, reject: (_e: unknown) => {} },
  calls: [] as string[],
  fit: vi.fn(),
  refresh: vi.fn(),
  disposed: { value: false },
  // The handlers Terminal registers with the PTY layer, captured so a test can fire one AFTER
  // unmount — which is exactly what the async, fire-and-forget unlisten allows in production.
  ptyHandlers: { exit: undefined as undefined | (() => void) },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      // xterm's WebglAddon appends its own webgl2 canvas here. Terminal locates it to release the
      // GPU context and to watch for webglcontextlost, and REFUSES to keep a renderer whose canvas
      // it cannot find (an unwatchable renderer goes solid black on context loss). A mock without
      // this canvas is not a WebGL-rendered terminal, so it cannot exercise the WebGL paths below.
      const glCanvas = document.createElement("canvas");
      Object.defineProperty(glCanvas, "getContext", {
        value: (id: string) =>
          id === "webgl2" ? { getExtension: () => ({ loseContext: () => {} }) } : null,
        configurable: true,
      });
      el.appendChild(glCanvas);
      parent.appendChild(el);
      this.element = el;
    }
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    // Record the call FIRST (so the test detects a post-dispose call even though it's caught), then
    // model the real crash: touching the renderer after dispose throws the dimensions TypeError.
    refresh(start: number, end: number): void {
      refresh(start, end);
      if (disposed.value) throw new Error("undefined is not an object (this._renderer.value.dimensions)");
    }
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {
      disposed.value = true;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {
      fit();
      if (disposed.value) throw new Error("undefined is not an object (this._renderer.value.dimensions)");
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {
  constructor(_handler: unknown) {}
} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

vi.mock("../pty", () => ({
  // THE POINT OF THIS FILE: a spawn chain that REJECTS. `spawnFail` in the hoisted block lets each
  // test decide whether it rejects now or later (the post-unmount arm needs a deferred rejection).
  spawnPty: vi.fn(() => spawnFail.promise),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => {
    calls.push("resize");
    return Promise.resolve();
  }),
  onPtyOutput: vi.fn(() => Promise.resolve(() => {})),
  // NOTE the payload field is `id`, not `agentId`: agentTransport.onExit filters with
  // `e.id === this.id`, so a mock that emits the wrong key silently never invokes the handler and
  // any test built on it passes for the wrong reason (caught by mutation-checking this file).
  onPtyExit: vi.fn((cb: (e: { id: string; epoch: number }) => void) => {
    ptyHandlers.exit = () => cb({ id: "agent-1", epoch: 7 });
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

/** Let the rejection propagate through Terminal's `.catch(...)` and its `if (!disposed)` block. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  fit.mockClear();
  refresh.mockClear();
  disposed.value = false;
  ptyHandlers.exit = undefined;
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
});

describe("Terminal — a rejected spawn reports OUT, not just to its own overlay", () => {
  it("invokes onSpawnFailed when the spawn chain rejects", async () => {
    // Rejects immediately: the ordinary failure (no claude on PATH, worktree-scope guard, …).
    spawnFail.promise = Promise.reject(new Error("pty_spawn refused"));
    // Pre-attach a catch so the rejection is never an unhandled one in the test runner itself.
    spawnFail.promise.catch(() => {});
    const onSpawnFailed = vi.fn();
    render(<Terminal {...baseProps} onSpawnFailed={onSpawnFailed} />);
    await flush();
    // Delete `onSpawnFailed?.()` from Terminal's catch and this is 0 — which is exactly the state
    // the whole suite was green in before this file existed.
    expect(onSpawnFailed).toHaveBeenCalledTimes(1);
  });

  // THE NEGATIVE ARM, and it needs a POSITIVE ANCHOR or it proves nothing. `not.toHaveBeenCalled()`
  // behind a hand-counted microtask flush cannot tell "the disposed guard suppressed the report" from
  // "the rejection has not reached .catch() yet" — and the chain is long and not local to this file
  // (LocalTransport.spawn awaits its listener registrations before spawnPty, then unwinds through two
  // async frames). Add one `await` anywhere upstream and this silently exercises nothing while staying
  // green. So it anchors on `console.debug`, the FIRST and UNGUARDED statement inside the catch:
  // proof the catch ran, before asserting what the guard suppressed.
  //
  // The hazard it guards is real, not symmetry: the rejection is fire-and-forget, so it can land on
  // an unmounting terminal. Reporting then calls `noteBriefFailed` for a row that may be gone,
  // settling a brief a REMOUNT is about to carry — and the retry launches claude with no positional
  // prompt, the briefless agent this branch exists to end.
  it("stays silent when the rejection lands after unmount, per the disposed guard", async () => {
    let reject: (e: unknown) => void = () => {};
    spawnFail.promise = new Promise<void>((_res, rej) => {
      reject = rej;
    });
    spawnFail.promise.catch(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onSpawnFailed = vi.fn();
    const { unmount } = render(<Terminal {...baseProps} onSpawnFailed={onSpawnFailed} />);
    await flush();
    unmount();
    reject(new Error("teardown race"));
    await vi.waitFor(() =>
      expect(debugSpy).toHaveBeenCalledWith(
        "terminal spawn chain failed",
        expect.anything(),
        expect.anything(),
      ),
    );
    // The catch DID run (asserted above) and chose not to report — that is the guard, not a race.
    expect(onSpawnFailed).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  // A THROW AFTER A SUCCESSFUL SPAWN IS NOT A FAILED LAUNCH. The `.catch` wraps the whole body,
  // including the tail that runs once the PTY exists (`fit`, `syncPtySize`, `onReady`). Reporting a
  // launch failure there would hand `noteBriefFailed` a RUNNING agent whose brief is already in
  // claude's argv, and its copy says "Start again" — restarting a working agent and briefing it
  // twice. `onReady` is the easiest tail statement to make throw from outside.
  it("does NOT report a failure when the PTY started and the tail threw", async () => {
    spawnFail.promise = Promise.resolve();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onSpawnFailed = vi.fn();
    render(
      <Terminal
        {...baseProps}
        onReady={() => {
          throw new Error("tail blew up after the pty was up");
        }}
        onSpawnFailed={onSpawnFailed}
      />,
    );
    // Anchor: the catch really did run for this throw…
    await vi.waitFor(() =>
      expect(debugSpy).toHaveBeenCalledWith(
        "terminal spawn chain failed",
        expect.anything(),
        expect.anything(),
      ),
    );
    // …and still declined to call it a launch failure, because the spawn had already returned.
    expect(onSpawnFailed).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  // THE SUCCESS SIGNAL MUST NOT SIT BEHIND THE TAIL THAT CAN THROW. Once `transport.spawn` returns,
  // the `!spawned` gate means this branch can no longer report `failed` — so if the tail also loses
  // `onReady`, the owner hears NOTHING: a running PTY whose brief is in argv, `ptyReady` never set,
  // the brief still marked in-flight, `awaitBriefDelivery` burning its bound and answering
  // `unconfirmed`. The documented consequence of a false `unconfirmed` is a human re-sending the
  // brief into an already-briefed agent — the same double-brief `spawned` exists to prevent.
  //
  // ASSERTED ON THE SOURCE, deliberately. The property is an ORDER inside one block, and `resizePty`
  // is also driven by the ResizeObserver and the become-active effect, so a runtime call-order check
  // cannot tell the tail's sync from those — it fails on an unrelated earlier resize (tried; it
  // does). The BEHAVIOUR either side of this is covered for real by the three runtime arms above;
  // this pins only the structural half they cannot isolate, which is the file's own precedent for
  // AgentPane's launch join.
  it("reports ready BEFORE the size sync, and cannot let that sync throw out of the tail", () => {
    // cwd-relative, not `import.meta.url`: under the jsdom environment that URL is not a
    // file: URL and `fileURLToPath` throws. vitest runs with the package as cwd.
    const src = readFileSync(resolve(process.cwd(), "src/components/Terminal.tsx"), "utf8");
    const tail = src.match(/await transport\.spawn\([\s\S]*?\n {4}\}\)\(\)\.catch/);
    expect(tail).not.toBeNull();
    const body = tail![0];
    // Ready first…
    expect(body.indexOf("onReady?.()")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("syncPtySize(")).toBeGreaterThan(body.indexOf("onReady?.()"));
    // …and the sync individually caught, so its failure costs the size refresh and nothing else.
    expect(body).toMatch(/try \{\s*syncPtySize\(/);
  });
});
