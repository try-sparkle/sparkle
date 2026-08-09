// Frontend bridge to the local PTY host (src-tauri/src/pty.rs). Runs the user's own
// `claude` binary (or any command) locally under their own login — Sparkle is the
// terminal-emulator UI on top, it never handles the auth token.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { noteUserInputForAgent } from "./engine/engineRegistry";
// The CLI input line is TOLD what we did to it: xterm's `onData` sees only what the user types, so
// every write this module makes to an agent's input line is invisible to the scanner that derives
// `drafts` — the flag the terminal-anchored action pill hides on and the compose-focus veto declines
// on (roborev 59689). These go through the scanner's own state rather than writing that flag
// directly, because `Terminal.tsx` recomputes it from that state on every user chunk: a publish the
// scanner disagrees with survives only until the next arrow key (roborev 59728).
import {
  noteProgrammaticInsert,
  noteProgrammaticSubmit,
} from "./components/terminalSubmit";

export interface PtyOutput {
  id: string;
  chunk: string;
  /** Authoritative UTF-8 byte length of `chunk`, as counted by Rust. Echo it back via `ptyAck`
   *  once xterm has parsed the chunk — never recompute it from `chunk.length` (UTF-16 units). */
  bytes: number;
}
export interface PtyExit {
  id: string;
  /** WHICH LIFE OF THIS AGENT DIED — the epoch `spawnPty` returned for that PTY (pty.rs
   *  `PtySession::epoch`). `pty:exit` is a global channel keyed only by agent id, and the id is the
   *  AGENT id, so it is identical across a restart: without this, a listener cannot tell its own
   *  PTY's death from the death of the PTY it replaced. Required, never optional — Rust always
   *  knows which session is exiting, and an absent value would reintroduce an "unknown epoch" case
   *  whose only safe handling is the wrong one. */
  epoch: number;
}

export interface SpawnPtyOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Spawn a command in a local PTY. Output arrives via onPtyOutput.
 *
 *  Resolves with this PTY's EPOCH — the id of this particular life of the agent. Hold it and compare
 *  it against `PtyExit.epoch`, or a restart is indistinguishable from a death (see `PtyExit.epoch`
 *  and pty.rs `PtySession::epoch`). */
export function spawnPty(opts: SpawnPtyOptions): Promise<number> {
  return invoke("pty_spawn", {
    id: opts.id,
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
  });
}

// A PTY can exit (and have its session reaped on the Rust side) a beat before a stray
// keystroke or a ResizeObserver-driven resize reaches it — pty_write / pty_resize then
// return Err("no such pty"). Callers fire these and forget, so an un-caught rejection would
// surface as an app-level "unhandled rejection" ERROR (logger.ts) and flood the log. That's
// an expected teardown race, not a real failure, so swallow exactly this error and let any
// other error propagate.
function isExitedPtyError(e: unknown): boolean {
  return String((e as { message?: string })?.message ?? e).includes("no such pty");
}

function ignoreExitedPty(e: unknown): void {
  if (!isExitedPtyError(e)) throw e;
}

/** Write to a PTY's stdin — e.g. approve ("y\n") / deny ("n\n") or user keystrokes. */
export function writePty(id: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { id, data }).catch(ignoreExitedPty);
}

/** The agent's PTY is gone, so a write that the user explicitly asked for did NOT land.
 *  Distinct from the swallowed teardown race above: callers that represent a deliberate user
 *  action must surface this instead of pretending it succeeded. Carries the agent id so the
 *  caller can offer/perform a restart. */
export class PtyGoneError extends Error {
  constructor(readonly id: string) {
    super(`no such pty: ${id}`);
    this.name = "PtyGoneError";
  }
}

/** Strict write: a dead PTY is a REAL failure the caller must handle, not a swallowed no-op.
 *  Any other error propagates unchanged. */
async function writePtyStrict(id: string, data: string): Promise<void> {
  try {
    await invoke<void>("pty_write", { id, data });
  } catch (e) {
    if (isExitedPtyError(e)) throw new PtyGoneError(id);
    throw e;
  }
}

// Bracketed-paste wrappers and their filter now live in the LEAF module `./pasteMarkers`, and are
// re-exported here so every existing `from "../pty"` importer is unchanged.
//
// They moved because this module is the one 45 suites stub with a wholesale
// `vi.mock("../pty", () => ({ … }))`. Anything reaching `stripPasteMarkers` THROUGH here became
// `undefined` in those suites — a security filter that silently vanishes wherever the PTY is faked.
// A leaf with no imports of its own cannot be collaterally stubbed. See `pasteMarkers.ts`.
import { PASTE_START, PASTE_END, stripPasteMarkers } from "./pasteMarkers";
export { PASTE_START, PASTE_END, stripPasteMarkers } from "./pasteMarkers";

