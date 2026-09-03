// pipelineHealthEscalation — the EDGE is the whole feature. These tests assert the SIDE EFFECTS
// (which channel was called, with what text), never merely that a handler exists, and they drive the
// real detector so a mutation to the gate or the routing reds one of them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineHealth } from "../stores/pipelineHealthStore";
import {
  WARNING_DEBOUNCE_MS,
  __resetPipelineEscalationForTests,
  composeEscalationMessage,
  detectEscalations,
  escalatePipelineHealth,
  liveEscalationDeps,
  remediationFor,
  roborevRemediation,
  type EscalationDeps,
  type EscalationEvent,
} from "./pipelineHealthEscalation";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/**
 * The live Tauri bridge, swappable per test. Only `liveEscalationDeps` reaches it; every other case
 * in this file injects its own deps and never calls `invoke`, so the default below is a tripwire
 * rather than a stub — a test that reaches Tauri unintentionally fails loudly instead of silently
 * resolving `undefined`.
 */
let invokeImpl: (cmd: unknown, args?: unknown) => Promise<string> = async (cmd) => {
  throw new Error(`unexpected invoke("${String(cmd)}") — this test did not set invokeImpl`);
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: unknown, args?: unknown) => invokeImpl(cmd, args),
}));
vi.mock("./conciergeNotifier", () => ({ notifyConcierge: () => false }));

/** Build a one-component snapshot with the given roborev state. */
function snap(state: PipelineHealth["overall"], detail = "detail text"): PipelineHealth {
  return {
    overall: state,
    components: [{ id: "roborev", name: "Code review (roborev)", state, detail }],
  };
}

/** A snapshot with two components in specified states. */
function twoSnap(
  roborev: PipelineHealth["overall"],
  ci: PipelineHealth["overall"],
): PipelineHealth {
  return {
    overall: "warning",
    components: [
      { id: "roborev", name: "Code review (roborev)", state: roborev, detail: "rr" },
      { id: "ci_runners", name: "CI test runners", state: ci, detail: "ci" },
    ],
  };
}

interface Recorder {
  concierge: string[];
  woke: string[];
  beads: EscalationEvent[];
  deps: EscalationDeps;
  now: number;
}

/** A recorder whose channels all SUCCEED, with a controllable clock. */
function recorder(now = 1_000_000): Recorder {
  const r: Recorder = {
    concierge: [],
    woke: [],
    beads: [],
    now,
    deps: undefined as unknown as EscalationDeps,
  };
  r.deps = {
    now: () => r.now,
    notifyConcierge: (t) => {
      r.concierge.push(t);
      return true;
    },
    wakeImprove: async (t) => {
      r.woke.push(t);
      return true;
    },
    fileDurableBead: async (ev) => {
      r.beads.push(ev);
    },
  };
  return r;
}

beforeEach(() => __resetPipelineEscalationForTests());
afterEach(() => __resetPipelineEscalationForTests());

describe("detectEscalations (pure edges)", () => {
  it("emits nothing on the FIRST reading (prev null) — a bad component at startup is steady state", () => {
    expect(detectEscalations(null, snap("blocking"))).toEqual([]);
  });

  it("green→blocking is a worse edge; blocking→blocking (steady) is not", () => {
    const up = detectEscalations(snap("healthy"), snap("blocking"));
    expect(up).toHaveLength(1);
    expect(up[0]!.severity).toBe("blocking");

    expect(detectEscalations(snap("blocking"), snap("blocking"))).toEqual([]);
  });

  it("warning→blocking escalates (worse), but blocking→warning (partial thaw) does NOT alarm", () => {
    expect(detectEscalations(snap("warning"), snap("blocking"))[0]!.severity).toBe("blocking");
    expect(detectEscalations(snap("blocking"), snap("warning"))).toEqual([]);
  });

  it("crossing INTO unknown never alarms, and out of unknown into warning DOES", () => {
    expect(detectEscalations(snap("healthy"), snap("unknown"))).toEqual([]);
    expect(detectEscalations(snap("blocking"), snap("unknown"))).toEqual([]);
    expect(detectEscalations(snap("unknown"), snap("warning"))[0]!.severity).toBe("warning");
  });

  it("bad→good is a recovery (from warning AND from blocking)", () => {
    expect(detectEscalations(snap("warning"), snap("healthy"))[0]!.severity).toBe("recovery");
    expect(detectEscalations(snap("blocking"), snap("not_applicable"))[0]!.severity).toBe("recovery");
  });

  it("skips a component with no baseline in prev (never alarms on first sighting)", () => {
    const prev = snap("healthy"); // only roborev
    const next = twoSnap("healthy", "blocking"); // ci_runners is new
    expect(detectEscalations(prev, next)).toEqual([]);
  });
});

