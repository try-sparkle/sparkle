// MAY A SPOKEN PHRASE BE TYPED INTO THIS TERMINAL, AND IN WHAT FORM?
//
// Pure, so every refusal is unit-testable without a DOM, a PTY, or xterm — this codebase's
// convention for anything load-bearing (cf. `dictationPauseReason`, `terminalEscapeAction`).
//
// ══ THE CONTRACT THIS ENFORCES ══════════════════════════════════════════════════════════════════
// 1. WHOLE PHRASES ONLY. The caller passes committed segments; interim transcription must never
//    reach a live PTY, because a partial phrase is arbitrary text arriving character by character.
// 2. TYPE, DO NOT SUBMIT. The text lands on the agent's input line and STOPS. The human presses
//    Enter. Auto-submitting a voice transcript into a shell is how someone runs a command they never
//    intended — and with a hot mic in Speak mode, "someone" includes a passer-by. {@link
//    normalizeForTerminal} is the half of that contract this module owns: it removes every byte that
//    could submit on its own, so the guarantee survives even where the bracketed-paste framing
//    doesn't (a bare shell that never enabled paste mode reads a lone `\r` as Enter).
// 3. REFUSE WHEN THE SCREEN IS NOT A PLAIN PROMPT — see the two dangerous states below.
//
// ══ THE TWO DANGEROUS STATES ════════════════════════════════════════════════════════════════════
// ALTERNATE SCREEN BUFFER (`vim`, `less`, `htop`, `lazygit`). The strongest of the guards and the one
// most easily missed: a full-screen app reads pasted text as COMMANDS. Dictating "delete the second
// paragraph" into `vim` in normal mode does not insert a sentence — `d` deletes, `2` counts, `p`
// pastes. The buffer type answers this exactly, with no content heuristic to fool.
//
// AWAITING INPUT (an Ink picker, `(y/n)`, `password:`, `enter passphrase`). Free text aimed at a
// live picker is the failure the concierge already refuses on its own path (`ambiguous-picker`), and
// a passphrase prompt echoes nothing, so a misrouted phrase is invisible as well as wrong.
//
// Both are read from the VIEWPORT, never the scrollback — see `services/terminalViewport.ts` for why
// history latches the second guard true forever.
import { screenAwaitsInput } from "../engine/screenClassifier";
import type { TerminalViewport } from "../services/terminalViewport";

/**
 * Prompts that must block a WRITE but that `screenAwaitsInput` does not catch.
 *
 * ══ WHY THIS LIST EXISTS AT ALL (roborev 56022) ═════════════════════════════════════════════════
 * `screenAwaitsInput` is a STATUS classifier, and its own header states the opposite risk profile to
 * ours: *"Bias toward FALSE (gray) … a missed RED just shows gray"*. A miss there costs a dull tab
 * badge. A miss HERE types a spoken sentence into a password field. Reusing it unaided inherited
 * four real misses, each verified against the live patterns:
 *   - `[sudo] password for drodio:`         — its `/(^|\s)password:\s*$/` needs the line to END in
 *   - `Password for 'https://github.com':`     "password:", which neither of these does.
 *   - ssh's `…continue connecting (yes/no/[fingerprint])?` — `/[([]y\/n[)\]]/` wants a bare `y/n`.
 *   - `Type "yes" to confirm:`
 * The first two echo NOTHING, so a misrouted phrase there is invisible as well as wrong.
 *
 * DELIBERATELY BROAD, because the bias runs the other way here: any line ENDING in a colon that
 * mentions a password or passphrase blocks, which will occasionally refuse over ordinary prose
 * ("Steps to reset your password:"). That costs the user one repeated phrase. The opposite error
 * costs them a password typed into a terminal, in the clear, and possibly submitted.
 */