/** Gap between the bracketed paste and the carriage return, so the CLI has finished ingesting
 *  the paste before the Enter arrives. */
const SUBMIT_CR_DELAY_MS = 60;

/** Per-agent chain for MULTI-WRITE PTY operations, so two of them can't interleave their writes.
 *  THE ONE chain for this agent — `services/agentModel` used to run a second, disjoint one of its
 *  own, which gave no ordering guarantee against this one at all (roborev 54387).
 *
 *  Every operation that is not a single atomic write belongs on this chain, and so does every
 *  operation that must not land in the MIDDLE of one — which is why a no-submit paste is queued
 *  here too, not just a submit. {@link deliverSubmit} deliberately leaves SUBMIT_CR_DELAY_MS
 *  between its paste and its carriage return; an unchained write landing inside that window is
 *  appended to the in-flight prompt and then submitted BY that pending CR. For a dropped file that
 *  means a turn the user never pressed Enter on, carrying paths they never approved, while the
 *  confirmation says nothing has been sent (roborev 54369). */
const ptyWriteChains = new Map<string, Promise<void>>();

/**
 * Queue a whole PTY OPERATION behind whatever is already in flight for this agent, and return ITS
 * promise (not the swallowed tail) so the caller still sees a failure.
 *
 * Exported for operations this module does not own — `services/agentModel`'s `/model` delivery,
 * whose type-then-wait-200ms-then-Enter sequence is the widest paste→CR window in the app and so
 * has the most to lose from an interleaved write (and the most to break with one of its own).
 */
export function chainPtyOp(id: string, run: () => Promise<void>): Promise<void> {
  const prev = ptyWriteChains.get(id) ?? Promise.resolve();
  // A rejected predecessor must not wedge the chain for the next write, so queue behind its
  // settlement rather than its success.
  const p = prev.then(run);
  const tail = p.catch(() => {});
  ptyWriteChains.set(id, tail);
  // Drop the entry once this agent's queue drains, so the map doesn't grow per agent forever.
  void tail.then(() => {
    if (ptyWriteChains.get(id) === tail) ptyWriteChains.delete(id);
  });
  return p;
}

/**
 * A single PROGRAMMATIC write, queued on the per-agent chain — the picker answer, an auto-approve
 * keystroke, a relayed phone keystroke.
 *
 * Being atomic is not enough to make a write safe (roborev 54375). These payloads carry their OWN
 * carriage return (`frameSubmit` produces `"2\r"`), so one landing inside another operation's
 * paste→CR window appends its digit to the in-flight prompt, submits that mutated prompt with the
 * pending CR, and leaves the picker it meant to answer unanswered. `services/requery.ts` submits
 * with no user action at all, so that window opens on its own.
 *
 * Deliberately NOT for live keystrokes from xterm's `onData`: those are the user typing, in real
 * time, at a terminal they are looking at — serializing them behind a background submit would
 * reorder what they typed.
 *
 * Keeps {@link writePty}'s tolerant handling of the "no such pty" teardown race.
 */
export function writePtyChained(id: string, data: string): Promise<void> {
  return chainPtyOp(id, () => writePty(id, data));
}

/**
 * The STRICT chained single write: same queueing, but a dead PTY REJECTS with PtyGoneError instead
 * of resolving as if it landed.
 *
 * For a write that represents a DELIBERATE USER ACTION whose caller reports success — the concierge
 * picker answer. The tolerant variant above cannot fail, so a caller that catches PtyGoneError
 * around it has an unreachable branch and reports a delivery that never happened (roborev 54387) —
 * exactly the failure {@link submitPrompt} was made strict to prevent. Fire-and-forget writes
 * (auto-approve, the phone relay) keep the tolerant one: nothing is claiming success on their
 * behalf, and the teardown race is noise there.
 */
export function writePtyChainedStrict(id: string, data: string): Promise<void> {
  return chainPtyOp(id, () => writePtyStrict(id, data));
}

