// `select_picker_option` on a MULTI-SELECT checkbox picker — bead sparkle-xkf6yl.
//
// ══ THE FIELD REPORT, WHICH IS ALSO THE SPEC FOR THE FAKE WIDGET BELOW ════════════════════════
// Reproduced twice against a live Claude Code plan-mode wizard with a multi-select checkbox
// question, with `read_picker_options` read-backs as the evidence:
//
//   1. read_picker_options            → all five rows unchecked, cursor on row 1.
//   2. select_picker_option index=0   → row 1 becomes [✓].                        CORRECT.
//   3. select_picker_option index=1   → the tool REPORTED "2 · [ ] Already-hosted URLs",
//                                       and the screen came back with row 1 UNCHECKED again.
//                                       Row 2 was never touched.
//   4. select_picker_option index=0   → row 1 checked again.                      CORRECT.
//
// So on this widget the digit the press writes is INERT, and the carriage return that follows it
// TOGGLES THE HIGHLIGHTED ROW — whichever row that is. The op reported the requested index's label
// back either way, which is the dangerous half: a caller that trusts the returned label believes it
// selected option 2 when it actually toggled option 1 back OFF.
//
// ══ WHY THIS SUITE FAKES THE WIDGET, AND WHAT MAKES THAT LEGITIMATE ═══════════════════════════
// AGENTS.md: "A test that proves a FALLBACK must FIRST assert the real tool actually FAILS that
// way — or the fallback is verified against a fiction." The production path writes bytes into a PTY
// and reads a rendered screen back; there is no Ink widget in this process to receive them. So the
// fake below is written from the MEASURED transcript above, not from how one imagines an Ink
// multi-select behaves — digits inert, `\r` toggles the row under the cursor, arrows move the
// cursor — and the FIRST test in this file drives it with the exact steps 2-4 above and asserts it
// reproduces the reported bug. Nothing else here is trusted until that one passes.
//
// The assertions that follow are on the RENDERED SCREEN — which row carries `[✓]` afterwards — not
// on the bytes written and not on `ok: true`. "An option got selected" passes on the buggy code and
// is worthless; the property is that the option at the REQUESTED INDEX is the one that changed and
// the highlighted one did not.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pty", () => ({
  // `resizePty` is reached through `services/forceRedraw`, which `conciergeTools/terminal`
  // now imports for its pre-send frame repair. A factory mock REPLACES the module, so an
  // omitted export is a hard load error for the whole suite, not a missing stub.
  resizePty: vi.fn(async () => {}),
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn<(id: string) => string | null>(() => null),
}));
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: {
    getState: vi.fn(() => ({ attentionScreen: {}, attentionScreenAt: {}, status: {} })),
  },
  mergeOpenAgentIds: (inMemory: string[], persisted: string[]) => [
    ...new Set([...inMemory, ...persisted]),
  ],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { writePtyChainedStrict } from "../../pty";
import { getAgentScrollback } from "../terminalScrollback";
import { useProjectStore } from "../../stores/projectStore";
import { useInteractionStore } from "../../stores/interactionStore";
import { conciergeToolAuthority } from "../dispatchAuthority";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";
// THE REAL LATCH, not a mock of it — the same seam the sibling suite drives this gate through.
import { claimPass, releasePass } from "../improvementPassLatch";
import { readPickerOptions, selectPickerOption } from "./terminal";

const AGENT = "ag-multi";
const ALLOWED = conciergeToolAuthority("call-multi", { tier: "allow" })!;
const scrollbackMock = vi.mocked(getAgentScrollback);
const writeMock = vi.mocked(writePtyChainedStrict);

/**
 * How the widget treats a DIGIT. Two Claude Code builds have been measured, and they disagree:
 *   • `"inert"`  — the sparkle-xkf6yl field report above: a digit does nothing.
 *   • `"toggle"` — Claude Code 2.1.310, measured 2026-10-24 for bead sparkle-5i7e8x.2 (transcript
 *     in the "NO-OP PRESS" block below): a digit toggles ITS OWN numbered row and leaves the cursor
 *     where it was.
 * In BOTH builds `\r` and space toggle the row under the cursor and the arrows move it.
 */