const WRITE_BLOCKING_PROMPTS: RegExp[] = [
  /\bpass(word|phrase)\b[^\n]*:\s*$/im,
  /\(\s*yes\s*\/\s*no/i,
  /\btype\s+["']?yes["']?\b/i,
];

/**
 * Words that mark a line as a CREDENTIAL PROMPT. Broader than "password" on purpose (roborev 56047):
 * the hazard is a field that ECHOES NOTHING, and plenty of those are not spelled password —
 * `gh auth login` asks *"Paste your authentication token:"*, 2FA asks *"Verification code:"*, git
 * asks *"Username for 'https://github.com':"*. All three failed every arm of the list above while
 * being exactly the class its own doc calls "invisible as well as wrong". `gh auth login` is part of
 * this repo's routine workflow.
 *
 * OVER-MATCHING IS CHEAP HERE, and that is a deliberate consequence of the caller: a refusal no
 * longer discards the phrase, it leaves it in the composer (see the sink's caller in useDictation).
 * So a false block costs the user a phrase in the wrong box, which they can see and re-aim. A false
 * DELIVER costs them a spoken sentence typed into a concealed credential field.
 */
const CREDENTIAL_WORD =
  /\b(pass(word|phrase|code)|username|token|otp|one[-\s]?time\s+(code|password)|verification\s+code|2fa|two[-\s]?factor|pin)\b/i;

/**
 * The last few rendered rows, joined into ONE string.
 *
 * ══ WHY ROWS MUST BE RE-JOINED (roborev 56047) ══════════════════════════════════════════════════
 * `snapshotScreen` builds the snapshot from xterm's buffer one `IBufferLine` per `\n`, and xterm
 * puts a HARD-WRAPPED CONTINUATION on its own buffer line. So a prompt longer than the pane is split
 * across rows, and every `…:\s*$` pattern above — which needs the word and its colon on the SAME row
 * — silently stops matching. These terminals live in user-resizable columns, so the wrap width is
 * whatever the user dragged it to, and the guard would be width-dependent:
 *
 *     Enter the password for daniel@example.com at      <- row N   (has the word, no colon)
 *     my.1password.com:                                 <- row N+1 (has the colon, no word)
 *
 * Every test fixture used a single unwrapped line, which is exactly why the suite could not see it.
 */
function screenTail(snapshot: string, rows = 3): string {
  const lines = snapshot.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.slice(-rows).join(" ");
}

/**
 * Is the screen showing anything that must not receive free text? The write-gate counterpart to
 * `screenAwaitsInput` — a SUPERSET of it, never a replacement, so every prompt the status
 * classifier already recognizes keeps blocking here too.
 */
export function screenBlocksWrite(snapshot: string): boolean {
  if (screenAwaitsInput(snapshot)) return true;
  if (WRITE_BLOCKING_PROMPTS.some((re) => re.test(snapshot))) return true;
  // The wrap-tolerant arm: a credential word ANYWHERE in the trailing region, and that region
  // ending in a colon — the shape of a prompt sitting there waiting, however it happened to wrap.
  const tail = screenTail(snapshot);
  return /:\s*$/.test(tail) && CREDENTIAL_WORD.test(tail);
}

/** Why a phrase was NOT typed into a terminal. Every arm is a refusal to write; none is an error. */
export type TerminalRouteRefusal =
  /** The phrase held no speech once control bytes and whitespace were removed. */
  | "empty"
  /** No agent owns the caret — nothing to aim at. */
  | "no-terminal"
  /** A cloud agent or an unknown id: there is no local PTY to write to. */
  | "not-writable"
  /** The terminal isn't mounted, or its screen could not be read. FAIL CLOSED — see below. */
  | "no-viewport"
  /** `vim`/`less`/`htop`: the paste would be executed as commands. */
  | "alternate-screen"
  /** A live picker, `(y/n)`, or a password prompt is on screen. */
  | "awaiting-input";

/** The refusals that are about THE SCREEN rather than about the text or the agent — the subset any
 *  write path can ask about, whatever it is writing. */
export type TerminalScreenRefusal = Extract<
  TerminalRouteRefusal,
  "no-viewport" | "alternate-screen" | "awaiting-input"
>;

/**
 * MAY ANYTHING BE WRITTEN TO THIS SCREEN? The screen half of {@link classifyTerminalRoute}, split out
 * so a second caller can ask the same question without inheriting the rest.
 *
 * ══ WHY THIS IS SHARED RATHER THAN COPIED ═══════════════════════════════════════════════════════
 * The concierge composer routes into a terminal too, on two paths: an `@Name` address, and — since
 * the mounted-composer rule — plain text while the cable is patched to a build agent. Those writes
 * face exactly the dangers this file was written about: a paste into `vim` normal mode is EXECUTED as
 * editor commands, and a sentence typed at `[sudo] password for …:` is a credential in the clear.
 * `dispatchConciergeAnswer` checks neither — it looks for a live PICKER and nothing else — so without
 * this the composer would have been the unguarded twin of a path guarded to four decimal places.
 *
 * A second implementation was the alternative and it is the worse one for a reason this repo keeps
 * re-learning: the two lists above (`WRITE_BLOCKING_PROMPTS`, `CREDENTIAL_WORD`) grew four entries
 * apiece from real misses found in the field, and a copy would have inherited the misses and not the
 * fixes. One function, both callers.
 *
 * IT DOES NOT DECIDE WHAT `null` MEANS — it only reports it. `no-viewport` is "I cannot read this
 * terminal", which is the state where a clean prompt and a `vim` session are indistinguishable.
 * Dictation treats that as fatal. The composer's ADDRESS path cannot: it may legitimately name an
 * agent whose pane is not mounted in this window, and refusing there would break a shipped feature to
 * guard a screen nobody is looking at. So the caller weighs it — see ConciergeHost, which refuses a
 * MOUNT on it (the mounted agent's terminal is on screen by construction, so unreadable means
 * something is actually wrong) and lets an ADDRESS through.
 */
export function terminalWriteRefusal(
  viewport: TerminalViewport | null,
): TerminalScreenRefusal | null {
  if (!viewport) return "no-viewport";
  if (viewport.alternateBuffer) return "alternate-screen";
  if (screenBlocksWrite(viewport.text)) return "awaiting-input";
  return null;
}

export type TerminalRouteVerdict =
  /** Type `text` at the agent's input line. Already normalized — deliver it verbatim. */
  | { kind: "deliver"; text: string }
  | { kind: "refuse"; reason: TerminalRouteRefusal };

export interface TerminalRouteInput {
  /** The committed phrase, raw from the transcriber. */
  text: string;
  /** Does a LOCAL pty exist for this agent? (`agentCanAcceptInput` — false for cloud/unknown.) */
  writable: boolean;
  /** The agent's rendered screen, or null when it can't be read. */
  viewport: TerminalViewport | null;
}

/**
 * Reduce a spoken phrase to something that can only ever be TYPED, never submitted or interpreted.
 *
 * Every C0 control byte (0x00–0x1F), plus DEL, becomes a space. That is deliberately broader than
 * the `\r`/`\n` this is nominally about, and each extra byte earns its place:
 *   - `\r` / `\n` — the submit bytes. A CLI outside bracketed-paste mode sends the line on either,
 *     so a two-sentence transcript would run the first half as a command. This is the whole reason
 *     the function exists.
 *   - `\x1b` (ESC) — starts an escape sequence. `stripPasteMarkers` (pty.ts) removes the bracketed
 *     paste markers specifically, and is the right guard for the framing; a lone ESC that begins some
 *     OTHER sequence is not its problem, and would leave insert mode in an editor.
 *   - `\t` — triggers completion in most shells, which can EXECUTE a completion hook.
 * A transcriber emits none of these today. That is exactly why the guard is cheap, and why it must
 * not be conditioned on the transcriber's current behavior.
 *
 * Runs of whitespace then collapse to one space and the result is trimmed, so a phrase that was
 * nothing but control bytes comes back empty and is refused rather than typed as a blank.
 */
export function normalizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * THE decision. Order is by how much the caller can tell the user, cheapest and most specific first;
 * the guards themselves are independent, so the order is about the message, not about safety.
 *
 * ══ NULL VIEWPORT REFUSES ═══════════════════════════════════════════════════════════════════════
 * A missing or throwing provider is `no-viewport`, NOT an empty screen. The difference is the whole
 * guard: "I cannot see this terminal" is the state in which a `vim` session and a clean prompt are
 * indistinguishable, and treating it as clean would write into whichever one it actually is. An
 * unmounted terminal is also the case where the agent might not exist at all. Refusing costs the
 * user one repeated phrase; guessing costs them whatever the paste executed.
 */
export function classifyTerminalRoute(i: TerminalRouteInput): TerminalRouteVerdict {
  const text = normalizeForTerminal(i.text);
  if (!text) return { kind: "refuse", reason: "empty" };
  if (!i.writable) return { kind: "refuse", reason: "not-writable" };
  // The three screen refusals, through the SHARED predicate — dictation and the concierge composer
  // ask the same question of the same screen, and a second copy here would be the one that missed
  // the next credential prompt somebody adds to the list above.
  const blocked = terminalWriteRefusal(i.viewport);
  if (blocked) return { kind: "refuse", reason: blocked };
  return { kind: "deliver", text };
}