/**
 * Insert text at the agent's CURRENT input line and stop — one bracketed paste, no carriage
 * return. The user is left with the text sitting in the CLI's prompt, free to type around it and
 * press Enter themselves.
 *
 * Queued on the per-agent write chain, so it can never land between another write's paste and its
 * carriage return and be submitted by it — see {@link ptyWriteChains}.
 *
 * REJECTS with PtyGoneError when the PTY is dead, like {@link submitPrompt} and for the same
 * reason: this is a deliberate user action (a drop, a menu pick), so "it went nowhere" has to be
 * reportable rather than swallowed as the teardown race {@link writePty} tolerates.
 */
export function pasteIntoPty(id: string, text: string): Promise<void> {
  const body = stripPasteMarkers(text);
  return chainPtyOp(id, async () => {
    await writePtyStrict(id, `${PASTE_START}${body}${PASTE_END}`);
    // The prompt now HOLDS this text, and nothing else will say so. Left untold, the dictation
    // sink's whole contract — "it types, it does not submit, the human's Enter is the consent" —
    // produced a terminal holding unsent words that the compose-focus veto read as idle and pulled
    // the caret out of: sparkle-d2ec's own symptom, in the scenario the guard was written for.
    //
    // APPENDED TO THE SCANNER'S BUFFER, not published as a bare flag. The two differ the moment the
    // user presses a non-printable key: `Terminal.tsx` recomputes the flag from that buffer on every
    // chunk, so an arrow key or a Backspace against the pasted line would write `false` straight
    // back over a bare publish while the words were still on screen (roborev 59728). Appending also
    // makes those edits behave — a Backspace now deletes from the pasted text rather than from an
    // empty buffer.
    //
    // After the await, so a paste that never landed (PtyGoneError on a dead PTY) claims nothing.
    if (body !== "") noteProgrammaticInsert(id, body);
  });
}

async function deliverSubmit(id: string, text: string, machine?: boolean): Promise<void> {
  // Bug B: a user-submitted message is the strongest recovery signal — a new turn is starting, so
  // any prior stall/error latched from earlier output is stale. Tell the StatusEngine BEFORE the
  // text lands (and echoes back through pty:output) so a resuming agent goes green and its own echo
  // isn't mistaken for a self-prompt wedge. No-op when no engine is registered for this id.
  // `machine` says nobody typed this (an auto-resume, a retry ping). The text is still recorded so
  // its echo isn't read as a self-prompt wedge, but a machine send does not get to claim the
  // human-presence authority that clears a quota wall — see StatusEngine.noteUserInput.
  noteUserInputForAgent(id, text, { machine: machine === true });
  // Marker-stripped like every other paste this module frames. A no-op for composer-typed text, and
  // NOT a no-op for submitPrompt's untrusted-text callers — the concierge free-text path and
  // conciergeTools' sendToAgentTerminal carry phone-relayed and model-authored strings, which could
  // close bracketed-paste mode mid-payload and have their tail read as KEYSTROKES (roborev 2197,
  // reopened here at 54397: the guard existed only in one caller, selectionActions.fixInAgent).
  await writePtyStrict(id, `${PASTE_START}${stripPasteMarkers(text)}${PASTE_END}`);
  await new Promise((r) => setTimeout(r, SUBMIT_CR_DELAY_MS));
  await writePtyStrict(id, "\r");
  // The CR submitted the WHOLE line — this text and anything the user had already typed in front of
  // it — so the prompt is empty again. Told to the scanner for the same reason as the paste above
  // and with the opposite effect: it cannot see this CR, so a buffer left holding the user's own
  // half-typed line would keep answering `true` (nothing resets it short of unmount) and decline
  // every compose-focus pull with the caret in this terminal for that whole window — the roborev
  // 59610 High, reproduced through the writer gap.
  noteProgrammaticSubmit(id);
}

/** Submit a full prompt to an agent's PTY: deliver it as one bracketed paste, then (after a
 *  beat, so the CLI has finished ingesting the paste) a carriage return to send it. Shared by
 *  the composer and the connectivity re-query.
 *
 *  REJECTS with PtyGoneError if the agent's PTY is dead. This is deliberate: the prompt did not
 *  land, and silently resolving here is what let a dead agent swallow user prompts while the
 *  composer recorded them into history as if they'd been delivered. Callers must handle it. */
