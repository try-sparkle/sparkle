// @vitest-environment jsdom
//
// The fleet-awareness surface: the Level 0–2 ladder, and the policy asymmetry that is supposed to
// make Level 3 rare.
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { InboxEntry, InboxView } from "./fleet";
import {
  DRAIN_NOTES,
  FLEET_OPS,
  FLEET_RISK,
  fleetDigest,
  inboxBroadcast,
  inboxSend,
  inboxStatus,
  readAgentTranscript,
} from "./fleet";
import { absenceClaimIn } from "../../engine/probeOutcome";
import { defaultDecisionFor } from "./policy";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore, DEFAULT_SPARKLE_CONSENT } from "../../stores/settingsStore";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";

// The concierge's reserved caller id. Mirrors `CONCIERGE_CALLER_AGENT_ID` in `../controlListener`
// and `CONCIERGE_INBOX_ID` in `./fleet`; the literal is used here rather than imported so this test
// does not drag the whole control listener (and its unmocked tauri event wiring) into a fleet unit
// test. The bridge/controlListener copies are pinned by the Rust mirror test.
const CONCIERGE_ID = "sparkle:concierge";

beforeEach(() => {
  invoke.mockReset();
  // The deliver-or-fail directory (bead sparkle-179b2s) reads liveness from `openAgentIdSet`, i.e.
  // the runtime store's `openAgentIds`. Reset it so no live agent leaks between tests; each test
  // that expects a send to SUCCEED seeds the recipient here (driving the REAL seam, not a mock).
  // `status` too: it is the SECOND, independent seam the receipt reads (`drainableBy`), and a live
  // entry leaking between tests would silently turn a `nothing-observable` case into a drainable one.
  useRuntimeStore.setState({ openAgentIds: [], status: {} } as never);
  // The THIRD seam the receipt reads: Improve Sparkle's `own-channel` arm is only true while its
  // headless pass is switched on, so a leaked `never` from another test would silently change the
  // verdict for that id.
  useSettingsStore.setState({ sparkleImprovementConsent: DEFAULT_SPARKLE_CONSENT } as never);
});

/** Mark ids as live so `inboxSend`/`inboxBroadcast` will deliver to them — the same seam production
 *  reads. Kept as a helper so a test states the addressable set in one line. */
function markLive(...ids: string[]): void {
  useRuntimeStore.setState({ openAgentIds: ids } as never);
}

/** Give this window a live STATUS entry for `id` — the seam `fleetWatch.observedStatusRefusal` reads
 *  and therefore the one the receipt's `drainableBy` is decided from. Distinct from `markLive`:
 *  `openAgentIds` answers "may I address this id?", `status` answers "can I see a live pane?". */
function markObserved(id: string, status: string): void {
  useRuntimeStore.setState(
    { status: { ...useRuntimeStore.getState().status, [id]: status } } as never,
  );
}

/**
 * A backend that answers each command by name — needed because `inboxStatus` reads TWO commands
 * (`inbox_status` for the counts it always had, `inbox_peek` for the per-message answer it gained),
 * and a single `mockResolvedValue` would hand the same body to both.
 *
 * A command it was not given is RECORDED in `unexpected` rather than rejected. Deliberately: this
 * file's own docblock at `fleetDigest` records that vitest reports a mock-produced rejection as an
 * unhandled error even when the code under test catches it, so a throwing backend would fail every
 * test that used it for a reason unrelated to the behaviour. Recording is also the stronger form —
 * the read-only test below asserts on the recorded list directly.
 */
const unexpected: string[] = [];

function backend(handlers: Record<string, unknown>): void {
  unexpected.length = 0;
  invoke.mockImplementation((cmd: string) => {
    if (!(cmd in handlers)) unexpected.push(cmd);
    return Promise.resolve(handlers[cmd]);
  });
}

/** One `inbox_peek` entry. Every field the Rust `InboxEntry` serialises, including the `null`s. */
function entry(id: string, state: InboxEntry["state"], text = `text of ${id}`): InboxEntry {
  return {
    id,
    ts: 1_000,
    from: "concierge",
    text,
    severity: "act",
    state,
    // A Rust `Option<T>` crosses the wire as `null`, NEVER as an absent key (AGENTS.md's seam rule),
    // so the fixture carries `null` rather than omitting these — a fixture with the keys missing
    // would be testing a payload shape the backend cannot produce.
    ackedAt: state === "acknowledged" ? 1_500 : null,
    ackNote: state === "acknowledged" ? "read it" : null,
  };
}

function view(agentId: string, entries: InboxEntry[]): InboxView {
  return { agentId, entries };
}

/** A counts row with everything at zero, so a test states only the column it is about. */
function countsRow(agentId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    agentId,
    pending: 0,
    delivered: 0,
    acknowledged: 0,
    awaitingAck: 0,
    pendingIds: [],
    ...over,
  };
}

describe("risk classification", () => {
  it("classifies every op exactly once", () => {
    expect(Object.keys(FLEET_RISK).sort()).toEqual([...FLEET_OPS].sort());
  });

  it("keeps all three reads read-only", () => {
    expect(FLEET_RISK.fleet_digest).toBe("read-only");
    expect(FLEET_RISK.read_agent_stream).toBe("read-only");
    expect(FLEET_RISK.read_agent_transcript).toBe("read-only");
    expect(FLEET_RISK.inbox_status).toBe("read-only");
  });
});

