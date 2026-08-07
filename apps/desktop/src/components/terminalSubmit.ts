// Detects genuine prompt submissions in raw-terminal USER input, so the free-trial meter only
// counts a prompt when the user actually typed non-whitespace content and pressed Enter.
//
// SECOND CONSUMER: the same accumulated line IS the answer to "has the user typed into the CLI's
// prompt line right now?" — the signal the terminal-anchored action pill needs in order to get out
// of the way while the user is composing (see hasPendingInput below). There is no other source for
// it: Terminal.tsx is an xterm canvas and the visible input line is painted by the Claude Code CLI
// *inside* that canvas, so nothing in React holds its contents. Scraping the rendered buffer's last
// row was the other candidate and is strictly worse — it sees the CLI's box borders, placeholder
// text and spinner, all of which change between CLI versions, and it cannot tell the user's
// keystrokes apart from the agent's own output. onData, by contrast, fires for USER input ONLY.
//
// A naive "any carriage return = one prompt" rule over-counts badly in a TUI: bare Enters,
// permission/y-n confirmations answered without typing, and menu navigation (arrow keys + Enter)
// all carry a CR but are NOT prompts. This scanner tracks the user's input line the way a line
// editor would — accumulating printable characters, honoring backspace / kill-line, and skipping
// ANSI escape sequences (arrow keys etc.) — and treats a CR/LF as a submit ONLY when the line held
// non-whitespace text. It cannot know the semantic intent of a short answer (a typed "y" + Enter
// still counts), but it eliminates the empty-submit false positives the naive rule produced.
//
// The escape parser is deliberately BOUNDED: a stray/bare ESC (e.g. the user pressing the Escape
// key) must not swallow the rest of the typed line, or a real prompt would be under-counted. We
// recognize the two forms that actually occur in user keyboard input — CSI (`ESC [ … final`, the
// arrow/nav keys) and SS3 (`ESC O x`, the F-keys) — and treat any other post-ESC byte as ordinary
// input. Program-emitted forms like OSC (`ESC ] … BEL`) are not modeled: they appear in terminal
// OUTPUT, effectively never in USER onData, so handling them would be dead weight.

import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { log } from "../logger";

export interface LineScanState {
  /** Printable text the user has typed since the last submit. */
  buf: string;
  /**
   * ANSI escape-sequence parser state:
   *  - "none": ordinary input
   *  - "esc":  a lone ESC was seen; the next byte decides CSI / SS3 / not-a-sequence
   *  - "csi":  inside `ESC [ …`; consume until a final byte in 0x40–0x7E
   *  - "ss3":  inside `ESC O …`; consume exactly one final byte
   */
  esc: "none" | "esc" | "csi" | "ss3";
}

export function makeLineScanState(): LineScanState {
  return { buf: "", esc: "none" };
}

/** Drop the pending line: the user cancelled it rather than submitting it.
 *
 *  Three keys do this in the CLI this terminal hosts — Ctrl-U (kill line), Ctrl-C (cancel), and
 *  ESCAPE, which clears Claude Code's input box. Escape used to be the odd one out: it left `buf`
 *  intact, which is wrong on both counts this scanner serves. For hasPendingInput it pinned the
 *  action pill out of sight over an input line the user can see is empty; for the submit counter it
 *  was a false positive, because the CR that follows an Escape submits nothing yet still debited a
 *  free-trial prompt. Under-counting is the safe direction for a meter that charges the user.
 *
 *  Escape is recognised ONLY as a chunk-final lone ESC. An ESC with more bytes behind it in the
 *  same chunk is a meta prefix (Alt/Option-modified key), not the Escape key — see the in-loop
 *  branch in scanSubmittedLines for why conflating the two broke ordinary editing keys. */
function killPendingLine(state: LineScanState): void {
  state.buf = "";
}

/** Whether the user has an unsubmitted, non-whitespace line pending in the terminal — i.e. they are
 *  mid-compose at the CLI's own prompt. The terminal-anchored action pill hides while this is true
 *  and comes back when the line is submitted or cancelled.
 *
 *  Matches the submit rule exactly (`trim()`), so "typing spaces" is not treated as composing and,
 *  more importantly, so the pill cannot end up hidden over a line the counter would refuse to
 *  count. Cheap and synchronous: callers may run it on every onData chunk. */
