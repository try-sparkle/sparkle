// @vitest-environment jsdom
//
// Improvement B regression guard: trial users type straight into the RAW terminal (the credit-
// gated Composer never mounts for them), so metering must happen on that path. AgentPane wires
// Terminal's `onSubmitLine` (fired once per non-empty submitted line by terminalSubmit's scanner)
// to recordTrialSend on the no-composer path. This test reproduces that exact chain — user
// keystrokes → scanner → recordTrialSend — and asserts one SERVER debit per submitted prompt for a
// trial user, and zero for an entitled one (the old bug: the counter was stuck at 100 because the
// only hook lived in the Composer trial users never mount).
import { afterEach, describe, expect, it, vi } from "vitest";

const consume = vi.fn();
let blocked = false;
let entitled = false;
vi.mock("../stores/trialStore", () => ({
  useTrialStore: { getState: () => ({ blocked, consume }) },
  TRIAL_LIMIT: 100,
}));
vi.mock("../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ me: entitled ? { entitled: true } : null }) },
}));

import { makeLineScanState, scanSubmittedLines } from "./terminalSubmit";
import { recordTrialSend } from "../services/trialMeter";

// Mirror AgentPane's no-composer wiring: for each non-empty submitted line the scanner reports,
// call the same handler AgentPane passes as Terminal's onSubmitLine.
async function driveRawTerminal(chunks: string[]): Promise<void> {
  const state = makeLineScanState();
  for (const c of chunks) {
    const submits = scanSubmittedLines(state, c);
    for (let i = 0; i < submits; i += 1) await recordTrialSend();
  }
}

afterEach(() => {
  blocked = false;
  entitled = false;
  vi.clearAllMocks();
});

describe("raw-terminal trial metering (Improvement B)", () => {
  it("debits the server once per non-empty prompt a trial user submits in the terminal", async () => {
    consume.mockResolvedValue(undefined);
    await driveRawTerminal(["make me a website\r", "now add a footer\r"]);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("does NOT debit on bare/whitespace-only Enters (no prompt was sent)", async () => {
    consume.mockResolvedValue(undefined);
    await driveRawTerminal(["\r", "   \t \r"]);
    expect(consume).not.toHaveBeenCalled();
  });

  it("never meters an entitled user typing in the raw terminal", async () => {
    entitled = true;
    await driveRawTerminal(["build the thing\r"]);
    expect(consume).not.toHaveBeenCalled();
  });

  it("counts exactly one debit per Enter, not per keystroke", async () => {
    consume.mockResolvedValue(undefined);
    // Typed character-by-character, then submitted once.
    await driveRawTerminal(["h", "e", "l", "l", "o", "\r"]);
    expect(consume).toHaveBeenCalledTimes(1);
  });
});
