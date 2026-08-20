// @vitest-environment jsdom
//
// A FILE DROPPED ON THE SPARKLE PANE'S TERMINAL PASTES ITS PATH INTO THAT TERMINAL.
//
// This pane was the one place in the app where it didn't. It rendered a Terminal and a catch-all
// Composer as siblings, and the composer claimed every drop anywhere in the pane — so a drop on the
// terminal was loaded as a chat attachment instead of pasted. Loading READS the file, and the Rust
// attachment loader refuses anything outside $HOME/$TMPDIR/Volumes or under a dot-directory; the
// refusal is a log line and nothing else, so the file disappeared. Observed exactly that way: a
// .txt dropped here logged `dropped 1 file(s) into chat` then `load dropped file failed`, while
// .pngs dropped on a build agent's terminal pasted fine — which reads as "images work, .txt
// doesn't" even though nothing in either path looks at the extension.
//
// So the assertions here are on WHAT REACHED THE PTY — the bytes, for the agent whose terminal was
// dropped on. "A handler was registered" or "a drop event fired" would both have been true
// throughout the broken behaviour.
//
// The Terminal is mocked (the real one drags in xterm and a PTY). The pane composer that used to
// swallow these drops is GONE from the pane entirely — Improve Sparkle now takes input through the
// mounted concierge — so there is no second surface left to test the split against. The attachment
// loader is still stubbed and still ASSERTED ON: `captured.loaded` staying empty is what proves no
// catch-all listener has reclaimed the pane, which is the failure this file was written for.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  handlers: [] as ((event: { payload: unknown }) => void)[],
  paste: vi.fn(),
  /** Paths anything in this pane asked the (Rust-backed) attachment loader for. Must stay EMPTY. */
  loaded: [] as string[],
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handlers.push(h);
      return new Promise<() => void>(() => {});
    },
  }),
}));
vi.mock("../pty", () => ({
  pasteIntoPty: (id: string, text: string) => captured.paste(id, text),
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  PtyGoneError: class PtyGoneError extends Error {},
}));
vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return { ...real, Terminal: () => null };
});
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
// The attachment loader — the Rust round-trip whose refusal made a dropped .txt vanish. Stubbed so
// it records instead of calling out, and then ASSERTED ON: it must be called ZERO times from this
// pane. Nothing here should render a surface that loads a dropped file any more.
vi.mock("./composer/attachmentsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("./composer/attachmentsApi")>();
  return {
    ...real,
    loadAttachment: vi.fn((path: string) => {
      captured.loaded.push(path);
      return Promise.resolve({ id: `att-${path}`, kind: "file" as const, path, name: path });
    }),
  };
});
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
vi.mock("../services/worktree", () => ({
  createAgentWorktree: vi.fn(() =>
    Promise.resolve({ path: "/wt/sparkle-self", branch: "sparkle/agent-self" }),
  ),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
  acquireWorktreeLease: vi.fn(() => Promise.resolve()),
  releaseWorktreeLease: vi.fn(() => Promise.resolve()),
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
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SparkleAgentPane } from "./SparkleAgentPane";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { APP_WINDOW_LABEL } from "../windowContext";
import { SPARKLE_TERMINAL_DND_TARGET } from "../services/dndTargets";

const SPARKLE_ID = sparkleAgentIdFor(APP_WINDOW_LABEL);
const at = { x: 20, y: 20 };

/** jsdom has no elementFromPoint. Place the cursor over the pane's marked terminal box — found in
 *  the rendered DOM, not hand-built, so deleting the `data-dnd-target` fails this rather than
 *  quietly testing a detached element. */
function overTerminal(): void {
  const box = document.querySelector(`[data-dnd-target="${SPARKLE_TERMINAL_DND_TARGET}"]`);
  if (!box) throw new Error("the Sparkle pane rendered no terminal drop region");
  document.elementFromPoint = vi.fn(() => box);
}

async function renderPane() {
  render(<SparkleAgentPane visible agentId={SPARKLE_ID} />);
  // prepare() is async; the terminal box only exists once the pane is `ready`.
  await waitFor(() => expect(captured.handlers.length).toBeGreaterThan(0));
  await waitFor(() =>
    expect(document.querySelector(`[data-dnd-target="${SPARKLE_TERMINAL_DND_TARGET}"]`)).toBeTruthy(),
  );
}

const drop = (paths: string[]) =>
  act(async () => {
    for (const h of captured.handlers) h({ payload: { type: "drop", position: at, paths } });
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  captured.handlers = [];
  captured.loaded.length = 0;
  captured.paste.mockReset();
  captured.paste.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("SparkleAgentPane — dropping a file on its terminal", () => {
  it("pastes a NON-IMAGE file's path into the Sparkle agent's own PTY", async () => {
    await renderPane();
    overTerminal();
    await drop(["/tmp/notes.txt"]);
    expect(captured.paste.mock.calls).toEqual([[SPARKLE_ID, "/tmp/notes.txt "]]);
  });

  it("shell-quotes a path the shell would otherwise break apart", async () => {
    // The .txt that started this lived under a directory with a space in it. Quoting comes from
    // services/shellQuote; this asserts the bytes that actually reached the PTY carry it.
    await renderPane();
    overTerminal();
    await drop(["/Users/me/My Notes/todo.txt"]);
    expect(captured.paste.mock.calls).toEqual([[SPARKLE_ID, "'/Users/me/My Notes/todo.txt' "]]);
  });

  it("pastes EVERY path of a multi-file drop, space-separated", async () => {
    await renderPane();
    overTerminal();
    await drop(["/tmp/a.txt", "/tmp/b.pdf", "/tmp/c.png"]);
    expect(captured.paste.mock.calls).toEqual([[SPARKLE_ID, "/tmp/a.txt /tmp/b.pdf /tmp/c.png "]]);
  });

  it("ignores a drop that lands outside the terminal box", async () => {
    // Only the marked terminal box is claimed. A drop elsewhere in the pane — the consent banner,
    // the pinned prompt — is not this hook's, and must not reach the PTY.
    await renderPane();
    document.elementFromPoint = vi.fn(() => document.body);
    await drop(["/tmp/notes.txt"]);
    expect(captured.paste).not.toHaveBeenCalled();
  });
});

// ONE DROP, ONE DESTINATION — now that the terminal is the pane's only drop surface.
//
// This block used to pin an OWNERSHIP SPLIT between two overlapping absolutely-positioned siblings:
// the terminal's region spanned the whole pane, the pane composer overlaid the bottom strip, and
// which one a drop hit was decided by paint order (elementFromPoint returns the topmost element and
// both hooks resolve ownership by walking UP from it). Two rows pinning that split — the composer's
// z-index vs the region's, and "a drop on the compose box becomes a tile" — WERE DELETED WITH IT:
// Improve Sparkle moved to the mounted concierge, this pane's composer was stripped, and it was the
// app's last `<Composer>` render site. Rows asserting a surface that no longer renders would fail
// for the right reason and then be "fixed" by re-adding the surface, which is backwards.
//
// What survives is the half that never depended on a second surface: the scrim must stay trapped in
// the terminal region, and a terminal drop must be pasted WITHOUT also being loaded as an
// attachment. That second row is the original bug's assertion and it now also witnesses the strip —
// it would fail again the moment any catch-all attachment listener reclaimed this pane.
describe("SparkleAgentPane — one drop, one destination", () => {
  const terminalBox = () =>
    document.querySelector<HTMLElement>(`[data-dnd-target="${SPARKLE_TERMINAL_DND_TARGET}"]`)!;

  it("contains the drag-over scrim inside the terminal region", async () => {
    // What the explicit z-index still BUYS with the composer gone. The scrim is z-20 and
    // `inset: 0`; without a stacking context on the region it renders in, it escapes upward and
    // paints "Drop into Sparkle's terminal" across the consent banner and the pinned prompt. jsdom
    // can't compute paint order, so assert the structural property it follows from: the nearest
    // ancestor carrying an inline z-index — the stacking context trapping the scrim — is the
    // terminal region itself.
    await renderPane();
    overTerminal();
    await act(async () => {
      for (const h of captured.handlers)
        h({ payload: { type: "enter", position: at, paths: ["/tmp/notes.txt"] } });
    });
    const scrim = screen.getByTestId("terminal-drop-overlay");
    let ctx: HTMLElement | null = scrim.parentElement;
    while (ctx && !ctx.style.zIndex) ctx = ctx.parentElement;
    expect(ctx).toBe(terminalBox());
    // DECLARED, not merely inherited (roborev 55608). An absent inline z-index reads as `""`, which
    // is exactly the state whose scrim escapes — and `ctx` would then have walked past the region to
    // some outer positioned ancestor, so this pins the reason the walk stopped where it did.
    expect(terminalBox().style.zIndex).not.toBe("");
  });

  it("pastes a terminal drop, and does NOT also load it as an attachment", async () => {
    // The original failure: the pane composer's catch-all took a terminal drop, the Rust loader
    // refused the path, and the file was nowhere. Nothing in this pane may load a dropped file any
    // more — there is no surface left that would show it.
    await renderPane();
    overTerminal();
    await drop(["/tmp/notes.txt"]);
    expect(captured.paste.mock.calls).toEqual([[SPARKLE_ID, "/tmp/notes.txt "]]);
    expect(captured.loaded).toEqual([]);
  });
});
