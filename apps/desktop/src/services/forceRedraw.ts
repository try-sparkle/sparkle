// FORCE A FULL-SCREEN AGENT TO REPAINT, WITHOUT TYPING ANYTHING INTO IT.
//
// ══ THE STATE THIS EXISTS FOR ═══════════════════════════════════════════════════════════════════
// The founder, looking at a row showing a red dot and "Needs you": *"there's nothing that it says
// it needs from me. And in fact, I can't even see anywhere to type. It's almost like it's not
// rendering the entire pane."* And then the ask this module is: *"we specifically need to get it to
// re render or whatever is required so I can actually do something."*
//
// When the app cannot read an agent's screen, labelling that honestly is necessary but not
// sufficient — the human still has a pane with nothing in it. What is missing is a way to make the
// agent SAY IT AGAIN, so the app gets a fresh, complete frame to read and the question becomes
// visible and answerable.
//
// ══ WHY A RESIZE AND NOT A KEYSTROKE — THIS IS THE WHOLE SAFETY ARGUMENT ════════════════════════
// The obvious repaint triggers are all keystrokes, and every one of them is a WRITE into a terminal
// the app has just admitted it cannot read:
//
//   • `esc` DECLINES whatever is being asked. On a live picker that is an answer — the wrong one,
//     chosen by the app, on a question the human never saw.
//   • `ctrl+l`, `enter`, or any printable character are read as COMMANDS by a genuine full-screen
//     program. That is precisely the hazard `voice/dictationTerminalRoute`'s alternate-screen
//     refusal exists to prevent, and this module must not become the hole in it.
//
// A PTY RESIZE writes NO BYTES to the child. It sets the terminal's window size, which delivers
// SIGWINCH; a full-screen TUI responds by re-emitting its current screen. Nothing is typed, nothing
// is answered, and a program that ignores SIGWINCH is simply unchanged. So this is safe to offer on
// exactly the screens the app refuses to type into — which is the point.
//
// ══ VERIFIED EMPIRICALLY, NOT ASSUMED (2026-08-20, Claude Code 2.1.237) ═════════════════════════
// The claim "Claude Code repaints on SIGWINCH" was measured before this shipped, not taken on
// faith. A real `claude` was driven in a pty at 120x40; the window size was changed by one column
// and changed back; the byte stream was recorded and replayed through `@xterm/headless`. Across
// four independent sessions (one per `--permission-mode`) the round-trip emitted **2,912 - 7,135
// bytes** of output and the replayed grid was a COMPLETE screen: the welcome box, both composer
// rules, the `❯` prompt glyph and the mode chrome bar. Two frames arrive, one per size change.
//
// ══ WHY IT GROWS BY A COLUMN RATHER THAN SHRINKING ══════════════════════════════════════════════
// `pty.resizePty` clamps every size UP to a floor (`clampPtyResize`, bead sparkle-mtpot) so a
// transient zero-width layout measurement cannot collapse the PTY to a thin strip. A pane already
// sitting at that floor would therefore have `cols - 1` clamped straight back to `cols` — the same
// size, no SIGWINCH, and a "redraw" that silently did nothing on the narrowest panes, which are
// the ones most likely to be in trouble. Growing is unconditionally above the floor, so the nudge
// always lands.
//
// ══ IT RESTORES THE SIZE IT READ, AND WHY THAT SIZE COMES WITH THE SCREEN ═══════════════════════
// The restore target is the `cols`/`rows` carried on the viewport read, not a fresh sample: the
// user may drag the column between the two calls, and restoring to a stale-but-freshly-sampled
// width would leave the terminal at a size it never had. `TerminalViewport` returns geometry in the
// same provider call as the text for exactly this reason.
import { getAgentViewport, type TerminalViewport } from "./terminalViewport";
import { resizePty } from "../pty";
import { isClaudeCodeScreen } from "../engine/claudeCodeScreen";

/** How long to let the child paint between the two size changes, and again before re-reading.
 *
 *  MEASURED, not guessed: in the captures above, Claude Code emitted its repaint within ~200ms of
 *  each SIGWINCH. 250ms leaves headroom on a loaded machine without making the button feel stuck.
 *  It is exported so a test can drive the real function with a zero wait rather than mocking the
 *  timer — the sequence under test is the two resizes and their order, not the sleeping. */
export const REDRAW_SETTLE_MS = 250;