export function hasPendingInput(state: LineScanState): boolean {
  return state.buf.trim().length > 0;
}

/**
 * Feed one chunk of USER terminal input (never programmatic agent output). Mutates `state` and
 * returns the number of non-empty lines submitted within this chunk (0, 1, or more for a paste
 * spanning multiple lines). The caller records that many trial prompts.
 */
export function scanSubmittedLines(state: LineScanState, chunk: string): number {
  let submits = 0;
  for (const ch of chunk) {
    // --- ANSI escape-sequence handling (bounded so a stray ESC can't swallow real input) ---
    if (state.esc === "csi") {
      // Parameter (0x30–0x3F) and intermediate (0x20–0x2F) bytes continue the sequence; a final
      // byte in 0x40–0x7E ends it.
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) state.esc = "none";
      continue;
    }
    if (state.esc === "ss3") {
      state.esc = "none"; // SS3 (`ESC O x`) is exactly one byte after the O
      continue;
    }
    if (state.esc === "esc") {
      if (ch === "[") {
        state.esc = "csi";
        continue;
      }
      if (ch === "O") {
        state.esc = "ss3";
        continue;
      }
      // ESC followed, IN THE SAME CHUNK, by something that isn't a CSI/SS3 introducer. This is a
      // META PREFIX — an Alt/Option-modified key — NOT the Escape key. A real Escape keypress always
      // arrives as its own onData event and is handled at the end of this function instead.
      //
      // The two meta keys that matter are the ones xterm emits for the editing keys, verified in the
      // shipped bundle:
      //   case 8:  o.key = e.ctrlKey ? "\b" : C0.DEL, e.altKey && (o.key = C0.ESC + o.key)
      //   case 13: o.key = e.altKey ? C0.ESC + C0.CR : C0.CR
      // Both are EDITS to the line being composed, and neither may be handled as its bare byte —
      // that byte means something else entirely (cancel, or submit).
      state.esc = "none";
      if (ch === "\r" || ch === "\n") {
        // Option+Enter is the CLI's insert-newline, NOT a submit. Falling through to the CR branch
        // both counted a prompt and emptied the line: a two-line prompt debited the free-trial
        // meter twice (against this file's own "under-count, never over-count" rule), and
        // hasPendingInput went false the moment the user broke the line — so the action pill popped
        // back over a visibly non-empty input box during the normal rhythm of composing a
        // multi-line prompt. Keep it in the buffer as the newline it is; `trim()` governs both
        // consumers, so a soft newline can never make an otherwise-blank line look non-empty.
        state.buf += "\n";
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        // Option+Backspace deletes the previous WORD. Falling through to the backspace branch
        // deleted a single character instead, leaving phantom text on the line — a smaller
        // over-count on the same meter, and the same class of lie to hasPendingInput.
        state.buf = state.buf.replace(/\s*\S+\s*$/, "");
        continue;
      }
      // Any other meta combo: fall through and treat the byte as ordinary input, which is what this
      // branch has always done. Alt+letter navigation is modelled as typed text by that choice; it
      // errs toward "the user has a pending line", i.e. toward HIDING the pill, which is the safe
      // direction of the two.
    }

    // --- ordinary input handling ---
    if (ch === "\x1b") {
      state.esc = "esc"; // start of a possible escape sequence
    } else if (ch === "\r" || ch === "\n") {
      // BACKSLASH-CONTINUATION is a soft newline too (roborev 53628). `\` + Enter is the CLI's
      // universal multiline idiom — it works in every terminal, unlike Option/Shift+Enter, which
      // needs the meta mapping handled above — and it arrives as an ordinary printable `\` followed
      // by a bare CR, so it would otherwise land here and reproduce BOTH defects the ESC+CR branch
      // exists to remove: the trailing backslash makes `trim()` non-empty, so the continuation
      // debits a free-trial prompt and the real Enter debits another; and clearing `buf` at the
      // break flashes the action pill back over a visibly non-empty input box mid-compose.
      //
      // The CLI does not keep the backslash in the prompt, so drop it. An ODD number of trailing
      // backslashes is a continuation; an even number means the last one is itself escaped and this
      // really is a submit. A line genuinely ending in a literal backslash therefore under-counts,
      // which is the safe direction per this file's own rule at the top.
      const trailing = /\\*$/.exec(state.buf)?.[0].length ?? 0;
      if (trailing % 2 === 1) {
        state.buf = `${state.buf.slice(0, -1)}\n`;
        continue;
      }
      if (state.buf.trim().length > 0) submits += 1; // submit boundary — count only non-empty
      state.buf = "";
    } else if (ch === "\x7f" || ch === "\b") {
      state.buf = state.buf.slice(0, -1); // backspace / DEL
    } else if (ch === "\x15" || ch === "\x03") {
      killPendingLine(state); // Ctrl-U (kill line) or Ctrl-C (cancel)
    } else if (ch >= " ") {
      state.buf += ch; // printable character
    }
    // other C0 control bytes (tab, etc.) are ignored for submission purposes
  }
  // A lone ESC left pending at the end of a chunk is a bare Escape keypress, NOT the start of a
  // sequence split across reads: for USER keyboard input, arrow/nav sequences arrive whole in a
  // single onData chunk, so ESC is only ever its own event when it's the last byte. Reset it so a
  // following chunk that happens to begin with '[' or 'O' is counted as typed text rather than
  // silently swallowed as a CSI/SS3 introducer. (Only the pre-introducer "esc" state is reset; a
  // mid-CSI/SS3 split is left to resolve on the next byte.)
  //
  // This is the COMMON shape of a real Escape keypress — Escape alone, as its own onData event —
  // so it kills the pending line here for the same reason the in-loop branch above does.
  if (state.esc === "esc") {
    state.esc = "none";
    killPendingLine(state);
  }
  return submits;
}

