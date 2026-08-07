// @vitest-environment jsdom
//
// THE OVERWRITE, pinned (roborev 59728/59742). Publishing `drafts[agentId]` from the app's PTY
// writers was not enough: `Terminal.tsx` recomputes that flag from the line scanner's buffer on
// EVERY user chunk, and the scanner never saw those writes — so the publish survived only until the
// user's next NON-PRINTABLE keystroke, which is precisely what they press after a dictated phrase
// lands (arrow to position the caret, Backspace to fix a word).
//
// Every case here therefore drives `noteUserInput` — the same function `Terminal.tsx`'s `onData`
// calls — AFTER the programmatic write, and asserts through `terminalHoldsUnsentInput`, the
// predicate the compose-focus veto actually calls. A test that asserted the store immediately after
// the write, as the previous suites did, passes with the scanner still blind.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerLineScan,
  unregisterLineScan,
  noteUserInput,
  noteProgrammaticInsert,
  noteProgrammaticClear,
  noteProgrammaticSubmit,
} from "./terminalSubmit";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { terminalHoldsUnsentInput } from "../services/terminalMidCommand";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";

const AGENT = "a1";
const ARROW_LEFT = "\x1b[D"; // a CSI sequence: consumed by the scanner, appends nothing
let planted: HTMLElement[] = [];

beforeEach(() => {
  useTerminalOverlayStore.setState({ drafts: {} });
  registerLineScan(AGENT);
});

afterEach(() => {
  unregisterLineScan(AGENT);
  planted.forEach((n) => n.remove());
  planted = [];
  useTerminalOverlayStore.setState({ drafts: {} });
});

/** The key sink inside the wrapper `Terminal.tsx` renders for this agent. */
function sinkFor(agentId: string): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.setAttribute(TERMINAL_AGENT_ATTR, agentId);
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  host.appendChild(ta);
  document.body.appendChild(host);
  planted.push(host);
  return ta;
}

describe("an app write to the CLI line survives the user's next keystroke", () => {
  it("holds through an ARROW KEY after a dictated insert", () => {
    const sink = sinkFor(AGENT);
    noteProgrammaticInsert(AGENT, "deploy the thing");
    expect(terminalHoldsUnsentInput(sink)).toBe(true);

    noteUserInput(AGENT, ARROW_LEFT); // position the caret — appends nothing to the line

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });

  it("holds through a BACKSPACE, which now eats the inserted text and not an empty buffer", () => {
    const sink = sinkFor(AGENT);
    noteProgrammaticInsert(AGENT, "deploy");

    noteUserInput(AGENT, "\x7f"); // "deploy" → "deplo", still a pending line

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });

  it("STILL clears when the user actually submits the inserted line", () => {
    // The anti-over-fix: a flag that only ever rises is its own bug (the stale `true` that declines
    // every compose-focus pull). The user's Enter must still empty it.
    const sink = sinkFor(AGENT);
    noteProgrammaticInsert(AGENT, "deploy the thing");

    const submits = noteUserInput(AGENT, "\r");

    expect(submits).toBe(1); // and it counts as the prompt it is
    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("STILL clears when the user cancels with Ctrl-C", () => {
    const sink = sinkFor(AGENT);
    noteProgrammaticInsert(AGENT, "deploy the thing");

    noteUserInput(AGENT, "\x03");

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("a programmatic CLEAR is not resurrected by the next keystroke either", () => {
    // The mirror direction, and the one `/model`'s Ctrl-U produces: the user had a line, the app
    // destroyed it. A recompute from a buffer that still held their text would report a pending line
    // over an EMPTY prompt and decline every pull.
    const sink = sinkFor(AGENT);
    noteUserInput(AGENT, "hello"); // the user was mid-command
    expect(terminalHoldsUnsentInput(sink)).toBe(true);

    noteProgrammaticClear(AGENT);
    noteUserInput(AGENT, ARROW_LEFT);

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("a programmatic SUBMIT is not resurrected by the next keystroke either", () => {
    const sink = sinkFor(AGENT);
    noteUserInput(AGENT, "hello");

    noteProgrammaticSubmit(AGENT);
    noteUserInput(AGENT, ARROW_LEFT);

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("answers only for the agent it was told about", () => {
    const other = sinkFor("a2");
    noteProgrammaticInsert(AGENT, "deploy the thing");

    expect(terminalHoldsUnsentInput(other)).toBe(false);
  });

  it("an unregistered agent still gets the flag, so a pane mounted later is not lied to", () => {
    // No terminal mounted → nothing will recompute over us, but the flag outlives the pane.
    unregisterLineScan(AGENT);
    const sink = sinkFor(AGENT);

    noteProgrammaticInsert(AGENT, "deploy the thing");

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });
});

// ══ THE REGISTRY'S OWN FAILURE MODES ═════════════════════════════════════════════════════════════
// Consolidating the scanner into a Map introduced two ways to lose it that the closure-local state
// it replaced did not have. Both are reachable in the shipping app and both are SILENT — the count
// `noteUserInput` returns drives the free-trial debit, so losing the state stops metering the
// user's prompts with nothing thrown and nothing logged (roborev 59775).
describe("the registry cannot silently lose an agent's scanner", () => {
  const A = "remounting-agent";

  afterEach(() => unregisterLineScan(A));

  it("a stale teardown does not strip the LIVE scanner for the same agent", () => {
    // React mounts the replacement BEFORE running the outgoing effect's cleanup, and an account
    // switch remounts Terminal with the SAME agentId (AgentPane keys on the account, not the
    // agent). Delete-by-key therefore had the dead instance's cleanup remove the live instance's
    // state, after which every keystroke found nothing registered.
    const first = registerLineScan(A);
    const second = registerLineScan(A); // the remount
    expect(second).not.toBe(first);
    noteUserInput(A, "make me a website"); // typed into the LIVE instance

    unregisterLineScan(A, first); // the outgoing instance's cleanup, arriving late

    // CONTINUITY is the assertion, not "some state exists": `noteUserInput` creates one on a miss,
    // so a test that only checked the flag would pass against a delete-by-key too — the line would
    // simply restart empty and nobody would notice until a prompt went unmetered. The submitted
    // line must still be the one the user was typing.
    expect(noteUserInput(A, "\r")).toBe(1);
  });

  it("the LIVE instance's own teardown still unregisters", () => {
    // The anti-over-fix: an identity check that never matched would leak every scanner and keep
    // answering for a terminal that is gone.
    const state = registerLineScan(A);
    noteUserInput(A, "hello");

    unregisterLineScan(A, state);

    // ASSERTED ON THE SUBMIT COUNT, because the draft flag cannot tell the two branches apart —
    // and the first version of this case asserted exactly that and was vacuous (roborev 60086).
    // Unregistered, the next chunk starts from a FRESH line, so a bare Enter submits nothing: 0.
    // Leaked (an identity check that never matches), the retained state still holds "hello", so
    // the SAME Enter submits it: 1 — and a free-trial prompt is debited for a terminal that is
    // gone. Both branches end with an empty buffer, so `drafts` reads false either way.
    expect(noteUserInput(A, "\r")).toBe(0);
    expect(useTerminalOverlayStore.getState().drafts[A]).toBeFalsy();
  });

  it("an unregistered agent is still scanned — the miss creates the state, never returns 0", () => {
    // Fail-CLOSED. A miss used to return 0 submits, which is the free-trial debit not happening.
    unregisterLineScan(A);

    const submits = noteUserInput(A, "make me a website\r");

    expect(submits).toBe(1);
  });
});