/**
 * Submit a prompt to an agent's terminal.
 *
 * `machine` IS REQUIRED, NOT OPTIONAL WITH A DEFAULT, and that is the point (the same
 * required-but-explicit shape `decideContinuation.processAlive` uses, and for the same reason). It
 * says whether a PERSON typed this. `StatusEngine.noteUserInput` treats a human send as the
 * strongest recovery signal there is and releases an account-limit wall on it — so a default would
 * decide that question by omission, and every sender added later would silently claim human presence.
 *
 * That is not hypothetical: the first cut made it optional and defaulted to human, which closed the
 * hole on the dispatch paths while leaving `requery` — whose `SAFE_TO_REQUERY` set explicitly
 * contains `"blocked"` — firing at quota-walled rows on every offline→online transition and clearing
 * the very red it had just painted. Making it required turns "I forgot" into a compile error instead
 * of a silent regression of the bug this file was changed to fix.
 */
export function submitPrompt(
  id: string,
  text: string,
  opts: { machine: boolean },
): Promise<void> {
  return chainPtyOp(id, () => deliverSubmit(id, text, opts.machine));
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { id, cols, rows }).catch(ignoreExitedPty);
}

/** Pause or resume the PTY's reader for flow control (). Fire-and-forget: the frontend
 *  calls this when its xterm write backlog crosses the high/low-water marks (see terminalFlow.ts);
 *  the benign "no such pty" teardown race is swallowed like the other PTY ops. */
export function setPtyPaused(id: string, paused: boolean): Promise<void> {
  return invoke<void>("pty_set_paused", { id, paused }).catch(ignoreExitedPty);
}

export function killPty(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

/** Return `bytes` of IPC emit credit for a PTY, once xterm has PARSED that chunk. The Rust flusher
 *  parks past a per-PTY ceiling of un-acked bytes, which is what actually bounds the (otherwise
 *  unbounded) Tauri IPC queue — see pty.rs `InflightState` and terminalFlow.ts `PtyAckBatcher`.
 *  Fire-and-forget; the benign "no such pty" teardown race is swallowed like the other PTY ops. */
export function ptyAck(id: string, bytes: number): Promise<void> {
  return invoke<void>("pty_ack", { id, bytes }).catch(ignoreExitedPty);
}

/** Channel prefix for per-agent PTY output. Kept in sync with `output_event()` in pty.rs. */
export const PTY_OUTPUT_EVENT_PREFIX = "pty:output:";

/**
 * Subscribe to ONE agent's PTY output. Returns an unlisten fn.
 *
 * Targeted by design: output used to be emitted app-wide with every terminal registering a global
 * listener and filtering by id after delivery, so each chunk was materialized and dispatched to all
 * N terminals to be discarded by N-1 of them. Rust now emits on a per-agent channel, so only the
 * owning subscriber is ever invoked. Callers that follow several agents (the phone relay) subscribe
 * once per agent rather than once globally.
 */
export function onPtyOutput(id: string, cb: (e: PtyOutput) => void): Promise<UnlistenFn> {
  return listen<PtyOutput>(`${PTY_OUTPUT_EVENT_PREFIX}${id}`, (ev) => cb(ev.payload));
}

/** Subscribe to PTY exit. Returns an unlisten fn. */
export function onPtyExit(cb: (e: PtyExit) => void): Promise<UnlistenFn> {
  return listen<PtyExit>("pty:exit", (ev) => cb(ev.payload));
}

export type { WorktreeInfo } from "./services/worktree";
import type { WorktreeInfo } from "./services/worktree";

export function createWorkerWorktree(args: {
  root: string; projectId: string; workerId: string; parentBranch: string;
}): Promise<WorktreeInfo> {
  return invoke("create_worker_worktree", {
    root: args.root, projectId: args.projectId,
    workerId: args.workerId, parentBranch: args.parentBranch,
  });
}

export function readWorkerResult(worktree: string): Promise<string | null> {
  return invoke("read_worker_result", { worktree });
}

/**
 * Swallow the benign "no such pty" race for fire-and-forget writes/resizes/kills.
 * A late resize after an agent exits, or input racing PTY teardown, rejects with
 * "no such pty" — the PTY is simply gone, nothing to do. Anything else is
 * unexpected and gets logged rather than silently dropped. The matched literal is
 * the NO_SUCH_PTY constant in src-tauri/src/pty.rs; keep the two in sync. Use as:
 *   void resizePty(id, c, r).catch(ignorePtyGone);
 */
export function ignorePtyGone(err: unknown): void {
  const msg = typeof err === "string" ? err : (err as { message?: string })?.message ?? String(err);
  if (msg.includes("no such pty")) return;
  console.error("pty operation failed:", err);
}