// ══ THE APP'S OWN WRITES TO THE SAME INPUT LINE ══════════════════════════════════════════════════
//
// Everything above models the USER's line, because `onData` is a user-only signal. But the app also
// writes to that line — the dictation sink types a phrase into it (`pasteIntoPty`), the concierge
// submits through it (`deliverSubmit`), the model picker clears it and types `/model …`. None of
// those reach `onData`, so the scanner cannot see them, and `hasPendingInput` answers about a line
// that is no longer the one on screen.
//
// PUBLISHING THE DERIVED FLAG FROM THOSE CALL SITES IS NOT ENOUGH, and that is the lesson this
// registry encodes (roborev 59728/59742). `Terminal.tsx` recomputes `setDraft(agentId,
// hasPendingInput(state))` on EVERY chunk, so a publish that does not also update `state` survives
// exactly until the user's next non-printable keystroke: an arrow key or a Backspace against a
// pasted line recomputes from an empty `buf` and writes `false` back over it, while the CLI prompt
// still holds the dictated words. Those are precisely the keys a user presses after dictation
// inserts a line, so the guard flickered off one keystroke into the scenario it exists for. The
// mirror case is worse: `/model`'s Ctrl-U wipes a line the scanner still believes in, so the next
// keystroke recomputes a stale `true` over an EMPTY prompt and declines every compose-focus pull.
//
// So the app's writes go through the SAME state the user's do, and the flag is derived in one place
// for both. `noteUserInput` is what `Terminal.tsx` calls; the three `noteProgrammatic*` functions
// are what the writers call.


/** agentId → the live scanner for that terminal's input line, while its Terminal is mounted. */
const scans = new Map<string, LineScanState>();

/** Publish the ONE derived fact, from the ONE state. Called after every mutation, user or app. */
function publish(agentId: string, state: LineScanState): void {
  // The store no-ops unless emptiness actually flips, so this stays one write per word.
  useTerminalOverlayStore.getState().setDraft(agentId, hasPendingInput(state));
}

/** Start tracking this agent's input line. RETURNS the state, and the caller must keep it: it is the
 *  identity {@link unregisterLineScan} checks against. */
export function registerLineScan(agentId: string): LineScanState {
  const state = makeLineScanState();
  scans.set(agentId, state);
  return state;
}

