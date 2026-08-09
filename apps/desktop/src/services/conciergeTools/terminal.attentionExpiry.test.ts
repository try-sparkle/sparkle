// THE ASK-SCREEN CAPTURE MUST NOT OUTLIVE THE ASK (bead sparkle-99o9a).
//
// `runtimeStore.attentionScreen[agentId]` is the terminal photographed the moment an agent went red.
// It used to be cleared ONLY by `close()` / `resetProgress()` — nothing dropped it when the agent
// ANSWERED and got back to work — so a menu snapshot could be served as the present tense for hours,
// or for the whole session. Three consumers read it, and each was degraded by that: `readAgentTerminal`
// tier (b) narrates it to the concierge as this agent's recent output, `mayHaveMenu` gates the
// `send_control_key` refusal on it, and the phone relay sends it as the body of "what it's asking".
//
// WHY THIS FILE EXISTS SEPARATELY FROM terminal.test.ts. That suite mocks the whole runtime store
// (`getState` returns a hand-built `{ attentionScreen, status }`), which is right for the read-chain
// cases it owns — but it makes the expiry untestable there by construction: a test that seeds both
// maps by hand can never observe the store's own transition. Every case below drives the REAL store
// through the REAL production writer (`setStatus`) and then asks a REAL consumer what it sees, so
// deleting the clear in `setStatus` is what makes them fail.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The write primitive — mocked so "did this reach the PTY?" is directly observable, exactly as in
// terminal.test.ts. Everything else in this file is the shipping implementation.
vi.mock("../../pty", () => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
// Tier (a) blind, which is the case the capture exists to cover: on a real fleet most agents have no
// mounted pane, and it is exactly there that a stale snapshot is the ONLY thing a consumer can see.
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn<(id: string) => string | null>(() => null),
}));
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));
// Tiers (c) and (d) empty, so a read that finds nothing at tier (b) reports `none` rather than
// falling through to unrelated content and hiding the difference this test is about.
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

import { useRuntimeStore } from "../../stores/runtimeStore";
import { useProjectStore } from "../../stores/projectStore";
import { writePtyChainedStrict } from "../../pty";
import { conciergeToolAuthority } from "../dispatchAuthority";
import { isRedStatus } from "../windowStatus";
// The REAL ledger and the REAL folds, not a stand-in: the second expiry's whole claim is that it
// reuses the concierge feed's own "has this agent acted since its red" answer, so a test that
// stubbed `movedSince` would be asserting its own fixture.
import {
  noteMovement,
  noteRedEpochs,
  resetRetractionLedgerForTests,
  windowRetractionLedger,
  type MovementEvidence,
} from "../../engine/movementRetraction";
import { readAgentTerminal, sendControlKey } from "./terminal";

const AGENT = "ag-expiry";
const MENU = [
  "Do you want to make this edit to runtimeStore.ts?",
  "  1) Yes",
  "  2) Yes, and don't ask again",
  "  3) No, and tell Claude what to do differently",
  "Enter your choice: ",
].join("\n");

/** An authority that really did pass the policy gate. */
const ALLOWED = conciergeToolAuthority("call-1", { tier: "allow" })!;

/** The agent has to exist and be local, or `agentCanAcceptInput` refuses before the picker guard. */
function seedAgent() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: AGENT, name: "Retry logic", runtime: "local" } as never],
      } as never,
    ],
  });
}

/**
 * Put the agent where the bug starts: it hit a menu, the Terminal seam photographed the screen, and
 * the status engine reported the ask. THE ORDER IS THE PRODUCTION ORDER (Terminal.tsx captures first,
 * then forwards to onStatus) — reversing it here would seed a state the app never produces.
 */
function agentAsksAMenu() {
  useRuntimeStore.getState().setAttentionScreen(AGENT, MENU);
  useRuntimeStore.getState().setStatus(AGENT, "waiting");
}

/**
 * Drive the movement ledger the way the app does: an episode is stamped from the status map, then
 * evidence folds in over SUCCESSIVE polls.
 *
 * Two `noteMovement` calls, not one, and that is the module's rule rather than padding: the first
 * evidence an episode sees only ADOPTS its `session_id` and is explicitly not counted as movement
 * (movementRetraction header 4b), so a single call would leave the ledger empty and this helper
 * would silently assert nothing.
 */
