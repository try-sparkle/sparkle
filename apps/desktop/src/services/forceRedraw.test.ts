// FORCE REDRAW — the affordance that gets a blind pane to say its question again.
//
// The property that MATTERS here is not "it resizes". It is that a repaint can be forced on a
// screen the app has refused to type into, WITHOUT typing into it. Every keystroke that would
// trigger a repaint is a write into an unreadable terminal — and `esc`, the most tempting one,
// DECLINES whatever is being asked. So the assertions below are as much about what is NOT called
// as about what is.
import { describe, expect, it, vi } from "vitest";
import { forceAgentRedraw, type RedrawDeps } from "./forceRedraw";
import type { TerminalViewport } from "./terminalViewport";

const viewport = (over: Partial<TerminalViewport> = {}): TerminalViewport => ({
  text: "some screen",
  alternateBuffer: true,
  cols: 120,
  rows: 40,
  ...over,
});

/** All four seams, so the REAL `forceAgentRedraw` runs — never a re-implementation of its sequence.
 *  `sleep` resolves immediately: the thing under test is the order and the arguments of the two
 *  resizes, not the waiting. */
function deps(over: Partial<RedrawDeps> = {}) {
  const resize = vi.fn(async () => {});
  const readViewport = vi.fn(() => viewport());
  const d: RedrawDeps = {
    readViewport,
    resize,
    sleep: async () => {},
    recognises: () => false,
    ...over,
  };
  return { d, resize, readViewport };
}

describe("forceAgentRedraw", () => {
  it("issues a size change AND restores the original geometry", () => {
    // Both halves are load-bearing and a test asserting only the first would pass on a function
    // that permanently resized the founder's pane by a column every time he pressed the button.
    const { d, resize } = deps();
    return forceAgentRedraw("a1", d).then(() => {
      expect(resize.mock.calls).toEqual([
        ["a1", 121, 40],
        ["a1", 120, 40],
      ]);
    });
  });

  it("GROWS rather than shrinks, so the PTY size floor cannot swallow the nudge", async () => {
    // `resizePty` clamps every size up to a floor. At a pane already sitting on that floor,
    // `cols - 1` would be clamped straight back to `cols`: same size, no SIGWINCH, and a redraw
    // that silently did nothing on exactly the narrowest panes. This asserts the DIRECTION, which
    // is the part that survives someone "simplifying" the arithmetic.
    const { d, resize } = deps({ readViewport: () => viewport({ cols: 20, rows: 5 }) });
    await forceAgentRedraw("a1", d);
    // Read the recorded arguments rather than destructuring the tuple: `vi.fn()`'s inferred call
    // signature here is `[]`, so `calls[0]![1]` is a compile error, not a runtime one.
    expect(resize).toHaveBeenNthCalledWith(1, "a1", 21, 5);
    expect(resize).toHaveBeenNthCalledWith(2, "a1", 20, 5);
  });

  it("restores the geometry that came WITH the screen it read, not a later sample", async () => {
    // The user can drag the column between the read and the restore. Reading the size a second
    // time would restore the terminal to a width it never had.
    let call = 0;
    const { d, resize } = deps({
      readViewport: () => {
        call += 1;
        return viewport({ cols: call === 1 ? 120 : 80 });
      },
    });
    await forceAgentRedraw("a1", d);
    expect(resize.mock.calls[1]).toEqual(["a1", 120, 40]);
  });

  it("reports recovery when the screen reads as Claude Code AFTER the redraw", async () => {
    const { d } = deps({ recognises: () => true });
    await expect(forceAgentRedraw("a1", d)).resolves.toEqual({
      redrawn: true,
      recovered: true,
      reason: null,
    });
  });

  it("reports redrawn-but-NOT-recovered when the screen is still unrecognised", async () => {
    // A genuine `vim` repaints perfectly and is still `vim`. `redrawn` and `recovered` are separate
    // facts, and collapsing them would let the UI report "fixed" on a pane exactly as unreadable as
    // before.
    const { d } = deps({ recognises: () => false });
    await expect(forceAgentRedraw("a1", d)).resolves.toEqual({
      redrawn: true,
      recovered: false,
      reason: null,
    });
  });

  it("re-reads the screen after the redraw rather than judging the one it started with", async () => {
    // THE PAIRED CASE that pins the re-read: recognition flips from false to true between the two
    // viewport reads. A function that classified `before` would report `recovered: false` here —
    // and would never once notice a pane it had just fixed.
    let call = 0;
    const { d } = deps({
      readViewport: () => {
        call += 1;
        return viewport({ text: call === 1 ? "unreadable" : "recovered screen" });
      },
      recognises: (s) => s === "recovered screen",
    });
    await expect(forceAgentRedraw("a1", d)).resolves.toMatchObject({ recovered: true });
  });

  it("refuses with no-geometry when the viewport reports no size, rather than guessing one", async () => {
    // THE FALLBACK THAT MUST NOT EXIST. A guessed 80x24 would resize the founder's live terminal to
    // a geometry nobody chose and then "restore" it to that guess — permanently reshaping a pane he
    // was only trying to make readable. Doing nothing, and saying so, is strictly better.
    const { d, resize } = deps({
      readViewport: () => ({ text: "screen", alternateBuffer: true }),
    });
    await expect(forceAgentRedraw("a1", d)).resolves.toEqual({
      redrawn: false,
      recovered: false,
      reason: "no-geometry",
    });
    expect(resize).not.toHaveBeenCalled();
  });

  it("refuses when no terminal is mounted, rather than resizing blind", async () => {
    const { d, resize } = deps({ readViewport: () => null });
    await expect(forceAgentRedraw("a1", d)).resolves.toEqual({
      redrawn: false,
      recovered: false,
      reason: "no-viewport",
    });
    expect(resize).not.toHaveBeenCalled();
  });

  // ══ THE SAFETY PROPERTY ═══════════════════════════════════════════════════════════════════════
  // This is the assertion the whole module exists to earn. `RedrawDeps` deliberately has NO write
  // seam — there is no `send`, no `sendKey`, no `write` — so a future change that reached for one
  // would have to widen this interface, and this test names that as the thing not to do.
  it("has no way to write bytes to the child at all — the deps carry no write seam", () => {
    const { d } = deps();
    const seams = Object.keys(d).sort();
    expect(seams).toEqual(["readViewport", "recognises", "resize", "sleep"]);
    for (const forbidden of ["send", "write", "sendKey", "submitPrompt", "sendControlKey"]) {
      expect(seams).not.toContain(forbidden);
    }
  });
});