type DigitMode = "inert" | "toggle";

/**
 * A Claude Code multi-select checkbox picker, driven by the bytes the production path writes.
 *
 * Its rules are the facts the field reports MEASURED, and nothing more:
 *   • `\x1b[B` / `\x1b[A` move the cursor (clamped at the ends, as an Ink list is).
 *   • `\r` (and space) TOGGLES the row under the cursor. It does not commit and it does not close
 *     the menu — step 3 of the report read the menu back afterwards, still open, with a row flipped.
 *   • a DIGIT is inert or toggles its own row, per {@link DigitMode}.
 *   • every other byte is inert.
 */
class MultiSelectWidget {
  cursor: number;
  readonly checked: boolean[];
  constructor(
    readonly question: string,
    readonly labels: readonly string[],
    cursor = 0,
    readonly digits: DigitMode = "toggle",
  ) {
    this.cursor = cursor;
    this.checked = labels.map(() => false);
  }

  feed(bytes: string): void {
    let i = 0;
    while (i < bytes.length) {
      if (bytes.startsWith("\x1b[B", i)) {
        this.cursor = Math.min(this.cursor + 1, this.labels.length - 1);
        i += 3;
      } else if (bytes.startsWith("\x1b[A", i)) {
        this.cursor = Math.max(this.cursor - 1, 0);
        i += 3;
      } else if (bytes[i] === "\r" || bytes[i] === "\n" || bytes[i] === " ") {
        this.checked[this.cursor] = !this.checked[this.cursor];
        i += 1;
      } else if (/[1-9]/.test(bytes[i]!) && this.digits === "toggle") {
        const row = Number(bytes[i]) - 1;
        if (row < this.labels.length) this.checked[row] = !this.checked[row];
        i += 1;
      } else {
        i += 1; // inert
      }
    }
  }