function ledgerSeesWorkAfterTheAsk(raisedAt: number, workedAt: number) {
  const ledger = windowRetractionLedger();
  noteRedEpochs(ledger, { [AGENT]: "waiting" }, isRedStatus, raisedAt);
  const evidence: MovementEvidence = {
    lastEvent: "PostToolUse",
    lastEventMs: workedAt,
    sessionId: "session-1",
  };
  noteMovement(ledger, () => evidence, workedAt + 1); // adopts the session
  noteMovement(ledger, () => evidence, workedAt + 2); // …and only now counts as movement
}

beforeEach(() => {
  vi.clearAllMocks();
  // Both are module singletons shared by every case in this file.
  useRuntimeStore.setState({ status: {}, attentionScreen: {} });
  resetRetractionLedgerForTests();
  seedAgent();
});

describe("the ask-screen capture expires when the agent stops asking", () => {
  // THE SIDE EFFECT, not the store field: what the concierge is actually handed.
  it("stops serving the dead menu as tier (b) once the agent goes back to work", async () => {
    agentAsksAMenu();

    // While it is asking, this is the correct answer and the read says so.
    const asking = await readAgentTerminal(AGENT);
    expect(asking.source).toBe("attention-screen");
    expect(asking.text).toContain("Enter your choice:");

    // The user answers; the agent resumes. This ONE call is the whole change under test.
    useRuntimeStore.getState().setStatus(AGENT, "working");

    const resumed = await readAgentTerminal(AGENT);
    expect(resumed.text).not.toContain("Enter your choice:");
    expect(resumed.text).toBe("");
    // …and it says it has nothing rather than mislabelling something else as the captured screen.
    expect(resumed.source).toBe("none");
    expect(resumed.attempts.find((a) => a.source === "attention-screen")?.ok).toBe(false);
  });

  // THE PAIRED POSITIVE. Absence alone is ambiguous — a clear-on-every-transition would pass the
  // case above and destroy the feature. This pins the CAUSE: the capture is bounded by RED, not by
  // movement, so a status change that keeps the agent asking keeps the screen it is asking with.
  it("keeps serving it across a red→red transition, which is still an ask", async () => {
    agentAsksAMenu();

    // waiting → approval: a different status, same fact about the user (it needs you).
    useRuntimeStore.getState().setStatus(AGENT, "approval");

    const still = await readAgentTerminal(AGENT);
    expect(still.source).toBe("attention-screen");
    expect(still.text).toContain("Enter your choice:");
  });

  // The same pairing at the far end of the red tier: an agent that slid from a question into
  // `errored`/`blocked` still needs a human, and NOTHING recaptures a screen for those statuses
  // (Terminal only photographs waiting/approval). Dropping it there would blank the phone relay's
  // body for exactly the agents in the worst state.
  it("keeps serving it when the ask degrades into errored", async () => {
    agentAsksAMenu();
    useRuntimeStore.getState().setStatus(AGENT, "errored");

    const still = await readAgentTerminal(AGENT);
    expect(still.source).toBe("attention-screen");
    expect(still.text).toContain("Enter your choice:");
  });

  // THE CONSUMER THE EXISTING `isRedStatus` GATE CANNOT COVER.
  //
  // `mayHaveMenu` already refuses to trust a capture unless the agent is red — defence in depth that
  // stays exactly as it was. But redness is not identity: an agent that answered a menu at 09:00 and
  // crashed at 14:00 is red again, with a five-hour-old menu still in the map. The gate passes, the
  // stale screen decides, and `enter`/the arrows are refused with `select_picker_option` refusing
  // too — the deadlock roborev 55170 named, reached by a second road. Only the expiry closes it.
  it("stops refusing the picker-driving keys after an answered menu and a LATER unrelated red", async () => {
    agentAsksAMenu();

    // Sanity: while it is genuinely asking, the guard does its job. (Not the assertion under test —
    // it is here so the case below cannot pass by the guard being inert for some other reason.)
    const duringAsk = await sendControlKey(AGENT, "enter", ALLOWED);
    expect([duringAsk.ok, duringAsk.reason]).toEqual([false, "ambiguous-picker"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();

    // Answered, worked for hours, then died of something unrelated. `errored` captures no screen.
    useRuntimeStore.getState().setStatus(AGENT, "working");
    useRuntimeStore.getState().setStatus(AGENT, "errored");

    const afterwards = await sendControlKey(AGENT, "enter", ALLOWED);
    expect(afterwards.ok).toBe(true);
    expect(writePtyChainedStrict).toHaveBeenCalledTimes(1);
  });

  // The expiry is per-agent. A shared map plus a spread rebuild is exactly where a neighbour gets
  // dropped by accident, and the symptom (one agent's phone card losing its body) points nowhere
  // near this line.
  it("does not touch another agent's capture", async () => {
    const OTHER = "ag-neighbour";
    agentAsksAMenu();
    useRuntimeStore.getState().setAttentionScreen(OTHER, "Overwrite config.toml? [y/n] ");
    useRuntimeStore.getState().setStatus(OTHER, "waiting");

    useRuntimeStore.getState().setStatus(AGENT, "working");

    const neighbour = await readAgentTerminal(OTHER);
    expect(neighbour.source).toBe("attention-screen");
    expect(neighbour.text).toContain("Overwrite config.toml?");
  });

  // ── THE SECOND EXPIRY: the agent whose status NOBODY WILL EVER MOVE ────────────────────────────
  //
  // `runtimeStore.status` has one writer, a MOUNTED AgentPane. For an agent this window is not
  // hosting, the red is a frozen last reading and setStatus never runs again — and that is precisely
  // the population tier (b) exists for, since tier (a) is blind exactly when the pane is unmounted.
  // The store clear above is therefore inert for them, and `captureFor` reads the signal that DOES
  // exist: the movement ledger the concierge feed already builds from `fleet_digest`.
  //
  // NOTHING IN THESE TWO CASES CALLS setStatus AFTER THE ASK. That is the point — they would both
  // pass on the store clear alone if they did.
  describe("and expires for an unhosted agent whose status is frozen red", () => {
    it("stops serving the capture once the ledger has seen the agent act since the ask", async () => {
      agentAsksAMenu();
      expect((await readAgentTerminal(AGENT)).source).toBe("attention-screen");

      // Answered from the phone or the terminal; the agent ran tools for hours. No status writer.
      ledgerSeesWorkAfterTheAsk(1_000, 2_000);

      const after = await readAgentTerminal(AGENT);
      expect(after.text).not.toContain("Enter your choice:");
      expect(after.source).toBe("none");
      // The chain says WHY, rather than reporting the tier as simply empty — the concierge is
      // entitled to know the difference between "never asked" and "asked and moved past it".
      expect(after.attempts.find((a) => a.source === "attention-screen")?.why).toMatch(/seen working/);
      // …and the frozen red no longer refuses the picker-driving keys on a dead menu either.
      const key = await sendControlKey(AGENT, "enter", ALLOWED);
      expect(key.ok).toBe(true);
    });

    // THE PAIRED POSITIVE, and it pins the ORDERING rather than the mere presence of evidence: work
    // recorded BEFORE the ask is not work past it. An agent that asks a question has by definition
    // just been running, so a rule keyed on "has any movement" would silence every genuine ask.
    it("keeps serving it when the only movement predates the ask", async () => {
      agentAsksAMenu();

      // Red raised at 5000; the newest work event is from 2000 — the tool run that led up to it.
      ledgerSeesWorkAfterTheAsk(5_000, 2_000);

      const still = await readAgentTerminal(AGENT);
      expect(still.source).toBe("attention-screen");
      expect(still.text).toContain("Enter your choice:");
      // And the guard still refuses to press a menu it can see.
      const key = await sendControlKey(AGENT, "enter", ALLOWED);
      expect([key.ok, key.reason]).toEqual([false, "ambiguous-picker"]);
    });
  });

  // A redundant tick of the SAME status returns the previous state object untouched (the
  // sparkle-f2uz render guard). That early return sits ABOVE the clear, so it must not be reachable
  // with a non-red status in a way that leaves the capture alive on a REAL transition — and equally,
  // a repeated non-red tick must not resurrect anything. Pins both halves of that interaction.
  it("survives a repeated red tick and stays gone after a repeated non-red one", async () => {
    agentAsksAMenu();
    useRuntimeStore.getState().setStatus(AGENT, "waiting"); // no-op re-report
    expect((await readAgentTerminal(AGENT)).source).toBe("attention-screen");

    useRuntimeStore.getState().setStatus(AGENT, "working");
    useRuntimeStore.getState().setStatus(AGENT, "working"); // no-op re-report
    expect((await readAgentTerminal(AGENT)).source).toBe("none");
  });
});