describe("composeEscalationMessage + remediationFor", () => {
  it("names the component, the new severity, and the remediation on a blocking alarm", () => {
    // The detail is REAL classifier output (the WEDGE arm of ph_classify_roborev_not_answering),
    // not an invented phrase — the remedy is chosen from it, so a fabricated detail would assert
    // the fallback and prove nothing about the arm it claims to cover.
    const wedge = "the daemon process is ALIVE, and the store is only 12 MB — so this is a genuine WEDGE, not store slowness";
    const ev = detectEscalations(snap("healthy"), snap("blocking", wedge))[0]!;
    const msg = composeEscalationMessage(ev);
    expect(msg).toContain("Code review (roborev)");
    expect(msg).toContain("BLOCKING");
    expect(msg).toContain("genuine WEDGE");
    // A PROVEN wedge is the one reading where restarting is right — and it is kickstart, never
    // --watchdog and never `roborev daemon stop && start`.
    expect(msg).toContain("launchctl kickstart -k");
  });

  // ── THE REMEDY MUST AGREE WITH THE VERDICT (bead sparkle-ifs2cj) ────────────────────────────
  // Measured defect: the alert body read "this is SLOW, not wedged ... the probe is reporting its
  // own timeout" and the very next line read "run --watchdog to restart/compact the WEDGED daemon".
  // Following that restarts a healthy daemon, and on this machine that orphans 127.0.0.1:7373 —
  // which is the state that then blocks --compact entirely. A correct verdict with a wrong remedy
  // has fixed nothing for the human reading it.
  //
  // These details are the REAL strings ph_classify_roborev_not_answering emits. Asserting on
  // invented phrasing would exercise the fallback and silently stop covering the arms.
  const ARMS = {
    slow: "the daemon process is ALIVE and ~/.roborev/reviews.db is 975 MB — this is SLOW, not wedged: a store that size takes longer to open than the 8s probe waits, so the probe is reporting its own timeout",
    contended: "the status read is being THROTTLED by lock contention, not answered by a wedged daemon",
    undetermined: "and the cause is UNDETERMINED: the store size could not be read",
    wedge: "the daemon process is ALIVE, and the store is only 12 MB — so this is a genuine WEDGE, not store slowness",
    down: "there is no roborev daemon process — the review daemon is not running",
  };
  // Language that would send a reader to restart a daemon. `--watchdog` is included because that is
  // the flag the defective string named, and it heals by calling `launchctl kickstart -k`.
  //
  // THE LOOKBEHINDS ARE LOAD-BEARING, and this suite got it wrong twice before getting it right —
  // which is exactly AGENTS.md's "a copy ratchet that only bans a lie is half a ratchet". The
  // honest remedy for a SLOW reading has to say "DO NOT RESTART IT", and the honest remedy for a
  // wedge has to say "NOT `roborev daemon stop && roborev daemon start`". A bare banned-phrase
  // regex matches those required DENIALS and reds the correct copy — the failure output then reads
  // as if the assertion rejects the very sentence the fix exists to produce. So the ban is on
  // PRESCRIBING a restart, not on the word appearing.
  //
  // A lookbehind is fine HERE and must never leak into the shipped module: it is a parse error in
  // the safari14 WebView the desktop app pins.
  const PRESCRIBES_RESTART =
    /(?<!do )(?<!do not )(?<!never )(?<!not )(--watchdog|kickstart|roborev daemon stop|restart it|restart\/compact|restart the)/i;
  // `roborev daemon stop`, not a bare `daemon stop`: the SLOW remedy legitimately states that "the
  // VACUUM half needs the daemon stopped", which is a fact about the tool, not an instruction to
  // go and stop it. A looser pattern reds that sentence and pushes the author toward vaguer copy.

  it.each([
    ["SLOW", ARMS.slow],
    ["CONTENDED", ARMS.contended],
    ["UNDETERMINED", ARMS.undetermined],
    ["an unrecognised detail (the fail-safe default)", ""],
  ])("emits NO restart language on a %s reading", (_label, detail) => {
    const remedy = roborevRemediation(detail);
    expect(remedy, `a non-wedge reading must never prescribe a restart:\n${remedy}`).not.toMatch(
      PRESCRIBES_RESTART,
    );
    // Not merely silent about restarting — it must still say what TO do, or the alert is inert.
    expect(remedy).toMatch(/--status|--report|diagnose/i);
  });

  it("a SLOW reading leads with the ONLINE retention pass, not with the offline VACUUM", () => {
    // Compaction needs the fleet quiet and the daemon down, and on a busy machine that window may
    // not exist. Retention is an online UPDATE that needs neither, and measured on a copy of the
    // real store it reclaimed 72.4% in six seconds. So it has to come first in the sentence a
    // human acts on.
    const remedy = roborevRemediation(ARMS.slow);
    expect(remedy).toContain("roborev-retention-sweep.sh --report");
    expect(remedy).toMatch(/online/i);
    expect(remedy).toMatch(/DO NOT RESTART/i);
  });

  it.each([
    ["a proven WEDGE", ARMS.wedge],
    ["a proven ABSENCE", ARMS.down],
  ])("DOES prescribe launchd for %s — the split must not disarm the real cases", (_l, detail) => {
    // The dangerous direction is over-suppression: a guard that never prescribes a restart is safe
    // and useless. These two arms are the ones where acting is correct, and they must still say so.
    expect(roborevRemediation(detail)).toMatch(/launchctl/i);
    // ...but never PRESCRIBING the form this machine is documented as broken on.
    //
    // A bare `.not.toMatch(/roborev daemon start/)` is the wrong assertion and reds correct copy —
    // AGENTS.md's negative-only-ratchet trap. The honest remedy has to NAME that command in order
    // to warn the reader off it ("NOT `roborev daemon stop && roborev daemon start`"), so the
    // banned-phrase test matches its own required denial. Assert the PAIRING instead: if the string
    // mentions it at all, it must carry a negation cue in the same breath.
    const r = roborevRemediation(detail);
    if (/roborev daemon start/.test(r)) {
      expect(r, `naming the broken command without warning the reader off it:\n${r}`).toMatch(
        /NOT `roborev daemon|is broken/i,
      );
    }
  });

  it("has a codified remediation for every known pipeline component id", () => {
    for (const id of ["roborev", "ci_runners", "release_runner", "knightwatch", "release_publication"]) {
      expect(remediationFor(id), id).not.toBeNull();
    }
    expect(remediationFor("nope")).toBeNull();
  });

  it("a recovery message says RECOVERED and needs no remediation", () => {
    const ev = detectEscalations(snap("blocking"), snap("healthy", "back up"))[0]!;
    const msg = composeEscalationMessage(ev);
    expect(msg).toContain("RECOVERED");
    expect(msg).not.toContain("Remediation:");
  });

  // ── The two strings that were measured doing HARM ────────────────────────────────────────────
  // Both of these assert on the ABSENCE of specific advice, which is the side effect that matters:
  // a reader following either of the old strings took a costly or evidence-destroying action. They
  // fail against the previous wording, which is what makes them worth having.

  it("the release-publication remedy NEVER tells anyone to re-dispatch a held tag", () => {
    const remedy = remediationFor("release_publication")!;
    // release.yml's own error: "Fix the tree and cut a NEW version; re-dispatching this tag
    // re-hits the same red run." Following the old remedy burned a full signed notarized build.
    expect(remedy).not.toMatch(/before re-dispatching/i);
    expect(remedy).toMatch(/do not re-dispatch a held tag/i);
    // …and it names the two remedies that actually terminate.
    expect(remedy).toMatch(/cut a NEW version from green main/i);
    expect(remedy).toContain(".github/release-orphan-baseline.txt");
  });

  it("a RECOVERY never asserts 'no action needed' or orders a bead closed off one poll", () => {
    const ev = detectEscalations(snap("warning"), snap("healthy", "1 of 21 idle and ready"))[0]!;
    const msg = composeEscalationMessage(ev);
    // Measured: this exact shape announced recovery while 43 runs were queued and 20 of 21 runners
    // were busy — and then told the reader to close the bead that was tracking it.
    expect(msg).not.toMatch(/no action needed/i);
    expect(msg).not.toMatch(/close the pipeline-health bead/i);
    // It hands over the reading it was computed from and asks for confirmation instead.
    expect(msg).toContain("1 of 21 idle and ready");
    expect(msg).toMatch(/one poll of one component/i);
    expect(msg).toMatch(/confirm against that reading before closing/i);
  });
});

describe("escalatePipelineHealth — an alarm that reached NO sink is not `delivered`", () => {
  /** Every channel refused: the measured shape (inbox at its cap, `bd` not installed). */
  function deadSinks(now = 1_000_000): EscalationDeps {
    return {
      now: () => now,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
      fileDurableBead: async () => {
        throw new Error("bd not found — install beads or add `bd` to your PATH");
      },
    };
  }

  it("a blocking alarm whose concierge, inbox AND fail-safe bead all fail is reported UNDELIVERED", async () => {
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), deadSinks());

    // The side effect under test: it must NOT be counted as handled.
    expect(res.delivered).toHaveLength(0);
    expect(res.undelivered).toHaveLength(1);
    expect(res.undelivered[0]!.componentId).toBe("roborev");
    expect(res.undelivered[0]!.severity).toBe("blocking");
  });

  it("ONE surviving sink is still delivery — the concierge alone keeps it out of `undelivered`", async () => {
    // The paired case: same failing inbox and same throwing bead, one channel alive. Without this,
    // a rule that simply called every alarm undelivered would pass the test above.
    const deps: EscalationDeps = { ...deadSinks(), notifyConcierge: () => true };
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), deps);

    expect(res.delivered).toHaveLength(1);
    expect(res.undelivered).toHaveLength(0);
  });

  it("the fail-safe bead ALONE is delivery, even though both real-time channels refused", async () => {
    const filed: EscalationEvent[] = [];
    const deps: EscalationDeps = {
      ...deadSinks(),
      fileDurableBead: async (ev) => {
        filed.push(ev);
      },
    };
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), deps);

    expect(filed).toHaveLength(1);
    expect(res.delivered).toHaveLength(1);
    expect(res.undelivered).toHaveLength(0);
  });

  it("a RECOVERY files no bead, so both channels failing leaves it undelivered", async () => {
    // Recoveries deliberately skip the fail-safe bead, which makes the concierge and the inbox the
    // ONLY two sinks — so a recovery is the event most easily lost, and must say so.
    const res = await escalatePipelineHealth(snap("blocking"), snap("healthy", "back up"), deadSinks());

    expect(res.delivered).toHaveLength(0);
    expect(res.undelivered).toHaveLength(1);
    expect(res.undelivered[0]!.severity).toBe("recovery");
  });

  it("a healthy sweep reports an EMPTY undelivered list, not an absent one", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), r.deps);
    expect(res.undelivered).toEqual([]);
    expect(res.delivered).toHaveLength(1);
  });
});

describe("liveEscalationDeps.fileDurableBead — a RESOLVED create_bead_full is not a filed bead", () => {
  // These drive the PRODUCTION seam, not an injected stub: the defect lived entirely in
  // `liveEscalationDeps`, so a test that injects its own `fileDurableBead` (as every case above
  // does) cannot see it. Only the two real-time channels are stubbed off, because the shape being
  // reproduced is the measured one — improve inbox at its 50-message cap, no concierge window — in
  // which the bead is the LAST sink and its verdict alone decides delivered vs LOST.
  function beadOnly(payload: string | Error): EscalationDeps {
    invokeImpl = async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    };
    return {
      ...liveEscalationDeps("/tmp/project"),
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
    };
  }

  it("bd REFUSING the write (resolved `{error}`) leaves the alarm UNDELIVERED, not delivered", async () => {
    // The measured store state: schema behind the bd binary, so reads are served and every WRITE is
    // refused. `notes.rs::select_bd_result` hands that back as Ok("{\"error\":…}") by design, so the
    // old `await invoke(...)` resolved and the fail-safe claimed a bead it had not filed.
    const res = await escalatePipelineHealth(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly(`{"error":"database schema is out of date; writes are blocked"}`),
    );

    expect(res.delivered).toHaveLength(0);
    expect(res.undelivered).toHaveLength(1);
    expect(res.undelivered[0]!.componentId).toBe("roborev");
  });

  it("a clean exit with NO id is also a refusal — an unconfirmed write is not a floor", async () => {
    const res = await escalatePipelineHealth(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly(`{"warning":"nothing was created"}`),
    );
    expect(res.undelivered).toHaveLength(1);
  });

  it("non-JSON stdout is a refusal too, rather than being passed through as success", async () => {
    const res = await escalatePipelineHealth(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly("bd: unknown subcommand"),
    );
    expect(res.undelivered).toHaveLength(1);
  });

  it("PAIRED: bd returning a real id IS delivery — the guard is not refusing everything", async () => {
    // Without this the three cases above pass for a `fileDurableBead` that always throws, which
    // would silently retire the fail-safe rather than fix it.
    const res = await escalatePipelineHealth(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly(`{"id":"sparkle-abc12"}`),
    );

    expect(res.delivered).toHaveLength(1);
    expect(res.undelivered).toHaveLength(0);
  });

  it("the refused write still reaches bd — the guard checks the RESULT, it does not skip the call", async () => {
    // Pins that the fix is a verdict on the payload and not an early return: a fail-safe that stops
    // calling bd would satisfy every assertion above while filing nothing when the store is healthy.
    const calls: unknown[] = [];
    invokeImpl = async (cmd: unknown, args: unknown) => {
      calls.push([cmd, args]);
      return `{"error":"writes are blocked"}`;
    };
    const deps: EscalationDeps = {
      ...liveEscalationDeps("/tmp/project"),
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
    };
    await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), deps);

    expect(calls).toHaveLength(1);
    const [cmd, args] = calls[0] as [string, Record<string, string>];
    expect(cmd).toBe("create_bead_full");
    // …and with the dedupe labels the hourly scan folds onto, so the fix did not disturb them.
    expect(args.labels).toContain("phc-roborev");
    expect(args.labels).toContain("pipeline-health");
  });
});

describe("escalatePipelineHealth — routing + gating side effects", () => {
  it("green→blocking fires EXACTLY ONE escalation to BOTH channels, naming component+severity+remediation", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), r.deps);

    expect(res.delivered).toHaveLength(1);
    expect(r.concierge).toHaveLength(1);
    expect(r.woke).toHaveLength(1);
    // The wake (Improve-Sparkle) AND the concierge both carry the actionable body.
    for (const t of [r.concierge[0]!, r.woke[0]!]) {
      expect(t).toContain("Code review (roborev)");
      expect(t).toContain("BLOCKING");
      // An actionable remedy still reaches BOTH channels — it is just the one that agrees with
      // the reading. With no recognised detail that is the diagnose-first text, never a restart.
      expect(t).toContain("diagnose before acting");
      expect(t).not.toMatch(/--watchdog|restart the wedged|restart\/compact/i);
    }
    // Both channels succeeded → NO fail-safe bead.
    expect(r.beads).toHaveLength(0);
  });

  it("a bad→bad steady state does NOT re-fire (edge-triggered, not steady-state)", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("blocking"), snap("blocking"), r.deps);
    expect(r.concierge).toHaveLength(0);
    expect(r.woke).toHaveLength(0);
  });

  it("a WARNING is debounced: a second warning edge for the same component inside the window is suppressed", async () => {
    const r = recorder();
    // First warning edge fires.
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(1);

    // A second warning edge for the same component, still inside the debounce window. (No recovery
    // is driven here on purpose — the flap that crosses one is the separate test below, and it is
    // the case this one used to CLAIM in a comment while never exercising it.)
    r.now += WARNING_DEBOUNCE_MS - 1;
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(res.delivered).toHaveLength(0);
    expect(res.debounced).toHaveLength(1);
    expect(r.woke).toHaveLength(1); // still just the first

    // Past the window, it fires again.
    r.now += 2;
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(2);
  });

  it("BLOCKING is NEVER debounced, even back-to-back within the warning window", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    r.now += 1000; // well inside WARNING_DEBOUNCE_MS
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    expect(r.woke).toHaveLength(2);
  });

  it("UNKNOWN does not alarm — a crossing into unknown reaches neither channel", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("unknown"), r.deps);
    expect(r.concierge).toHaveLength(0);
    expect(r.woke).toHaveLength(0);
    expect(r.beads).toHaveLength(0);
  });

  it("bad→green fires a RECOVERY notice (and never files a bead)", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("blocking"), snap("healthy", "back up"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("recovery");
    expect(r.concierge[0]).toContain("RECOVERED");
    expect(r.woke[0]).toContain("RECOVERED");
    expect(r.beads).toHaveLength(0); // recovery never files a bead
  });

  // ── THE FLAP: green→warning→green→warning on the poll interval ────────────────────────────────
  // This is the condition WARNING_DEBOUNCE_MS exists for, and the one the gate could not suppress:
  // the flap crosses a RECOVERY every cycle, and the recovery used to clear the debounce, so the
  // next warning always re-fired. Both channels alternated alarm/all-clear 61s apart in production,
  // each wake costing a full agent turn. Drive the real edges, on the real cadence.
  const POLL_MS = 61_000;

  it("a flapping component goes SILENT after its first announced cycle — both channels", async () => {
    const r = recorder();
    // Cycle 1: announced in full, so a reader learns of the degradation and its clearing.
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // 1 warning + 1 recovery
    expect(r.concierge).toHaveLength(2);

    // Cycles 2..10, all well inside the 30-minute window: NOTHING more is delivered. Neither the
    // warning (debounced) nor its recovery (an all-clear for an alarm nobody was told about).
    for (let i = 0; i < 9; i++) {
      r.now += POLL_MS;
      const up = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
      expect(up.delivered).toHaveLength(0);
      expect(up.debounced).toHaveLength(1);
      r.now += POLL_MS;
      const down = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
      expect(down.delivered).toHaveLength(0);
    }
    expect(r.woke).toHaveLength(2); // still just the first cycle
    expect(r.concierge).toHaveLength(2);
    expect(r.beads).toHaveLength(0); // a debounced alarm is not a failed delivery
  });

  it("a warning fires again once the window elapses, even though recoveries intervened", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    // Flap through the whole window; every cycle after the first is silent.
    for (let i = 0; i < 5; i++) {
      r.now += POLL_MS;
      await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
      r.now += POLL_MS;
      await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    }
    expect(r.woke).toHaveLength(2); // the first warning + the first recovery, nothing since

    // Past the window, a genuinely new warning is NOT swallowed.
    r.now += WARNING_DEBOUNCE_MS;
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("warning");
    expect(r.woke).toHaveLength(3);
  });

  // ── A BLOCKING ALARM'S ALL-CLEAR IS NOT THE FLAP'S TO SWALLOW ─────────────────────────────────
  // The suppression rule is "do not announce the clearing of an alarm nobody was told about". A
  // BLOCKING alarm is always told, so its recovery must always be told too — but `blocking` short-
  // circuited the gate without touching the suppression flag, so a flap's debounced WARNING left a
  // flag standing that the blocking recovery then consumed. The component is announced as blocking
  // and never announced as recovered: per this module's own contract the recovery is what lets the
  // improvement pass close the P1 bead, so the deployment reads BLOCKED indefinitely after it is
  // green again. Reachable on the real cadence — ci_runners flaps green↔warning on the 60s poll.
  it("a BLOCKING alarm's recovery fires even when a debounced warning left a flag standing", async () => {
    const r = recorder();
    // Cycle 1: announced in full, so the debounce window is now open for this component.
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(r.woke).toHaveLength(2);

    // Cycle 2's warning is debounced — this is what raises the suppression flag.
    r.now += POLL_MS;
    const flapped = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(flapped.debounced).toHaveLength(1);

    // The pool now genuinely goes down. BLOCKING is never debounced, so it IS announced.
    r.now += POLL_MS;
    const blocked = await escalatePipelineHealth(snap("warning"), snap("blocking"), r.deps);
    expect(blocked.delivered).toHaveLength(1);
    expect(blocked.delivered[0]!.severity).toBe("blocking");
    expect(r.woke).toHaveLength(3);

    // …and its all-clear must reach both channels. This is the assertion the bug failed.
    r.now += POLL_MS;
    const recovered = await escalatePipelineHealth(snap("blocking"), snap("healthy", "back up"), r.deps);
    expect(recovered.delivered).toHaveLength(1);
    expect(recovered.delivered[0]!.severity).toBe("recovery");
    expect(r.woke).toHaveLength(4);
    expect(r.woke[3]).toContain("RECOVERED");
    expect(r.concierge).toHaveLength(4);
  });

  it("a recovery with no SUPPRESSED warning behind it always fires — the startup baseline case", async () => {
    // The first poll establishes a baseline without alerting, so a component already warning at
    // launch has no delivered alarm. Its recovery is what tells the improvement pass that an open
    // pipeline-health bead can be closed, so it must not be swallowed.
    const r = recorder();
    const res = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("recovery");
    expect(r.woke[0]).toContain("RECOVERED");
  });

  it("the debounce is PER COMPONENT: one flapping component does not silence another's alarm", async () => {
    const r = recorder();
    // roborev flaps into its debounce.
    await escalatePipelineHealth(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(twoSnap("warning", "healthy"), twoSnap("healthy", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // roborev's first warning + first recovery only

    // ci_runners' FIRST warning still gets through, inside roborev's window.
    r.now += POLL_MS;
    const res = await escalatePipelineHealth(
      twoSnap("warning", "healthy"),
      twoSnap("warning", "warning"),
      r.deps,
    );
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.componentId).toBe("ci_runners");
    expect(r.woke).toHaveLength(3);
  });

  it("FAIL-SAFE: when the durable inbox wake fails, the alarm still files a durable bead", async () => {
    const r = recorder();
    // Both real-time channels fail: concierge unmounted (false), inbox doorbell rejects.
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => false,
      wakeImprove: async () => {
        throw new Error("inbox down");
      },
      fileDurableBead: async (ev) => {
        r.beads.push(ev);
      },
    };
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    // The real-time push failed on both channels, but the durable bead is filed — nothing is lost.
    expect(r.beads).toHaveLength(1);
    expect(r.beads[0]!.componentId).toBe("roborev");
    expect(r.beads[0]!.severity).toBe("blocking");
  });

  it("does NOT file a fail-safe bead when the durable wake SUCCEEDED even if the concierge failed", async () => {
    const r = recorder();
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => false, // concierge unmounted
      wakeImprove: async () => true, // durable channel landed
      fileDurableBead: async (ev) => {
        r.beads.push(ev);
      },
    };
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    expect(r.beads).toHaveLength(0); // inbox is durable; no bead needed
  });

  it("does not throw when a channel throws — a watchdog never takes the poll down", async () => {
    const r = recorder();
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => {
        throw new Error("boom");
      },
      wakeImprove: async () => true,
      fileDurableBead: async () => {},
    };
    await expect(
      escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps),
    ).resolves.toBeDefined();
  });
});