/** Stop tracking (the terminal was torn down). Does NOT touch the draft flag: the teardown path owns
 *  that decision, and clears it explicitly.
 *
 *  IDENTITY-CHECKED, and that is not a nicety. Agent ids are stable while `Terminal` instances are
 *  not — `AgentPane` remounts the terminal on an account switch (`key={chosenAccount?.id}`) with the
 *  same `agentId`, and a promotion rebind does the same. React mounts the replacement BEFORE it runs
 *  the outgoing effect's cleanup, so a delete-by-key would have the old instance's teardown remove
 *  the NEW instance's scanner. Every keystroke after that would find nothing registered
 *  (roborev 59775). Passing the state you were given makes the stale teardown a no-op.
 *
 *  The parameter is optional so a caller that never held the state still gets the old behaviour —
 *  but `Terminal.tsx` holds it, and any new caller should.
 *
 *  RETURNS whether this call actually unregistered, i.e. whether the caller still OWNED the
 *  registration. That answer is what a teardown needs before touching anything else keyed on the
 *  agent id: the `drafts` flag has exactly the same stale-teardown hazard as the scanner, and it is
 *  worse, because nothing republishes it until the user's next keystroke (roborev 60111). */
export function unregisterLineScan(agentId: string, state?: LineScanState): boolean {
  if (state !== undefined && scans.get(agentId) !== state) return false;
  scans.delete(agentId);
  return true;
}

/** Feed one chunk of USER input: scan it, publish the derived flag, and return the submit count.
 *  The one entry point `Terminal.tsx`'s `onData` uses, so a test that drives this drives the app.
 *
 *  A MISS CREATES THE STATE RATHER THAN RETURNING 0. This used to fail open and silently, which is
 *  the worst shape available here: the count it returns drives `onSubmitLine` → the free-trial
 *  debit, so an unregistered agent would stop metering prompts AND stop publishing `drafts`
 *  (unhiding the action pill, un-vetoing the compose-focus pull) with nothing thrown and nothing
 *  logged. Before the registry existed `Terminal.tsx` owned a closure-local state that could not be
 *  absent, so this failure mode is one the registry introduced — it is repaid here rather than
 *  documented (roborev 59775). Creating on demand keeps the invariant the old code had: user input
 *  is ALWAYS scanned. The warn is what makes the missing `registerLineScan` findable. */
export function noteUserInput(agentId: string, chunk: string): number {
  let state = scans.get(agentId);
  if (!state) {
    log.warn("terminal", "line scan not registered for this agent — creating one on demand", {
      agentId,
    });
    state = registerLineScan(agentId);
  }
  const submits = scanSubmittedLines(state, chunk);
  publish(agentId, state);
  return submits;
}

/** The app INSERTED text at the prompt without submitting it — a dictated phrase, a dropped path.
 *  Appended to the same buffer a keystroke would append to, so the next recompute agrees. */
export function noteProgrammaticInsert(agentId: string, text: string): void {
  const state = scans.get(agentId);
  if (!state) {
    // No terminal mounted for this agent (so nothing will recompute over us). Publish the fact
    // anyway: the flag outlives the pane, and a mount that arrives later starts from a fresh
    // scanner rather than from a lie.
    if (text.trim() !== "") useTerminalOverlayStore.getState().setDraft(agentId, true);
    return;
  }
  state.buf += text;
  publish(agentId, state);
}

/** The app EMPTIED the prompt without submitting — `/model`'s Ctrl-U kill. */
export function noteProgrammaticClear(agentId: string): void {
  const state = scans.get(agentId);
  if (!state) {
    useTerminalOverlayStore.getState().setDraft(agentId, false);
    return;
  }
  state.buf = "";
  state.esc = "none";
  publish(agentId, state);
}

/** The app SUBMITTED the line — a carriage return went to the PTY, so the prompt is empty again.
 *  Identical effect to a clear today; kept separate because the two are different events and a
 *  future submit-counting consumer must not be forced to guess which one happened. */
export function noteProgrammaticSubmit(agentId: string): void {
  noteProgrammaticClear(agentId);
}
