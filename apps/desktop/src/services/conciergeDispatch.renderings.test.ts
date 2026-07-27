// The three renderings of one prompt (roborev 46911/46925).
//
// A concierge send with attachments produces three DIFFERENT strings — the wire payload (paths +
// text), the display (counts), and the naming basis (typed text only) — and each has exactly one
// legitimate destination. Collapsing them onto the payload is invisible in the concierge thread,
// which renders the display, and shows up only in the OTHER prompt surfaces: the pinned header,
// the history dropdown, the ghost-suggestion corpus, and the agent auto-name. Nothing tested those
// surfaces, which is how `/tmp/sparkle-shot-1753.png what is wrong here?` reached all four.
//
// These tests assert on the destinations rather than the plumbing: no store call may ever see a
// path, whichever route the send takes (delivered now, or queued and flushed later).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

const h = vi.hoisted(() => ({
  appendPrompt: vi.fn((_p: string, _a: string, _text: string, _source?: string) => "prompt-1"),
  record: vi.fn((_text: string) => {}),
  maybeAutoName: vi.fn(async (_p: string, _a: string, _basis: string) => {}),
  markAgentPrompt: vi.fn(),
  paneState: vi.fn(() => "ready" as string),
  submitPrompt: vi.fn(async (_id: string, _text: string) => {}),
}));

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return { writePty: vi.fn(async () => {}), submitPrompt: h.submitPrompt, PtyGoneError };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));
vi.mock("./terminalMarkers", () => ({ markAgentPrompt: h.markAgentPrompt }));
vi.mock("./agentNaming", () => ({ maybeAutoName: h.maybeAutoName }));
vi.mock("./trialMeter", () => ({
  recordTrialSend: vi.fn(async () => {}),
  trialSendAllowed: vi.fn(() => true),
}));
vi.mock("./aiGate", () => ({ aiFeatureNow: vi.fn(() => true) }));
vi.mock("./paneReadiness", () => ({ paneState: h.paneState }));
vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", agents: [{ id: "a1", runtime: "local" }] }],
      appendPrompt: h.appendPrompt,
    }),
  },
}));
vi.mock("../stores/promptHistoryStore", () => ({
  usePromptHistoryStore: { getState: () => ({ record: h.record }) },
}));

import { PtyGoneError } from "../pty";
import { dispatchConciergeAnswer, flushPendingSends } from "./conciergeDispatch";
import { resetPendingSends } from "./pendingSends";

/** Any valid authority. These suites predate the dispatch authority gate and exercise DELIVERY,
 *  not authorization — the gate itself is covered by dispatchAuthority.test.ts and
 *  conciergeDispatch.gate.test.ts. `authority` is required and non-defaulted (see
 *  services/dispatchAuthority), so every call has to name one. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

const SHOT = "/var/folders/x9/T/sparkle-shot-1753.png";
// What ConciergeHost builds for "look at this" + one screenshot.
const PAYLOAD = `'${SHOT}' look at this`;
const DISPLAY = "look at this · 1 image";
const TYPED = "look at this";

/** Every string any user-visible prompt surface was handed, across all four side-effects. */
function surfacedStrings(): string[] {
  return [
    ...h.appendPrompt.mock.calls.map((c) => c[2]),
    ...h.record.mock.calls.map((c) => c[0]),
    ...h.maybeAutoName.mock.calls.map((c) => c[2]),
  ];
}