describe("the asymmetry that makes Level 3 rare", () => {
  /**
   * This is the enforcement mechanism for the whole design goal "direct terminal messages become
   * rare enough to be notable". It is not achieved by asking the concierge nicely in a prompt; it
   * is achieved by making the non-interrupting channel frictionless and the interrupting one gated.
   *
   * If these two ever resolve to the SAME decision, the incentive is gone: an assistant that must
   * request approval to leave a message will reach for the terminal instead, which is exactly
   * backwards.
   */
  it("auto-allows a queued message but asks before an interrupting terminal write", () => {
    expect(defaultDecisionFor("inbox_send")).toBe("allow");
    expect(defaultDecisionFor("inbox_broadcast")).toBe("allow");
    expect(defaultDecisionFor("send_to_agent_terminal")).toBe("ask");
  });

  it("keeps the free reads free, so checking is never costlier than messaging", () => {
    // If the digest asked for approval, the concierge would message agents to find out who is
    // alive — the 240-turns-an-hour failure this whole feature exists to prevent.
    expect(defaultDecisionFor("fleet_digest")).toBe("allow");
    expect(defaultDecisionFor("read_agent_stream")).toBe("allow");
    expect(defaultDecisionFor("read_agent_transcript")).toBe("allow");
  });
});

describe("fleetDigest", () => {
  it("attaches verdicts and an escalate shortlist to the raw facts", async () => {
    const now = 1_800_000_000_000;
    invoke.mockResolvedValue({
      generatedAtMs: now,
      windowMs: 900_000,
      conflicts: [],
      agents: [
        {
          agentId: "moving",
          worktree: "/wt/moving",
          worktreeExists: true,
          hookMtimeMs: now - 1_000,
          hooks: { lastEvent: "PostToolUse", lastEventMs: now - 1_000, sessionId: null, transcriptPath: null, lastTurnEndMs: null, turnsRecent: 1, toolsRecent: 5, compactionsRecent: 0, recentTools: [], linesScanned: 9, tailTruncated: false },
          git: { ahead: 0, dirtyFiles: 0, lastCommitMs: null, branch: "b", changedFiles: [] },
          newestWriteMs: now - 1_000,
          walkTruncated: false,
          task: null,
          resultStatus: null,
        },
        {
          agentId: "stalled",
          worktree: "/wt/stalled",
          worktreeExists: true,
          hookMtimeMs: now - 45 * 60_000,
          hooks: { lastEvent: "Stop", lastEventMs: now - 45 * 60_000, sessionId: null, transcriptPath: null, lastTurnEndMs: now - 45 * 60_000, turnsRecent: 0, toolsRecent: 0, compactionsRecent: 0, recentTools: [], linesScanned: 20, tailTruncated: false },
          git: { ahead: 0, dirtyFiles: 3, lastCommitMs: null, branch: "b", changedFiles: [] },
          newestWriteMs: now - 45 * 60_000,
          walkTruncated: false,
          task: null,
          resultStatus: null,
        },
      ],
    });

    const r = await fleetDigest([
      { agentId: "moving", projectId: "p" },
      { agentId: "stalled", projectId: "p" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.verdicts.map((v) => v.progress)).toEqual(["advancing", "silent"]);
    expect(r.data.escalate).toEqual(["stalled"]);
    expect(r.risk).toBe("read-only");
  });

  it("refuses an empty agent list with a message that says what to pass", async () => {
    const r = await fleetDigest([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("agentId");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a malformed backend response as a refusal rather than throwing", async () => {
    // Exercises the same catch → refuse path as a rejected invoke, without handing the mock a
    // rejected promise: vitest reports a mock-produced rejection as an unhandled error even when
    // the code under test catches it, which would fail this test for a reason unrelated to the
    // behaviour being asserted. A response missing `agents` makes `verdictsFor` throw inside the
    // same try block, which is the property that matters — a bad backend reply never escapes.
    invoke.mockResolvedValue({ generatedAtMs: 1, windowMs: 1 });
    const r = await fleetDigest([{ agentId: "a", projectId: "p" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("digest-failed");
    expect(r.message).not.toBe("");
  });
});

describe("readAgentTranscript", () => {
  it("refuses a blank path and explains where the real one comes from", async () => {
    const r = await readAgentTranscript("  ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("transcriptPath");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("inboxSend — a receipt for an ENQUEUE, not for a delivery", () => {
  /**
   * (a) THE BEAD (sparkle-ei7keg). `inbox_send` used to answer `ok("inbox_send", { messageId })`. The
   * queue write really happened, so `ok` was not the lie; the lie was that NOTHING in the payload
   * could ever have been false. An id looks like proof, and the caller is a language model whose next
   * act is to tell a human what it did — so it told the founder that seven instructions were
   * delivered. A foreign `claude` process sharing the worktree had drained and acked the queue before
   * the real agent reached a turn boundary; five of the seven reached nobody.
   *
   * This FAILS against the previous shape by construction: `{ messageId }` has no `delivered` key, so
   * `delivered` reads `undefined`, and `toBe(false)` rejects it. `undefined` is not the answer either
   * — an absent field is exactly what let a caller assume the happy case.
   */
  it("does NOT report itself as delivered", async () => {
    markLive("a1");
    invoke.mockResolvedValue("m1");
    const r = await inboxSend("a1", "rebase before you verify", "act");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.delivered).toBe(false);
    expect(r.data.state).toBe("queued");
    // The id is still there — it is what the verification call needs. It is simply no longer the
    // ONLY thing there, which is what made it readable as proof.
    expect(r.data.messageId).toBe("m1");
    expect(r.data.agentId).toBe("a1");
  });

  /**
   * A receipt that says "this is unconfirmed" without saying how to confirm it just relocates the
   * problem to the caller. The founder's rule has two halves — the result must not read as delivery,
   * AND there must be a way to later ask whether it landed — so the receipt carries the second call
   * ready to paste, over exactly the id it just returned.
   */
  it("names the op that can confirm it, with the arguments already filled in", async () => {
    markLive("a1");
    invoke.mockResolvedValue("m1");
    const r = await inboxSend("a1", "main has moved");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.verifyWith).toBe("fleet.inbox_status");
    expect(r.data.verifyArgs).toEqual({ agentIds: ["a1"], messageIds: ["m1"] });
    // The pointer has to survive a round trip: these are the exact arguments `inbox_status` takes.
    backend({
      inbox_status: [countsRow("a1", { pending: 1, pendingIds: ["m1"] })],
      inbox_peek: [view("a1", [entry("m1", "pending")])],
    });
    const check = await inboxStatus(r.data.verifyArgs.agentIds, r.data.verifyArgs.messageIds);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.data.rows[0]!.entries!.map((e) => [e.id, e.state])).toEqual([["m1", "pending"]]);
  });

  /**
   * (b) THE SECOND HALF OF THE HONESTY (bead sparkle-rk0k8o). Everything above is accurate and still
   * leaves the caller stuck: `queued` + `delivered: false` + "ask `inbox_status`" says the message
   * has not landed YET, and says nothing about whether anything will EVER pick it up.
   *
   * Measured: the concierge queued messages to idle agents this window held no pane for. Nothing
   * drains that queue except the recipient's own `Stop` hook — which an already-idle agent has
   * emitted for the last time — and `fleetWatch`'s 30s sweep, which refuses `no-live-pty` for
   * exactly these agents. The messages sat `pending` and the receipt looked like ordinary success.
   *
   * FAILS WITHOUT THE CHANGE by construction: the old receipt has no `drainableBy` key at all, so it
   * reads `undefined` and `toBe("nothing-observable")` rejects it.
   */
  it("says NOTHING OBSERVABLE will drain the queue when this window has no live pane", async () => {
    // Addressable (so the send proceeds) but UNOBSERVED — no `status` entry. This is precisely the
    // shape `fleetWatch.observedStatusRefusal` answers `no-live-pty` for, and therefore the shape
    // whose message the sweep will never claim.
    markLive("a1");
    invoke.mockResolvedValue("m1");
    const r = await inboxSend("a1", "rebase before you verify");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.drainableBy).toBe("nothing-observable");
    expect(r.data.drainNote).toBe(DRAIN_NOTES["nothing-observable"]);
    // The rule the whole receipt rests on is UNCHANGED: this is still an enqueue, never a delivery.
    expect(r.data.state).toBe("queued");
    expect(r.data.delivered).toBe(false);
  });

  /**
   * THE PAIRED POSITIVE. A verdict that said `nothing-observable` unconditionally would also satisfy
   * the test above; these two pin that the receipt is reading the observation rather than a constant,
   * and that each of the two real drain paths is named by the state that actually reaches it.
   */
  it("names the IDLE SWEEP for a live resting pane and the TURN BOUNDARY for one mid-turn", async () => {
    markLive("resting", "busy");
    markObserved("resting", "idle"); // a resting band: the hook is done, the 30s sweep is what runs
    markObserved("busy", "working"); // mid-turn: its own Stop hook will drain at the next boundary

    invoke.mockResolvedValue("m-resting");
    const resting = await inboxSend("resting", "main has moved");
    expect(resting.ok).toBe(true);
    if (!resting.ok) return;
    expect(resting.data.drainableBy).toBe("idle-sweep");
    expect(resting.data.drainNote).toBe(DRAIN_NOTES["idle-sweep"]);

    invoke.mockResolvedValue("m-busy");
    const busy = await inboxSend("busy", "main has moved");
    expect(busy.ok).toBe(true);
    if (!busy.ok) return;
    expect(busy.data.drainableBy).toBe("turn-boundary");
    expect(busy.data.drainNote).toBe(DRAIN_NOTES["turn-boundary"]);
  });

  /**
   * THE NOTE MAY NOT CLAIM THE AGENT IS GONE. A missing status entry is a fact about what THIS
   * WINDOW can observe — the agent may be running perfectly in another window, or headless. This
   * repo has a lexicon for that exact lie (`engine/probeOutcome.ABSENCE_CLAIM_PATTERNS`), and the
   * sentence a language model repeats to a human is the surface it does the most damage on.
   *
   * Asserted over EVERY note, not just the `nothing-observable` one, so a later edit to any of them
   * is caught. `absenceClaimIn` returns the pattern ID rather than a boolean, so the failure names
   * which claim was made instead of reading as "some string is wrong".
   */
  it("phrases every drain note as an observation, never as an absence claim", () => {
    /**
     * THE CLAIM EACH NOTE MUST ACTUALLY CARRY. Passing the absence lexicon is only the PROHIBITION,
     * and a note gutted to a single harmless clause passes it trivially — measured: blanking half
     * the `nothing-observable` sentence left the suite green, because the receipt test compared
     * `drainNote` against `DRAIN_NOTES[...]`, which is tautological on the text. So each note is
     * also pinned to the load-bearing clause it exists for, and the map is asserted EXHAUSTIVE so a
     * new drainer cannot be added with no claim at all.
     */
    const REQUIRED_CLAIMS: Record<string, RegExp[]> = {
      // Scoped to the observer, AND names the mechanism that will run, so the caller knows to wait.
      "turn-boundary": [/\bthis window\b/i, /\bStop hook\b/i],
      // NECESSARY IS NOT SUFFICIENT: the sweep has four more gates this receipt cannot check, so the
      // note must name the sweep AND say the observation is a path rather than a promise. Without
      // the second clause the note re-creates the silent loss the field exists to end, with an
      // affirmative claim attached.
      "idle-sweep": [/\b30s idle sweep\b/i, /\bsubject to its other gates\b/i],
      // Scoped to the OBSERVER. This is the clause that stops the same fact being repeated to a
      // human as "that agent is gone", and dropping it trips no absence pattern.
      "nothing-observable": [/\bthis window cannot see\b/i],
      // The opposite failure: these ids have no pane BY DESIGN. The note must say the queue is
      // drained anyway, name BOTH channels so the caller can tell which it is holding, and must NOT
      // send anyone after a pane or a terminal that do not exist.
      "own-channel": [
        /\bits own channel\b/i,
        /\bconcierge\b/i,
        /\bImprove Sparkle\b/i,
        /\bneeds no open pane and no terminal send\b/i,
      ],
    };
    expect(Object.keys(REQUIRED_CLAIMS).sort()).toEqual(Object.keys(DRAIN_NOTES).sort());

    for (const [drainer, note] of Object.entries(DRAIN_NOTES)) {
      expect(absenceClaimIn(note), `${drainer}: "${note}"`).toBe(null);
      for (const claim of REQUIRED_CLAIMS[drainer]!) {
        expect(note, `${drainer} must carry ${claim}: "${note}"`).toMatch(claim);
      }
    }
  });

  /**
   * THE PANE-LESS RECIPIENTS THE INBOX EXPLICITLY SUPPORTS (roborev 71170, High).
   *
   * `inboxAddressableIds` admits the concierge and Improve Sparkle with no pane open, because their
   * queues are drained by something that is not a PTY: the concierge drains while assembling its own
   * turn (it has no `Stop` hook at all), Improve Sparkle on its scheduled headless pass. Reading the
   * status map alone answers `nothing-observable` for both — which is not a cautious answer, it is a
   * false one, on every send, contradicting `undeliverableRecipient`'s own text.
   *
   * And the damage is in the REMEDY, not the label: the `nothing-observable` prose tells the caller
   * to open a pane or use a terminal send, and the concierge has neither. That is the `sparkle-8bvh`
   * shape — a remedy is an instruction the reader will act on, so it must be safe under the very
   * conditions that produced it — and here it invites a duplicate delivery on a working channel.
   */
  it("does NOT report the pane-less concierge / Improve Sparkle inboxes as undrainable", async () => {
    for (const id of [CONCIERGE_ID, SPARKLE_AGENT_ID]) {
      invoke.mockResolvedValue(`m-${id}`);
      const r = await inboxSend(id, "the founder asked for a status line");
      expect(r.ok, id).toBe(true);
      if (!r.ok) return;
      expect(r.data.drainableBy, id).toBe("own-channel");
      expect(r.data.drainNote, id).toBe(DRAIN_NOTES["own-channel"]);
      // The note must not send the caller after the two things these ids do not have.
      expect(r.data.drainNote, id).toMatch(/\bneeds no open pane and no terminal send\b/i);
    }
  });

  /**
   * ...BUT "Improve Sparkle has its own channel" IS CONDITIONAL (roborev 71174, High).
   *
   * That channel is the hourly headless pass, and `improvementPass.passHoldReason` holds it at
   * `consent-off` whenever `sparkleImprovementConsent === "never"` — a persisted user setting. With
   * consent off and no pane open, NOTHING drains that inbox, and an unconditional `own-channel`
   * would tell the caller not to escalate in exactly the state where escalating is the only thing
   * that works. That is the `idle-sweep`-promise defect wearing the other arm's clothes: an
   * affirmative claim from a predicate blind to one of the real drain path's gates. This gate is
   * synchronously readable, so it is READ rather than hedged in prose.
   *
   * The concierge is the control: it has no such switch, so it must stay `own-channel` in the same
   * state — otherwise a test that simply refused everything under `never` would also pass.
   */
  it("stops calling Improve Sparkle's channel a drain path once its pass is switched off", async () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "never" } as never);

    invoke.mockResolvedValue("m-sparkle");
    const sparkle = await inboxSend(SPARKLE_AGENT_ID, "unstick yourself");
    expect(sparkle.ok).toBe(true);
    if (!sparkle.ok) return;
    // No pane either, so the honest answer is the one that sends the caller to escalate.
    expect(sparkle.data.drainableBy).toBe("nothing-observable");

    // ...and a live pane for that same id, with consent still off, is a real drain path again.
    markObserved(SPARKLE_AGENT_ID, "idle");
    invoke.mockResolvedValue("m-sparkle-2");
    const withPane = await inboxSend(SPARKLE_AGENT_ID, "unstick yourself");
    expect(withPane.ok).toBe(true);
    if (!withPane.ok) return;
    expect(withPane.data.drainableBy).toBe("idle-sweep");

    // THE CONTROL: the concierge has no consent switch and is unaffected.
    invoke.mockResolvedValue("m-concierge");
    const concierge = await inboxSend(CONCIERGE_ID, "the founder asked for a status line");
    expect(concierge.ok).toBe(true);
    if (!concierge.ok) return;
    expect(concierge.data.drainableBy).toBe("own-channel");
  });

  /** And the live receipt carries one of exactly those notes — the check above guards the table, this
   *  guards that the table is what the caller actually receives. */
  it("returns a drain note that trips no absence-claim pattern", async () => {
    markLive("a1");
    invoke.mockResolvedValue("m1");
    const r = await inboxSend("a1", "rebase before you verify");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(absenceClaimIn(r.data.drainNote), r.data.drainNote).toBe(null);
    expect(Object.values(DRAIN_NOTES)).toContain(r.data.drainNote);
  });
});

describe("deliver-or-fail: the recipient directory (C1, bead sparkle-179b2s)", () => {
  /*
   * THE HOLE THIS CLOSES. `inbox.rs::enqueue` writes into any well-formed id's file and reads it back,
   * so it returns `ok` + a real messageId for a typo'd/closed id whose inbox nothing drains — an
   * `ok:true` that means "written into a black hole", which is exactly the delivery-vs-enqueue lie the
   * surrounding beads are about. `inboxSend` now resolves the recipient against the fleet directory
   * BEFORE the Rust hop and refuses an unaddressable one, enqueuing nothing.
   */
  it("refuses an unaddressable recipient and enqueues NOTHING", async () => {
    // No live agents, and `__typo__` is neither special id. Assert BOTH halves: the loud refusal
    // naming the id, AND that the Rust command was never invoked. Deleting the guard makes this go
    // `ok:true` (the mutation this test exists to catch), so it is not vacuous.
    const r = await inboxSend("__typo__", "you will never read this");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("undeliverable-recipient");
    expect(r.message).toContain("__typo__");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("delivers to a LIVE agent — the guard gates typos, not real recipients", async () => {
    // The paired positive. A guard that refused everything would also pass the case above; this pins
    // that a genuinely addressable recipient still flows straight through to the normal queued receipt.
    markLive("live-1");
    invoke.mockResolvedValue("m9");
    const r = await inboxSend("live-1", "rebase before you verify");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.messageId).toBe("m9");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("treats the concierge as addressable even with no live agent panes", async () => {
    // A special id: the concierge drains through its own channel, so it is addressable app-wide. This
    // also pins fleet.ts's local concierge literal against the real reserved id — passing the real id
    // and getting `ok` proves fleet.ts recognises it; a drift would refuse it here.
    invoke.mockResolvedValue("m-concierge");
    const r = await inboxSend(CONCIERGE_ID, "the founder asked for a status line");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("treats the canonical Improve Sparkle id as addressable even headless", async () => {
    // The other special id: the hourly headless pass drains its inbox (Phase B3), so it is addressable
    // with no pane open.
    invoke.mockResolvedValue("m-sparkle");
    const r = await inboxSend(SPARKLE_AGENT_ID, "unstick yourself");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("in a broadcast, only addressable ids reach Rust; the rest become not-queued, never a fake id", async () => {
    // The batch twin of the guard. `keep` is live; `gone` is not. Only `keep` crosses the wire, and
    // `gone` comes back as a not-queued outcome that names WHY — it never receives a messageId.
    markLive("keep");
    invoke.mockResolvedValue([{ agentId: "keep", messageId: "m1", error: null }]);
    const r = await inboxBroadcast(["keep", "gone"], "main has moved", "act");

    // Rust saw ONLY the deliverable id — the undeliverable one never reached enqueue.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("inbox_broadcast", {
      agentIds: ["keep"],
      text: "main has moved",
      severity: "act",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queued).toBe(1);
    expect(r.data.failedAgents).toContain("gone");
    const goneRow = r.data.outcomes.find((o) => o.agentId === "gone")!;
    expect(goneRow.messageId).toBeNull();
    expect(goneRow.state).toBe("not-queued");
    expect(String(goneRow.error)).toContain("not an addressable recipient");
  });

  it("skips Rust entirely when EVERY broadcast recipient is undeliverable", async () => {
    // All-undeliverable: nothing crosses the wire, and the wrapper's `none-queued` refusal reports it.
    const r = await inboxBroadcast(["ghost-1", "ghost-2"], "x");
    expect(invoke).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });
});

describe("inboxBroadcast", () => {
  it("counts partial failure per recipient instead of failing the whole send", async () => {
    // One full inbox must not silently prevent the other deliveries.
    markLive("a", "b", "c");
    invoke.mockResolvedValue([
      { agentId: "a", messageId: "m1", error: null },
      { agentId: "b", messageId: null, error: "inbox: b already has 50 undelivered messages" },
      { agentId: "c", messageId: "m2", error: null },
    ]);
    const r = await inboxBroadcast(["a", "b", "c"], "main has moved", "act");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queued).toBe(2);
    expect(r.data.failed).toBe(1);
    // …and NAMES who was missed, so the caller does not have to walk `outcomes` to find out — the
    // step it demonstrably skips when the envelope already says `ok: true`.
    expect(r.data.failedAgents).toEqual(["b"]);
  });

  it("REFUSES when nothing was queued, instead of returning ok with a zero in it", async () => {
    // sparkle-bbghz's rule, one layer up. `enqueue` is honest per agent now, but this wrapper
    // flattened N honest failures into `ok: true` with a count the caller had to notice on its own —
    // and the caller is a language model that has just been asked to instruct a fleet, for which
    // `ok: true` is exactly the evidence it uses to tell a human that it did. That is the same
    // positive-acknowledgement-for-nothing this bead pair is about, arriving through the batch path.
    markLive("a", "b");
    invoke.mockResolvedValue([
      { agentId: "a", messageId: null, error: "inbox: wrote message m1 but could not read it back" },
      { agentId: "b", messageId: null, error: "inbox: b already has 50 undelivered messages" },
    ]);
    const r = await inboxBroadcast(["a", "b"], "main has moved", "act");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The refusal has to be actionable: WHO was missed and WHY, not just that something went wrong.
    expect(r.message).toContain("a:");
    expect(r.message).toContain("could not read it back");
    expect(r.message).toContain("b:");
    expect(r.message).toContain("no agent has been told anything");
  });

  it("counts a missing message id as a failure even when no error string came with it", async () => {
    // A message id is what a caller USES as proof of a send, so the failure count must be the count
    // of agents that have no id — never the count that happened to carry an error string. A backend
    // that returned `{messageId: null, error: null}` would otherwise read as a clean success.
    markLive("a", "b");
    invoke.mockResolvedValue([
      { agentId: "a", messageId: "m1", error: null },
      { agentId: "b", messageId: null, error: null },
    ]);
    const r = await inboxBroadcast(["a", "b"], "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queued).toBe(1);
    expect(r.data.failed).toBe(1);
    expect(r.data.failedAgents).toEqual(["b"]);
  });

  it("refuses an empty recipient list", async () => {
    const r = await inboxBroadcast([], "x");
    expect(r.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * (e) A FAN-OUT IS THE SINGLE-SEND BUG N TIMES OVER, and it is the worse half: a caller that reads
   * one `messageId` as proof of delivery reads forty of them as proof of a fleet-wide delivery, and
   * `queued: 40` is exactly the field a summary turns into "40 agents were told". Every per-recipient
   * row therefore carries the same vocabulary `inboxSend` returns, and so does the envelope.
   *
   * Fails against the previous shape: outcomes were the raw `{agentId, messageId, error}` triple, with
   * no `state` and no `delivered` on any of them.
   */
  it("gives every recipient the same honest queued-not-delivered shape", async () => {
    markLive("a", "b");
    invoke.mockResolvedValue([
      { agentId: "a", messageId: "m1", error: null },
      { agentId: "b", messageId: null, error: "inbox: b already has 50 undelivered messages" },
    ]);
    const r = await inboxBroadcast(["a", "b"], "main has moved", "act");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.outcomes.map((o) => [o.agentId, o.state, o.delivered])).toEqual([
      ["a", "queued", false],
      ["b", "not-queued", false],
    ]);
    for (const o of r.data.outcomes) expect(o.verifyWith).toBe("fleet.inbox_status");

    // The envelope repeats it, because `queued: 1` is what a caller summarises, not the row array.
    expect(r.data.delivered).toBe(false);
    expect(r.data.state).toBe("queued");
    // …and the verification call covers exactly the recipients that got an id — never the one that
    // did not, whose message does not exist to be asked about.
    expect(r.data.queuedIds).toEqual(["m1"]);
    expect(r.data.verifyArgs).toEqual({ agentIds: ["a"], messageIds: ["m1"] });
  });
});

describe("inboxStatus", () => {
  it("surfaces how many recipients have not acknowledged", async () => {
    backend({
      inbox_status: [
        countsRow("a", { delivered: 1, acknowledged: 1 }),
        countsRow("b", { delivered: 1, awaitingAck: 1 }),
        countsRow("c", { pending: 2, pendingIds: ["m1", "m2"] }),
      ],
      inbox_peek: [view("a", []), view("b", []), view("c", [])],
    });
    const r = await inboxStatus(["a", "b", "c"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.awaitingAck).toBe(1);
  });

  /**
   * (b) THE QUESTION COUNTS CANNOT ANSWER. `pending: 3` reads identically whether three instructions
   * are waiting their turn or three reached nobody, and `pendingIds` named uuids with no state and no
   * text beside them. The states themselves are computed Rust-side by `inbox.rs::entries_of` and
   * pinned there against a real filesystem; what this asserts is that the answer REACHES the caller,
   * per message, through the op every send receipt now points at.
   *
   * No arrangement of the pre-change `inboxStatus` satisfies this: it returned `{ rows, awaitingAck }`
   * where a row was counts only, so `entries` did not exist to be read.
   */
  it("answers per message: pending, delivered and acknowledged, each with its text", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1, delivered: 2, acknowledged: 1, awaitingAck: 1 })],
      inbox_peek: [
        view("a", [
          entry("m1", "pending", "rebase before you verify"),
          entry("m2", "delivered", "the picker spec changed"),
          entry("m3", "acknowledged", "main has moved"),
        ]),
      ],
    });

    const r = await inboxStatus(["a"], undefined, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const entries = r.data.rows[0]!.entries;
    expect(entries).not.toBeNull();
    expect(entries!.map((e) => [e.id, e.state])).toEqual([
      ["m1", "pending"],
      ["m2", "delivered"],
      ["m3", "acknowledged"],
    ]);
    // THE TEXT, which is what makes an answer checkable against a claim rather than another opaque id.
    expect(entries!.map((e) => e.text)).toEqual([
      "rebase before you verify",
      "the picker spec changed",
      "main has moved",
    ]);
    // The ack detail rides along, so "acknowledged" is evidence rather than an assertion.
    expect(entries![2]!.ackedAt).toBe(1_500);
    expect(entries![0]!.ackedAt).toBeNull();
  });

  /** (c) The exact ids a send returned, and nothing else. */
  it("filters entries to the requested messageIds while keeping every agent's row", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 2 }), countsRow("b", { pending: 1 })],
      inbox_peek: [
        view("a", [entry("m1", "pending"), entry("m2", "delivered")]),
        view("b", [entry("m3", "acknowledged")]),
      ],
    });

    const r = await inboxStatus(["a", "b"], ["m2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.rows[0]!.entries!.map((e) => [e.id, e.state])).toEqual([["m2", "delivered"]]);
    // The OTHER agent's row survives the filter with an empty entry list rather than disappearing.
    // A filtered call that dropped rows would let "that agent is not in the answer" read as "that
    // agent has nothing", which is the ambiguity this whole op exists to remove.
    expect(r.data.rows.map((x) => x.agentId)).toEqual(["a", "b"]);
    expect(r.data.rows[1]!.entries).toEqual([]);
    expect(r.data.queriedIds).toEqual(["m2"]);
    expect(r.data.notFound).toEqual([]);
  });

  /**
   * THE MOST IMPORTANT THING THIS OP CAN SAY. An id that is in no live inbox was never queued, or has
   * aged past `MAX_AGE_MS` and been abandoned — either way it will NOT be delivered. Silence about it
   * would reproduce the original bug at the verification step: the caller asks "did my five land?",
   * gets no error, and concludes they did.
   */
  it("names a requested id that is in NO live inbox instead of silently omitting it", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: [view("a", [entry("m1", "pending")])],
    });

    const r = await inboxStatus(["a"], ["m1", "vanished"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.notFound).toEqual(["vanished"]);
    expect(r.data.rows[0]!.entries!.map((e) => e.id)).toEqual(["m1"]);
  });

  /**
   * (d), THE TS HALF. `inbox_status` must never claim: an op that claimed would make merely LOOKING a
   * delivery path, consuming messages no agent ever saw. The filesystem half of this property — no
   * claim file created, no ack line appended, the inbox tree byte-identical after a read — is asserted
   * against a real temp directory in `inbox.rs`'s `peek_writes_nothing_to_the_inbox_tree`.
   *
   * Here the assertion is on the WIRE: exactly two commands go out, both of them readers, and
   * `backend` recorded no command outside that pair. Every write this module could reach an inbox
   * with is a named Tauri command, so an exhaustive read of the calls IS the property.
   */
  /**
   * THE POLL PATH MUST NOT PAY FOR ENTRIES IT THROWS AWAY.
   *
   * `entries_of` re-reads `messages.jsonl` + `acks.jsonl` and stats the claims dir per agent, i.e.
   * about the same I/O `status_of` just did. `fleetWatch` drives this op on a ~10s beat over every
   * idle candidate and discards `entries` outright, on a loop its own module header records as
   * having been profiled at 30.5% of process CPU — so an unconditional peek doubles that loop's
   * disk work for a payload nobody reads.
   *
   * Asserts the SIDE EFFECT — WHICH COMMANDS WERE ISSUED — because that is the whole property; a
   * test that only checked the returned shape would pass with the peek still firing.
   */
  it("does NOT peek for a caller that did not ask, and says so rather than implying an empty inbox", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: [view("a", [entry("m1", "pending")])],
    });

    const r = await inboxStatus(["a"]); // fleetWatch's shape: no messageIds, no withEntries
    expect(r.ok).toBe(true);

    // The peek never happened.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(["inbox_status"]);
    // The counts are still exact — this is an optimisation, not a downgrade.
    expect(r.ok && r.data.rows[0]!.pending).toBe(1);
    // …and "nobody looked" is reported as `null` WITH a reason, never as `[]`. Collapsing the two
    // is the lie this whole change exists to remove: an empty array reads as "nothing outstanding".
    expect(r.ok && r.data.rows[0]!.entries).toBeNull();
    expect(r.ok && r.data.entriesUnavailable).toContain("not requested");
  });

  /** A `messageIds` filter implies wanting entries — counts cannot answer "did m2 land?" — so a
   *  caller asking a per-message question never has to know to pass `withEntries` as well. */
  it("peeks anyway when messageIds is given, without the caller passing withEntries", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: [view("a", [entry("m1", "pending")])],
    });

    const r = await inboxStatus(["a"], ["m1"]);
    expect(r.ok).toBe(true);
    expect(invoke.mock.calls.map(([c]) => c)).toContain("inbox_peek");
    expect(r.ok && r.data.rows[0]!.entries).toEqual([expect.objectContaining({ id: "m1" })]);
  });

  it("writes NOTHING — it issues only reads, never a claim", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: [view("a", [entry("m1", "pending")])],
    });

    const r = await inboxStatus(["a"], undefined, true);
    expect(r.ok).toBe(true);
    expect(FLEET_RISK.inbox_status).toBe("read-only");

    const commands = [...invoke.mock.calls.map(([c]) => c)].sort();
    expect(commands).toEqual(["inbox_peek", "inbox_status"]);
    // Named explicitly as well as counted, so the intent survives someone later adding a third read.
    for (const writer of ["inbox_claim_for_idle", "inbox_send", "inbox_broadcast", "inbox_ack"]) {
      expect(commands).not.toContain(writer);
    }
    expect(unexpected).toEqual([]);
  });

  /**
   * UNKNOWN IS NOT EMPTY. If the per-message read fails, the counts are still true but this call
   * cannot answer "did it land?" — and `entries: []` would say the opposite of that, reading as
   * "read it, nothing outstanding". Collapsing the two is the same class of lie as the send receipt
   * this change removes.
   *
   * The counts still come back rather than the whole call refusing, because `fleetWatch` drives this
   * op on a ~10s beat and its idle-delivery path is the app-side fallback that makes the queue safe
   * at all. Losing that over the strictly-extra half of the answer would trade a small honesty win
   * for a delivery regression.
   */
  it("reports an unreadable peek as null entries with a reason, never as an empty inbox", async () => {
    // A reply the reader cannot trust — the Rust→TS seam failing, however it fails. The mock resolves
    // rather than rejecting (see `backend`): vitest fails a test on a mock-produced rejection even
    // when the code catches it, so an unreadable payload is how this path is reached here. It is also
    // the realistic shape of the seam bug AGENTS.md warns about, where a parser meets a body it was
    // not written for and must not answer "empty".
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: { error: "disk gone" },
    });

    const r = await inboxStatus(["a"], undefined, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]!.entries).toBeNull();
    expect(r.data.rows[0]!.entries).not.toEqual([]);
    expect(r.data.entriesUnavailable).toContain("not an array");
    // …and the counts, which are still true, survived. Losing them would take out `fleetWatch`'s
    // idle-delivery path, which is the app-side fallback that makes the queue safe at all.
    expect(r.data.rows[0]!.pending).toBe(1);
  });

  it("refuses a peek view missing its entries rather than reading it as an empty inbox", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      // `entries` absent — an all-or-nothing parser that shrugged this off would report the agent's
      // inbox as read-and-empty while a queued instruction sat in it.
      inbox_peek: [{ agentId: "a" }],
    });

    const r = await inboxStatus(["a"], ["m1"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]!.entries).toBeNull();
    expect(r.data.entriesUnavailable).toContain("entries array");
    // And `notFound` stays EMPTY rather than naming m1: nothing was read, so "that id is in no live
    // inbox" is a claim this call cannot make. Reporting it as not-found would be the original bug
    // inverted — an unverified absence stated as a fact.
    expect(r.data.notFound).toEqual([]);
  });

  it("marks an agent the peek did not answer for as unknown rather than empty", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 }), countsRow("b")],
      inbox_peek: [view("b", [])],
    });

    const r = await inboxStatus(["a", "b"], undefined, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]!.entries).toBeNull();
    expect(r.data.rows[1]!.entries).toEqual([]);
  });

  it("leaves queriedIds null when nothing was asked about, so 'unfiltered' is not 'found nothing'", async () => {
    backend({
      inbox_status: [countsRow("a", { pending: 1 })],
      inbox_peek: [view("a", [entry("m1", "pending")])],
    });
    const r = await inboxStatus(["a"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queriedIds).toBeNull();
    expect(r.data.notFound).toEqual([]);
  });
});
