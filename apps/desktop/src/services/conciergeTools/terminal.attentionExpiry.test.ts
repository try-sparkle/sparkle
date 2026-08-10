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

/** The shared time base for this suite: every ledger stamp is an offset from it, so the ledger and
 *  the capture's own `Date.now()` stamp sit on ONE scale — see `ledgerSeesWorkAfterTheAsk`. */
const BASE = Date.now();

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
 * TIMES ARE OFFSETS FROM A SHARED `BASE`, NOT BARE LITERALS (bead sparkle-5wbhn). The capture now
 * carries its own write time, stamped by `setAttentionScreen` from the real clock, and `captureFor`
 * compares the ledger against THAT. In production both are epoch ms from the same clock — the
 * ledger's come from `fleet_digest` — so a fixture using synthetic 1_000/2_000 epochs would put the
 * two on incomparable scales and make every movement look older than every capture. Anchoring on
 * `BASE` keeps the one property under test (ordering) while matching production's single time base.
 *
 * Two `noteMovement` calls, not one, and that is the module's rule rather than padding: the first
 * evidence an episode sees only ADOPTS its `session_id` and is explicitly not counted as movement
 * (movementRetraction header 4b), so a single call would leave the ledger empty and this helper
 * would silently assert nothing.
 */
function ledgerSeesWorkAfterTheAsk(raisedAtOffset: number, workedAtOffset: number) {
  const raisedAt = BASE + raisedAtOffset;
  const workedAt = BASE + workedAtOffset;
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
  // All three are module singletons shared by every case in this file.
  //
  // `attentionScreenAt` IS THE THIRD KEY FOR A REASON (roborev 61979). zustand's `setState` merges
  // SHALLOWLY, so a reset naming only the first two leaves the stamp map carrying whatever the
  // previous case put there — and that leak is permanent, because `setStatus`'s clear is gated on
  // `agentId in s.attentionScreen` (runtimeStore.ts), which an orphaned stamp can never satisfy.
  // Every assertion below about `attentionScreenAt` would then be judging cross-test residue
  // instead of what its own case produced: the helper would red for reasons unrelated to the
  // invariant, and the paired positive would pass even with the stamp write deleted, purely
  // because of where it happens to sit in the file. Resetting all three is what makes the order of
  // these cases irrelevant.
  useRuntimeStore.setState({ status: {}, attentionScreen: {}, attentionScreenAt: {} });
  resetRetractionLedgerForTests();
  seedAgent();
});

/**
 * THE LOCKSTEP INVARIANT, asserted GENERICALLY (roborev 61970).
 *
 * `attentionScreenAt`'s doc says it is written and cleared in lockstep with `attentionScreen` —
 * every site that touches one touches the other — and `captureFor`'s `capturedAt === undefined`
 * fallback DEPENDS on that. Nothing enforced it, and one of the three clear sites promptly did not
 * obey: `setStatus` dropped the text and kept the stamp. Lint caught that particular shape (a dead
 * rest binding) but covers only ONE of the two ways to reintroduce it — delete the destructure AND
 * the assignment, or add a fourth clear site that forgets the stamp, and lint stays quiet too.
 *
 * An orphaned stamp is also behaviourally INVISIBLE: `captureFor` early-returns on empty text
 * before it ever reads the stamp, so no assertion about what the concierge is handed can see one.
 * It has to be asserted on the store directly.
 *
 * Subset rather than equality, deliberately: a capture with no stamp is the documented legacy case
 * `captureFor` still handles, and it is SAFE (it falls back to the old comparison). A stamp with no
 * capture is the leak, and it is the one direction that must never happen.
 */
function expectStampsTrackCaptures() {
  const { attentionScreen, attentionScreenAt } = useRuntimeStore.getState();
  const orphaned = Object.keys(attentionScreenAt).filter((id) => !(id in attentionScreen));
  expect(orphaned, "attentionScreenAt holds stamps for agents with no capture").toEqual([]);
}

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
    // …and the stamp went with it. Invisible to every assertion above — see the helper.
    expect(useRuntimeStore.getState().attentionScreenAt[AGENT]).toBeUndefined();
    expectStampsTrackCaptures();
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
    // THE PAIRED POSITIVE FOR THE STAMP TOO: absence in the case above must mean "cleared with the
    // text", not "cleared on every transition" — which would pass there and gut the feature here.
    expect(useRuntimeStore.getState().attentionScreenAt[AGENT]).toBeDefined();
    expectStampsTrackCaptures();
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
    expectStampsTrackCaptures();
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
    // The NEIGHBOUR path is the one shape the helper's genericness exists for — a per-agent
    // assertion about AGENT cannot see a stamp stranded under OTHER. It is also the case that used
    // to seed the leak this suite's reset now prevents.
    expectStampsTrackCaptures();
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

    // ── THE ASK-AGAIN CASE (bead sparkle-5wbhn, roborev 61856) ────────────────────────────────
    // The case above is a capture the agent HAS moved past. This is its mirror and the one the
    // first cut got wrong: a capture written AFTER the movement, which is the freshest evidence
    // there is and was being thrown away.
    //
    // It needs no remount and no exotic timing. `noteRedEpochs` treats `waiting → approval` as ONE
    // episode, so `redSince` survives — the agent asks, the human answers in the terminal, work
    // events land, the agent asks AGAIN and photographs the new menu, all inside that one red. The
    // old rule compared movement against the EPISODE's raise time, so it called that new capture
    // stale; the fix compares against the CAPTURE's own write time.
    //
    // The consequence being pinned is the write path, not the read: `mayHaveMenu` fell back to a
    // capture that had been discarded, returned false, and PERMITTED `enter` into a live unread
    // picker — the fail-open direction of a guard whose header says it fails closed when blind.
    it("keeps serving a capture written AFTER the movement, and still refuses the keys", async () => {
      agentAsksAMenu();
      // The human answers; the agent works. Movement is stamped inside the same red episode, and
      // in the PAST relative to the capture written below — that ordering is the whole case, and
      // it is why the offsets are negative while the case above uses positive ones.
      ledgerSeesWorkAfterTheAsk(-4_000, -2_000);
      // …and then it asks again, photographing the NEW menu. Still red throughout, so the store
      // clear correctly does not fire.
      useRuntimeStore.getState().setAttentionScreen(AGENT, MENU);

      const after = await readAgentTerminal(AGENT);
      expect(after.source).toBe("attention-screen");
      expect(after.text).toContain("Enter your choice:");

      // THE POINT: the picker-driving keys stay refused, because there IS a live menu.
      const key = await sendControlKey(AGENT, "enter", ALLOWED);
      expect(key.ok).toBe(false);
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
    // LAST CASE IN THE FILE, deliberately. An order-dependent helper fails HERE first, because
    // every earlier case's residue has accumulated by this point. Its passing is the standing
    // proof that the three-key reset above is doing its job.
    expectStampsTrackCaptures();
  });
});