beforeEach(() => {
  resetPendingSends();
  h.paneState.mockReturnValue("ready");
  h.submitPrompt.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("conciergeDispatch — payload / display / naming basis stay separate", () => {
  it("writes the PAYLOAD to the PTY but never lets a path reach a prompt surface", async () => {
    const r = await dispatchConciergeAnswer("a1", PAYLOAD, {
      authority: TEST_AUTHORITY,
      userPrompt: true,
      display: DISPLAY,
      namingBasis: TYPED,
    });

    expect(r.ok).toBe(true);
    // The agent still reads the file from disk — the payload is unchanged on the wire.
    expect(h.submitPrompt).toHaveBeenCalledWith("a1", PAYLOAD);
    for (const s of surfacedStrings()) expect(s).not.toContain(SHOT);
    expect(surfacedStrings().length).toBeGreaterThan(0);
  });

  it("routes each rendering to its own destination", async () => {
    await dispatchConciergeAnswer("a1", PAYLOAD, {
      authority: TEST_AUTHORITY,
      userPrompt: true,
      display: DISPLAY,
      namingBasis: TYPED,
    });

    // The pinned header and history dropdown render this verbatim.
    expect(h.appendPrompt).toHaveBeenCalledWith("p1", "a1", DISPLAY);
    // Ghost text and the naming model learn from what was TYPED.
    expect(h.record).toHaveBeenCalledWith(TYPED);
    expect(h.maybeAutoName).toHaveBeenCalledWith("p1", "a1", TYPED);
  });

  it("an ATTACHMENTS-ONLY send is never auto-named from a temp path", async () => {
    // The composer skipped naming by construction here: the basis is empty because nothing was
    // typed. Collapsed onto the payload, the model would instead be asked to name the agent after
    // a bare `/var/folders/...png`.
    await dispatchConciergeAnswer("a1", `'${SHOT}'`, {
      authority: TEST_AUTHORITY,
      userPrompt: true,
      display: "1 image",
      namingBasis: "",
    });

    expect(h.maybeAutoName).not.toHaveBeenCalled();
    expect(h.appendPrompt).toHaveBeenCalledWith("p1", "a1", "1 image");
    for (const s of surfacedStrings()) expect(s).not.toContain(SHOT);
  });

  it("defaults both renderings to the wire text when nothing was attached", async () => {
    await dispatchConciergeAnswer("a1", "just words", { authority: TEST_AUTHORITY, userPrompt: true });

    expect(h.appendPrompt).toHaveBeenCalledWith("p1", "a1", "just words");
    expect(h.record).toHaveBeenCalledWith("just words");
    expect(h.maybeAutoName).toHaveBeenCalledWith("p1", "a1", "just words");
  });

  it("a machine-authored relay still records nothing at all", async () => {
    await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY, userPrompt: false });
    expect(surfacedStrings()).toEqual([]);
  });

  it("carries the renderings across a QUEUED hold, so a flushed send is no leakier", async () => {
    // The PTY isn't up yet: the send is held, then delivered when the pane reports ready.
    h.paneState.mockReturnValue("starting");
    h.submitPrompt.mockRejectedValueOnce(new PtyGoneError("not up"));

    const queued = await dispatchConciergeAnswer("a1", PAYLOAD, {
      authority: TEST_AUTHORITY,
      userPrompt: true,
      display: DISPLAY,
      namingBasis: TYPED,
    });
    expect(queued.path).toBe("queued");
    // Held, not delivered — so nothing has been recorded yet.
    expect(surfacedStrings()).toEqual([]);

    h.paneState.mockReturnValue("ready");
    await flushPendingSends("a1");

    expect(h.appendPrompt).toHaveBeenCalledWith("p1", "a1", DISPLAY);
    expect(h.maybeAutoName).toHaveBeenCalledWith("p1", "a1", TYPED);
    for (const s of surfacedStrings()) expect(s).not.toContain(SHOT);
  });

  it("a PICKER answer reports the option LABEL, never the keystroke frame", async () => {
    // `sent` on this path is "2\r" / "y\r". `display` is documented as present whenever `sent`
    // is, and this was the one return that broke that promise (roborev 49293/49294) — a caller
    // that trusted it would quote a control character at the user.
    const { detectTerminalPrompts } = await import("./suggestions/heuristics");
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: "1", label: "Yes, proceed", value: "y\n", kind: "terminal", source: "heuristic" },
    ]);
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("picker-option");
    expect(r.display).toBe("Yes, proceed");
    expect(r.sent).not.toBe(r.display);
  });

  it("reports a safe `display` on every outcome the concierge quotes back", async () => {
    h.paneState.mockReturnValue("starting");
    h.submitPrompt.mockRejectedValueOnce(new PtyGoneError("not up"));
    const queued = await dispatchConciergeAnswer("a1", PAYLOAD, {
      authority: TEST_AUTHORITY,
      userPrompt: true,
      display: DISPLAY,
      namingBasis: TYPED,
    });

    // ConciergeHost quotes `display` in "I sent your message (…)" — quoting `sent` would print the
    // temp path into the thread, the one surface the display rendering exists to protect.
    expect(queued.display).toBe(DISPLAY);
    expect(queued.sent).toBe(PAYLOAD);
  });
});