  /** The screen, in the shape the detector parses: a question, cursored `N. [ ] label` rows, a
   *  footer. */
  render(): string {
    return [
      this.question,
      ...this.labels.map(
        (l, i) =>
          `${i === this.cursor ? "❯" : " "} ${i + 1}. [${this.checked[i] ? "✔" : " "}] ${l}`,
      ),
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
  }

  /** The rows carrying a tick, by index — what a human would say got SELECTED. */
  selected(): number[] {
    return this.checked.flatMap((c, i) => (c ? [i] : []));
  }
}

/** Wire a widget up so every PTY write drives it and every scrollback read renders it. */
function mount(w: MultiSelectWidget): void {
  scrollbackMock.mockImplementation(() => w.render());
  writeMock.mockImplementation(async (_id: string, bytes: string) => {
    w.feed(bytes);
  });
}

const QUESTION = "Which image sources should I use for this post?";
const LABELS = ["Local files", "Already-hosted URLs", "Generated images"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  scrollbackMock.mockReturnValue(null);
  useInteractionStore.setState({ lastAt: {} } as never);
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: AGENT, name: "Publishing images", runtime: "local" } as never],
      } as never,
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FAKE IS FAITHFUL FIRST — see the header. Everything below this test rests on it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the fake widget reproduces the measured field behaviour", () => {
  it("ignores the digit and toggles whatever row the cursor is on", () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "inert");

    w.feed("1\r"); // report step 2: cursor on row 1 → row 1 checked
    expect(w.selected()).toEqual([0]);

    w.feed("2\r"); // report step 3: the digit does nothing, the CR toggles row 1 back OFF
    expect(w.selected()).toEqual([]);
    expect(w.cursor).toBe(0);

    w.feed("1\r"); // report step 4: row 1 checked again
    expect(w.selected()).toEqual([0]);
  });

  // ══ THE 2.1.310 MEASUREMENT (bead sparkle-5i7e8x.2) ══════════════════════════════════════════
  // Measured by driving a REAL `claude` 2.1.310 in a PTY (pyte-rendered) through an
  // AskUserQuestion multiSelect with options Apple/Banana/Cherry, cursor on row 1, one key at a time:
  //   "1"        → row 1 [✔], cursor still on row 1       (the digit toggles ITS row)
  //   "\r"       → row 1 [ ]                             (enter toggles the HIGHLIGHTED row)
  //   " "        → row 1 [✔]                             (space does too)
  //   "\x1b[B"   → cursor on row 2, nothing toggled
  //   "\r"       → row 2 [✔]
  //   "3"        → row 3 [✔], cursor still on row 2
  //   "1\r"      → row 1 [ ] AND row 2 [ ]               (both halves toggle — two rows flipped)
  // So the old press `"1\r"` with the cursor on row 1 toggles row 1 TWICE: nothing changes, the
  // fingerprint is identical, and the op said ok — the exact symptom the bead reported.
  it("on 2.1.310 a digit toggles its own row, so `N\\r` on the highlighted row is a no-op", () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    w.feed("1");
    expect([w.selected(), w.cursor]).toEqual([[0], 0]);
    w.feed("\r");
    expect(w.selected()).toEqual([]);
    w.feed(" ");
    expect(w.selected()).toEqual([0]);
    w.feed("\x1b[B\r");
    expect([w.selected(), w.cursor]).toEqual([[0, 1], 1]);
    w.feed("3");
    expect([w.selected(), w.cursor]).toEqual([[0, 1, 2], 1]);
    w.feed("1\r");
    expect(w.selected()).toEqual([2]);

    const fresh = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    fresh.feed("1\r");
    expect(fresh.selected(), "the old press is a double toggle — nothing changes").toEqual([]);
  });

  it("renders a screen the picker detector reads as a live multi-select menu", () => {
    mount(new MultiSelectWidget(QUESTION, LABELS, 0));
    const read = readPickerOptions(AGENT);
    expect(read.present).toBe(true);
    expect(read.options.map((o) => o.label)).toEqual([
      "1 · [ ] Local files",
      "2 · [ ] Already-hosted URLs",
      "3 · [ ] Generated images",
    ]);
    expect(read.fingerprint).not.toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DEFECT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Run against BOTH measured builds: the fix must not depend on which way a digit behaves.
describe.each(["toggle", "inert"] as const)(
  "select_picker_option on a multi-select checkbox picker (digits %s)",
  (digits) => {
  // THE assertion this bead exists for. The highlighted row is index 0 and the caller asks for
  // index 2, so a press that lands on the highlighted row cannot pass by accident — and both halves
  // are asserted, because "something got selected" is exactly what the buggy code also does.
  it("selects the option at the REQUESTED index, not the highlighted one", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, digits);
    mount(w);
    const read = readPickerOptions(AGENT);

    const r = await selectPickerOption(AGENT, 2, read.fingerprint, ALLOWED);

    expect(r.ok, r.detail ?? "press was refused").toBe(true);
    expect(w.selected(), "the requested row, and only it, is ticked").toEqual([2]);
    expect(w.checked[0], "the highlighted row must NOT have been toggled").toBe(false);
  });

  // The same property in the other direction: the cursor has to be able to walk UP as well, or an
  // index below the highlight is unreachable and the op silently answers the wrong question again.
  it("walks the cursor UP when the requested index is above the highlighted row", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 2, digits);
    mount(w);
    const read = readPickerOptions(AGENT);

    const r = await selectPickerOption(AGENT, 0, read.fingerprint, ALLOWED);

    expect(r.ok, r.detail ?? "press was refused").toBe(true);
    expect(w.selected()).toEqual([0]);
    expect(w.checked[2], "the highlighted row must NOT have been toggled").toBe(false);
  });

  // The index the cursor is ALREADY on still works, and is not double-toggled by a navigation step
  // that should not have happened.
  it("selects the highlighted row when that is the row asked for", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 1, digits);
    mount(w);
    const read = readPickerOptions(AGENT);

    const r = await selectPickerOption(AGENT, 1, read.fingerprint, ALLOWED);

    expect(r.ok, r.detail ?? "press was refused").toBe(true);
    expect(w.selected()).toEqual([1]);
  });

  // Answering TWICE is the whole point of a multi-select, and it is where an off-by-one in the
  // navigation shows up: the second press starts from wherever the first one left the cursor.
  it("accumulates ticks across successive presses, each on its own index", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, digits);
    mount(w);

    const first = await selectPickerOption(AGENT, 2, readPickerOptions(AGENT).fingerprint, ALLOWED);
    expect(first.ok, first.detail ?? "first press was refused").toBe(true);
    const second = await selectPickerOption(AGENT, 0, readPickerOptions(AGENT).fingerprint, ALLOWED);
    expect(second.ok, second.detail ?? "second press was refused").toBe(true);

    expect(w.selected()).toEqual([0, 2]);
  });

  // A REFUSAL, NOT A GUESS, when the cursor cannot be located. Without the highlight there is no
  // way to know how far to walk, and pressing anyway is the original defect — a toggle landing on
  // an unknown row while the tool reports the requested label back as if it had been chosen.
  it("refuses rather than pressing blind when no row carries the cursor", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, digits);
    // A screen with the same options and NO cursor glyph on any row.
    scrollbackMock.mockImplementation(() => w.render().replace(/❯/g, " "));
    writeMock.mockImplementation(async (_id: string, bytes: string) => w.feed(bytes));
    const read = readPickerOptions(AGENT);

    const r = await selectPickerOption(AGENT, 2, read.fingerprint, ALLOWED);

    expect([r.ok, r.reason]).toEqual([false, "cursor-unknown"]);
    expect(w.selected(), "nothing may be toggled on a blind press").toEqual([]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  // ══ THE STALE CURSOR ABOVE THE LIVE MENU (roborev 74100) ═══════════════════════════════════════
  // A Claude Code pane routinely carries earlier, already-answered dialogs in its scrollback. An
  // unbounded search for "the last row carrying a cursor" finds ONE OF THOSE when the live menu's
  // own highlight cannot be read — and then walks the cursor by a distance computed from a
  // different question's row, toggling the wrong box while the `cursor-unknown` refusal, which is
  // the whole safety property here, becomes unreachable. The locator must stay inside the block the
  // PARSE used, so the answer is a refusal.
  it("does not take its highlight from an already-answered picker higher in the scrollback", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, digits);
    const stale = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "I'll use the sources you pick.",
    ].join("\n");
    // The LIVE menu below it draws no cursor this can read; the stale one above it does.
    scrollbackMock.mockImplementation(() => `${stale}\n${w.render().replace(/❯/g, " ")}`);
    writeMock.mockImplementation(async (_id: string, bytes: string) => w.feed(bytes));
    const read = readPickerOptions(AGENT);
    // Guard the fixture itself: the read must be the MULTI-SELECT, not the stale yes/no above it.
    expect(read.options.map((o) => o.label)).toEqual([
      "1 · [ ] Local files",
      "2 · [ ] Already-hosted URLs",
      "3 · [ ] Generated images",
    ]);

    const r = await selectPickerOption(AGENT, 2, read.fingerprint, ALLOWED);

    expect([r.ok, r.reason]).toEqual([false, "cursor-unknown"]);
    expect(w.selected(), "nothing may be toggled off a stale cursor").toEqual([]);
    expect(writeMock).not.toHaveBeenCalled();
  });

  // ══ A REFUSAL NEVER WROTE A BYTE — INCLUDING THE ARROWS (roborev 74100) ════════════════════════
  // The walk is a real mutation of the agent's screen, so it must not run ahead of a gate that can
  // still refuse the press. `sparkle-busy` is exactly such a gate: it lives in `sendToAgentTerminal`
  // itself, one call BELOW where the walk used to be written, and it exists because Improve
  // Sparkle's interactive pane shares a worktree with an hourly headless pass. Without the
  // pre-check the menu would be left highlighted on a row nobody chose, and the next Enter — from a
  // human, or from a later call built on an earlier read — toggles the wrong box. That is this
  // bead's own defect, one step earlier.
  //
  // THE ASSERTION IS THE ABSENCE OF THE WRITE, not the presence of a refusal, for the same reason
  // the sibling suite gives on this gate: a test checking only the reason passes against a gate
  // that refuses AFTER mutating, which is the case that matters.
  //
  // (The dispatcher's TRIAL wall is deliberately not pre-checked and is not testable here: the
  // picker block returns above it, so a press is never subject to it. A case asserting a
  // `trial-spent` refusal was written first and failed — the press went through — which is what
  // established that, and why the production comment says so.)
  it("writes NOTHING, arrows included, when the press would be refused downstream", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, digits);
    mount(w);
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "sparkle",
          path: "/tmp/p1",
          agents: [{ id: SPARKLE_AGENT_ID, name: "Improve Sparkle", runtime: "local" } as never],
        } as never,
      ],
    });
    const read = readPickerOptions(SPARKLE_AGENT_ID);
    claimPass(); // the headless improvement pass owns the worktree
    try {
      const r = await selectPickerOption(SPARKLE_AGENT_ID, 2, read.fingerprint, ALLOWED);

      expect(r.ok).toBe(false);
      expect(r.reason, "the refusal is still the send's own, not one invented here").toBe(
        "sparkle-busy",
      );
      expect(writeMock, "no arrows, no press").not.toHaveBeenCalled();
      expect(w.cursor, "the highlight must not have moved").toBe(0);
      expect(w.selected()).toEqual([]);
    } finally {
      releasePass();
    }
  });
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE NO-OP PRESS — bead sparkle-5i7e8x.2
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The field report: `select_picker_option` index 0 on a plan-mode multi-select returned
// `{ok: true, label: "1 · [ ] …"}` and NOTHING changed — checkbox still `[ ]`, cursor still on row
// 1, the same fingerprint twice. Two defects, and these tests pin both:
//   1. the press `"1\r"` toggles row 1 twice on 2.1.310 (see the measurement above);
//   2. nothing re-read the screen after the press, so ANY press that changed nothing came back ok.
describe("select_picker_option never reports a press that changed nothing as ok", () => {
  it("ticks the HIGHLIGHTED row when it is the one asked for (the field report's exact shape)", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    mount(w);

    const r = await selectPickerOption(AGENT, 0, readPickerOptions(AGENT).fingerprint, ALLOWED);

    expect(r.ok, r.detail ?? "press was refused").toBe(true);
    expect(w.selected(), "row 1 must actually be ticked, not toggled twice").toEqual([0]);
    expect(readPickerOptions(AGENT).options[0]?.label).toBe("1 · [✔] Local files");
  });

  it("un-ticks a ticked row when pressed again — a toggle, both ways", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    mount(w);
    await selectPickerOption(AGENT, 1, readPickerOptions(AGENT).fingerprint, ALLOWED);
    expect(w.selected()).toEqual([1]);

    const r = await selectPickerOption(AGENT, 1, readPickerOptions(AGENT).fingerprint, ALLOWED);

    expect(r.ok, r.detail ?? "press was refused").toBe(true);
    expect(w.selected()).toEqual([]);
  });

  // THE GENERAL GUARD, independent of which keystroke is right: a widget that swallows every byte
  // (a frozen frame, a build whose keys we have not measured) must produce a REFUSAL, never ok.
  it("returns ok:false / no-effect when the screen does not change after the press", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    scrollbackMock.mockImplementation(() => w.render());
    writeMock.mockImplementation(async () => {}); // the bytes go nowhere

    const r = await selectPickerOption(AGENT, 2, readPickerOptions(AGENT).fingerprint, ALLOWED);

    expect(r.ok, "a press that changed nothing is never ok").toBe(false);
    expect(r.reason).toBe("no-effect");
    expect(r.label).toBeUndefined();
    expect(r.cursorMoved, "the walk was written, so the caller must be told").toBe(true);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("returns no-effect when the WRONG row flipped instead of the requested one", async () => {
    const w = new MultiSelectWidget(QUESTION, LABELS, 0, "toggle");
    scrollbackMock.mockImplementation(() => w.render());
    // A widget that ignores the arrows: the toggle lands on row 0, not the requested row 2.
    writeMock.mockImplementation(async (_id: string, bytes: string) =>
      w.feed(bytes.replaceAll("\x1b[A", "").replaceAll("\x1b[B", "")),
    );

    const r = await selectPickerOption(AGENT, 2, readPickerOptions(AGENT).fingerprint, ALLOWED);

    expect([r.ok, r.reason]).toEqual([false, "no-effect"]);
    expect(w.selected(), "fixture: the stray toggle really did land on row 0").toEqual([0]);
  });
});