/** What a redraw attempt did. Deliberately NOT a boolean.
 *
 *  `recovered` is the fact the caller acts on, and it is separate from `redrawn`, which only says
 *  the resize round-trip was issued. A redraw can succeed mechanically and STILL leave the screen
 *  unrecognised — a genuine `vim` repaints beautifully and is still `vim`. Collapsing the two would
 *  let the UI report "fixed" on a pane that is exactly as unreadable as before. */
export interface RedrawOutcome {
  /** The resize round-trip was issued. False only when there was no terminal to resize. */
  redrawn: boolean;
  /** The screen read AFTER the redraw is recognisably Claude Code — i.e. the pane is now readable
   *  and its picker can be answered normally. */
  recovered: boolean;
  /** Why nothing was attempted. `null` when a redraw was issued.
   *
   *  `no-geometry` is its own reason rather than folded into `no-viewport`: the terminal IS mounted
   *  and its screen WAS read, but it reported no size, so there is no width to nudge and restore.
   *  Guessing one (80x24) would resize a live terminal to a size nobody chose — worse than not
   *  redrawing — so this is an explicit dead end. See `TerminalViewport.cols`. */
  reason: "no-viewport" | "no-geometry" | null;
}

/** Injectable seams. Production supplies none of these; every test supplies all of them, so the
 *  real call site below is what a test drives rather than a re-implementation of it.
 *
 *  THE CLOCK IS A SEAM TOO, and that is not incidental. Without it a test either waits half a
 *  second per case or mocks timers globally, and the second is what makes a suite start depending
 *  on the order its files run in. */
export interface RedrawDeps {
  readViewport: (agentId: string) => TerminalViewport | null;
  resize: (agentId: string, cols: number, rows: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  recognises: (screen: string) => boolean;
}

const REAL_DEPS: RedrawDeps = {
  readViewport: getAgentViewport,
  resize: resizePty,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  recognises: isClaudeCodeScreen,
};

/**
 * Make this agent's terminal repaint, then re-read and re-classify it.
 *
 * NO BYTES ARE WRITTEN TO THE CHILD. See the header: this is a window-size change and nothing else,
 * which is what makes it safe on precisely the screens the app refuses to type into.
 *
 * `deps` defaults to the real registry/PTY/clock. It is a DEFAULTED PARAMETER on the same object
 * the call already takes rather than a value read inline, because a seam every test injects and
 * production supplies at one untested line is the "defaulted seam" hole this repo keeps rediscovering
 * (bead sparkle-lgbwf): delete that line and the suite stays green while the feature is dead. Here
 * the production wiring IS this default, so a test can drive the same function with fakes.
 */
export async function forceAgentRedraw(
  agentId: string,
  deps: RedrawDeps = REAL_DEPS,
): Promise<RedrawOutcome> {
  const before = deps.readViewport(agentId);
  // NULL IS A REFUSAL, NOT AN EMPTY SCREEN — `terminalViewport`'s own rule. There is no terminal
  // mounted, so there is nothing to resize and nothing to re-read; saying so is more useful than
  // resizing a PTY whose screen we will not be able to read afterwards either.
  if (!before) return { redrawn: false, recovered: false, reason: "no-viewport" };

  const { cols, rows } = before;
  // NO SIZE, NO REDRAW — and deliberately no fallback. A guessed 80x24 would resize the founder's
  // live terminal to a geometry nobody chose and then "restore" it to that guess, which is a worse
  // outcome than doing nothing. See `TerminalViewport.cols` for why the fields are optional at all.
  if (cols === undefined || rows === undefined) {
    return { redrawn: false, recovered: false, reason: "no-geometry" };
  }
  // GROW then RESTORE. Two size changes, two SIGWINCHes, two full frames — and the second leaves
  // the terminal at exactly the geometry it started with.
  await deps.resize(agentId, cols + 1, rows);
  await deps.sleep(REDRAW_SETTLE_MS);
  await deps.resize(agentId, cols, rows);
  await deps.sleep(REDRAW_SETTLE_MS);

  // RE-READ, rather than trusting the redraw. The whole point is to find out whether the pane is
  // now readable; a redraw that repainted a genuine full-screen program has changed nothing about
  // that, and the caller must not be told otherwise.
  const after = deps.readViewport(agentId);
  const recovered = after !== null && deps.recognises(after.text);
  return { redrawn: true, recovered, reason: null };
}
