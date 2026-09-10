// pipelineHealthEscalation — the EDGE is the whole feature. These tests assert the SIDE EFFECTS
// (which channel was called, with what text), never merely that a handler exists, and they drive the
// real detector so a mutation to the gate or the routing reds one of them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineHealth } from "../stores/pipelineHealthStore";
import {
  WARNING_CONFIRMATIONS,
  WARNING_DEBOUNCE_MS,
  __resetPipelineEscalationForTests,
  composeEscalationMessage,
  detectEscalations,
  escalatePipelineHealth,
  liveEscalationDeps,
  releaseRunnerRemediation,
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

/**
 * Drive a blocking edge through its CONFIRMATION WINDOW and return the sweep that ANNOUNCES it.
 *
 * `BLOCKING_CONFIRMATIONS` (2) means a blocking reading opens a streak on the poll that detects it
 * and is announced on the next poll that still reads blocking — so every test about what an
 * ANNOUNCED blocking alarm DOES has to drive two sweeps. The second sweep passes `next` as both
 * sides deliberately: it is the STEADY state, which emits no edge of its own, so anything delivered
 * there came from the deferred alarm being confirmed and from nothing else.
 *
 * Tests about the WINDOW ITSELF drive their sweeps by hand — see "blocking confirmation window".
 */
/**
 * Drive a WARNING edge through its confirmation window and return the sweep that ANNOUNCES it.
 *
 * `WARNING_CONFIRMATIONS` (3) means a warning reading opens a streak on the poll that detects it and
 * is announced on the third consecutive reading (bead sparkle-00dmmc). Every test about what an
 * ANNOUNCED warning does — including the ones about the DEBOUNCE, since a warning must be confirmed
 * before it can reach the gate at all — therefore drives that many sweeps. The confirming sweeps pass
 * `next` as both sides: the STEADY state emits no edge of its own, so anything delivered there came
 * from the deferred alarm being confirmed and nothing else.
 */
async function escalateWarning(
  prev: PipelineHealth,
  next: PipelineHealth,
  deps: EscalationDeps,
) {
  await escalatePipelineHealth(prev, next, deps);
  for (let i = 2; i < WARNING_CONFIRMATIONS; i++) await escalatePipelineHealth(next, next, deps);
  return escalatePipelineHealth(next, next, deps);
}

async function escalateBlocking(
  prev: PipelineHealth,
  next: PipelineHealth,
  deps: EscalationDeps,
) {
  await escalatePipelineHealth(prev, next, deps);
  return escalatePipelineHealth(next, next, deps);
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

  // ── The reviewer remedy must follow the CONFIGURED reviewer (bead `sparkle-0wb6zp`) ──────────
  //
  // `[review].pr_reviewer` flipped to `knightwatch` on 2026-09-03. `pipeline_health.rs` was keyed to
  // the configured reviewer on 2026-09-08 (`restart_remedy`, bead `sparkle-9hs48d`) and so was
  // `scripts/lib/pipeline-health.sh` — but THIS file's canned remedy stayed hard-coded to
  // `sparkle-reviewer` and to `scripts/pr-review.sh`, the babysit-sweep path. Under a knightwatch
  // config that produced an alert CONTRADICTING ITS OWN EVIDENCE: the detail said knightwatch and
  // `/srosro-update-review`, and the `Remediation:` line appended directly under it named the
  // retired reviewer and prescribed a command that reviews nothing knightwatch is waiting on.
  //
  // AGENTS.md: a remedy string is an instruction someone will follow, so it must be safe under the
  // conditions that produced the alarm. These cases are PAIRED so the fix cannot be satisfied by
  // swapping one hard-coded reviewer for the other.

  /** The real `classify_knightwatch` Warning details, verbatim — the strings this keys on. */
  const REVIEWER_DETAIL = {
    knightwatch:
      "no recent 'knightwatch' review was found and open PR(s) are waiting — the reviewer may not " +
      "be running. Reviews are posted by knightwatch on another machine; trigger one by commenting " +
      "`/srosro-update-review` on a waiting PR and confirm the review lands.",
    sparkle:
      "no recent 'sparkle-reviewer' review was found and open PR(s) are waiting — the reviewer may " +
      "not be running. Reviews are dispatched by the app's babysit sweep; run " +
      "`scripts/pr-review.sh <PR#> --post` to review manually.",
  } as const;

  it("the reviewer remedy follows a KNIGHTWATCH reading — never naming the retired reviewer", () => {
    const remedy = remediationFor("knightwatch", REVIEWER_DETAIL.knightwatch)!;
    expect(remedy, `remedy for a knightwatch reading:\n${remedy}`).not.toMatch(/sparkle-reviewer/i);
    expect(remedy, "prescribes the babysit-sweep path knightwatch does not use").not.toContain(
      "scripts/pr-review.sh",
    );
    expect(remedy, "says nothing about the reviewer the reading is actually about").toMatch(
      /knightwatch/i,
    );
  });

  it("the reviewer remedy follows a SPARKLE-REVIEWER reading — the paired half", () => {
    // Without this half the case above is satisfied by swapping one hard-code for the other, which
    // breaks again the moment `pr_reviewer` moves back — exactly how this defect was introduced.
    const remedy = remediationFor("knightwatch", REVIEWER_DETAIL.sparkle)!;
    expect(remedy, `remedy for a sparkle-reviewer reading:\n${remedy}`).toContain(
      "scripts/pr-review.sh",
    );
    expect(remedy, "prescribes knightwatch's trigger for a sparkle-reviewer reading").not.toContain(
      "/srosro-update-review",
    );
  });

  it("an unrecognised reviewer reading names NEITHER reviewer — the safety default", () => {
    // Mirrors `roborevRemediation`'s default: an arm this function has never seen degrades to "go
    // and look", never to a confident instruction about a reviewer the reading never mentioned.
    for (const detail of ["", undefined, "some future classifier arm nobody has written yet"]) {
      const remedy = remediationFor("knightwatch", detail)!;
      expect(remedy, `named a reviewer it has no evidence for:\n${remedy}`).not.toMatch(
        /sparkle-reviewer|srosro-update-review|scripts\/pr-review\.sh/i,
      );
    }
  });

  it("the knightwatch remedy never DIAGNOSES a cause the reading cannot support", () => {
    // bead `sparkle-gazo4a`: "is unavailable" is an ABSENCE CLAIM, and this component cannot make
    // one. A QUOTA-BLOCKED knightwatch is perfectly healthy and posts `\u23f8 knightwatch paused`
    // every ~2 minutes, and those lifecycle posts are deliberately excluded from
    // `last_review_age_secs` — so a paused reviewer is exactly what drives classify_knightwatch
    // into the Warning arm this remedy is appended to. An operator following an unqualified
    // "its access is gone" repoints the repo's configured reviewer away from one that is fine.
    const remedy = remediationFor("knightwatch", REVIEWER_DETAIL.knightwatch)!;
    expect(remedy, `asserts a cause this reading cannot establish:\n${remedy}`).not.toMatch(
      /access is gone|is down\b|is unavailable|has stopped|no longer has access/i,
    );

    // THE PAIRED POSITIVE HALF — a negative alone is green over a remedy trimmed to silence, which
    // is the AGENTS.md negative-only-ratchet trap. Dropping the verdict must not drop the guidance:
    // the arm still has to name what WOULD settle it, and condition the config change on that read
    // rather than on a timeout.
    expect(remedy, "dropped the tool that would actually settle it").toContain(
      "scripts/reviewer-liveness-check.sh",
    );
    expect(remedy, "repointing must be conditioned on a read, not on a 15-minute silence").toMatch(
      /only once/i,
    );
  });

  it("the composed alert never contradicts the reading it is attached to", () => {
    // The side effect that actually reached the founder: detail and Remediation in ONE message,
    // naming two different reviewers and two mutually useless remedies.
    const ev: EscalationEvent = {
      componentId: "knightwatch",
      name: "PR reviewer",
      from: "healthy",
      to: "warning",
      severity: "warning",
      detail: REVIEWER_DETAIL.knightwatch,
      remediation: remediationFor("knightwatch", REVIEWER_DETAIL.knightwatch),
    };
    const msg = composeEscalationMessage(ev);
    expect(msg, "the remedy was dropped entirely").toContain("Remediation:");
    expect(
      msg,
      `the alert names the retired reviewer beside a knightwatch reading:\n${msg}`,
    ).not.toMatch(/sparkle-reviewer/i);
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
    const res = await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), deadSinks());

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
    const res = await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), deps);

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
    const res = await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), deps);

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
    const res = await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), r.deps);
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
    const res = await escalateBlocking(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly(`{"error":"database schema is out of date; writes are blocked"}`),
    );

    expect(res.delivered).toHaveLength(0);
    expect(res.undelivered).toHaveLength(1);
    expect(res.undelivered[0]!.componentId).toBe("roborev");
  });

  it("a clean exit with NO id is also a refusal — an unconfirmed write is not a floor", async () => {
    const res = await escalateBlocking(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly(`{"warning":"nothing was created"}`),
    );
    expect(res.undelivered).toHaveLength(1);
  });

  it("non-JSON stdout is a refusal too, rather than being passed through as success", async () => {
    const res = await escalateBlocking(
      snap("healthy"),
      snap("blocking", "wedged"),
      beadOnly("bd: unknown subcommand"),
    );
    expect(res.undelivered).toHaveLength(1);
  });

  it("PAIRED: bd returning a real id IS delivery — the guard is not refusing everything", async () => {
    // Without this the three cases above pass for a `fileDurableBead` that always throws, which
    // would silently retire the fail-safe rather than fix it.
    const res = await escalateBlocking(
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
    await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), deps);

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
    const res = await escalateBlocking(snap("healthy"), snap("blocking", "wedged"), r.deps);

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
    await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(1);

    // A second warning edge for the same component, still inside the debounce window. (No recovery
    // is driven here on purpose — the flap that crosses one is the separate test below, and it is
    // the case this one used to CLAIM in a comment while never exercising it.)
    r.now += WARNING_DEBOUNCE_MS - 1;
    const res = await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    expect(res.delivered).toHaveLength(0);
    expect(res.debounced).toHaveLength(1);
    expect(r.woke).toHaveLength(1); // still just the first

    // Past the window, it fires again.
    r.now += 2;
    await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(2);
  });

  it("a CONFIRMED blocking is never debounced, even back-to-back within the warning window", async () => {
    const r = recorder();
    await escalateBlocking(snap("healthy"), snap("blocking"), r.deps);
    r.now += 1000; // well inside WARNING_DEBOUNCE_MS
    await escalateBlocking(snap("healthy"), snap("blocking"), r.deps);
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
    await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // 1 warning + 1 recovery
    expect(r.concierge).toHaveLength(2);

    // Cycles 2..10, all well inside the 30-minute window: NOTHING more is delivered. Neither the
    // warning (debounced) nor its recovery (an all-clear for an alarm nobody was told about).
    for (let i = 0; i < 9; i++) {
      r.now += POLL_MS;
      const up = await escalateWarning(snap("healthy"), snap("warning"), r.deps);
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
    await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    // Flap through the whole window; every cycle after the first is silent.
    for (let i = 0; i < 5; i++) {
      r.now += POLL_MS;
      await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
      r.now += POLL_MS;
      await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    }
    expect(r.woke).toHaveLength(2); // the first warning + the first recovery, nothing since

    // Past the window, a genuinely new warning is NOT swallowed.
    r.now += WARNING_DEBOUNCE_MS;
    const res = await escalateWarning(snap("healthy"), snap("warning"), r.deps);
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
    await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(r.woke).toHaveLength(2);

    // Cycle 2's warning is debounced — this is what raises the suppression flag.
    r.now += POLL_MS;
    const flapped = await escalateWarning(snap("healthy"), snap("warning"), r.deps);
    expect(flapped.debounced).toHaveLength(1);

    // The pool now genuinely goes down. BLOCKING is never debounced, so it IS announced.
    r.now += POLL_MS;
    const blocked = await escalateBlocking(snap("warning"), snap("blocking"), r.deps);
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
    await escalateWarning(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(twoSnap("warning", "healthy"), twoSnap("healthy", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalateWarning(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // roborev's first warning + first recovery only

    // ci_runners' FIRST warning still gets through, inside roborev's window.
    r.now += POLL_MS;
    const res = await escalateWarning(
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
    await escalateBlocking(snap("healthy"), snap("blocking"), r.deps);
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
    await escalateBlocking(snap("healthy"), snap("blocking"), r.deps);
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
      escalateWarning(snap("healthy"), snap("warning"), r.deps),
    ).resolves.toBeDefined();
  });
});

// ── THE BLOCKING CONFIRMATION WINDOW (bead sparkle-00dmmc) ───────────────────────────────────────
//
// THE MEASURED INCIDENT. On 2026-09-08 the release-runner component crossed green→blocking on ONE
// 60s poll and was announced instantly with "Wake the release Mac and re-check." The Mac was never
// asleep in any way that needed waking: `ph_classify_release_runner` blocks on a REGISTERED-but-
// offline runner by design (scripts/lib/pipeline-health.sh: "an offline-but-registered runner still
// appears in the list, so SAW=1 and the arm blocks"), which is exactly how a Mac idling between jobs
// presents. The next poll was green. The alarm self-resolved having shipped remediation that would
// have been wrong to run — and it shipped because `passesGate` returned true for `blocking`
// unconditionally, with the comment "blocking is never debounced, so the reader was always told."
//
// The hourly `pipeline-health-scan.sh` did NOT file a bead for the same reading, because its own
// hysteresis (`PH_HYSTERESIS_PASSES`, default 2) holds the store write until a second consecutive
// non-green pass. The two surfaces disagreed: the scan wanted confirmation, the real-time path took
// none. These tests pin the real-time path to the same rule.
//
// WHY THIS CANNOT BE TESTED AS A DEBOUNCE. Detection is EDGE-triggered, so a component that is
// blocking and STAYS blocking emits no second event — there is nothing for a time-window gate to
// suppress. Confirmation therefore has to be a DEFERRAL re-evaluated against each later snapshot,
// which is why every case below drives at least two polls.
describe("blocking confirmation window", () => {
  /** A one-component release-runner snapshot — the component tonight's incident was about. */
  function relSnap(state: PipelineHealth["overall"]): PipelineHealth {
    return {
      overall: state,
      components: [
        {
          id: "release_runner",
          name: "Release runner (DMG build)",
          state,
          detail:
            "the macOS release runner (sparkle-release) is offline — no notarized DMG can be built until it is back online. Wake the release Mac and re-check.",
        },
      ],
    };
  }

  it("HOLDS a first blocking reading instead of announcing it", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);

    expect(res.delivered, "one poll must never be enough to page").toEqual([]);
    expect(r.concierge, "nothing may reach the concierge on an unconfirmed blocking").toEqual([]);
    expect(r.woke, "nothing may wake Improve-Sparkle on an unconfirmed blocking").toEqual([]);
    expect(r.beads, "an unconfirmed alarm must not file its fail-safe bead either").toEqual([]);
  });

  it("ANNOUNCES a blocking state that is still blocking on the next poll", async () => {
    const r = recorder();
    await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);
    // Steady state: `detectEscalations` yields NO event here (from === to), so the announcement can
    // only come from the deferred alarm being re-confirmed against this snapshot.
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("blocking"), r.deps);

    expect(res.delivered.map((e) => e.componentId)).toEqual(["release_runner"]);
    expect(r.concierge.length, "a confirmed outage must still reach the concierge").toBe(1);
    expect(r.concierge[0]).toContain("Wake the release Mac");
  });

  it("announces NOTHING for a blip that clears before it is confirmed — tonight's incident", async () => {
    const r = recorder();
    await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);

    expect(res.delivered, "the blip must not page").toEqual([]);
    // And the RECOVERY must be silent too: announcing the all-clear for an alarm nobody heard is the
    // half-loud flap the warning debounce already learned to avoid.
    expect(r.concierge, "no alarm and no all-clear for an unannounced alarm").toEqual([]);
    expect(r.woke).toEqual([]);
  });

  it("re-confirms from scratch after a clear — a second blip is not the first one's second poll", async () => {
    const r = recorder();
    await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);
    await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    const res = await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);

    expect(res.delivered, "the streak must reset on green, or two blips read as one outage").toEqual(
      [],
    );
    expect(r.concierge).toEqual([]);
  });

  // ── DROPPING AN UNCONFIRMED BLOCKING MUST NOT EAT SOMEBODY ELSE'S ALL-CLEAR (roborev job 82171) ─
  //
  // `unannouncedAlarm` means "an alarm is outstanding that nobody was told about", and the recovery
  // gate CONSUMES it. Setting it unconditionally when a streak is dropped is wrong whenever the
  // deferred blocking rose out of a warning that WAS announced: the reader heard WARNING, and the
  // all-clear that follows is the notice that closes it — including for the improvement pass, which
  // reads a recovery as permission to close the P1 bead. Suppressing it leaves a green deployment
  // reported as degraded, which is the identical harm `passesGate`'s blocking branch already
  // documents for the other direction.
  //
  // These two are a PAIR and neither works alone: the first proves the all-clear survives, the second
  // proves the suppression still fires when the warning underneath really was swallowed. A fix that
  // simply stopped setting the flag would pass the first and fail the second.
  it("delivers the RECOVERY for an announced warning sitting under an unconfirmed blocking", async () => {
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the warning is announced — the reader HAS heard it").toBe(1);

    // Worsens to blocking, which is held pending confirmation. Nothing new is announced.
    await escalatePipelineHealth(relSnap("warning"), relSnap("blocking"), r.deps);
    expect(r.concierge.length, "the blocking is unconfirmed, so it is not announced").toBe(1);

    // …and clears before it confirms. The alarm the reader was told about is the WARNING, and its
    // all-clear must still arrive.
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    expect(res.delivered.map((e) => e.severity)).toEqual(["recovery"]);
    expect(r.concierge.length, "the announced warning must get its all-clear").toBe(2);
  });

  it("still SUPPRESSES the recovery when the warning underneath was itself debounced", async () => {
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    await escalatePipelineHealth(relSnap("warning"), relSnap("healthy"), r.deps);
    const announced = r.concierge.length; // warning + its recovery

    // A second warning edge inside WARNING_DEBOUNCE_MS is swallowed, and `passesGate` flags it as
    // unannounced itself.
    r.now += 1000;
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the second warning is debounced").toBe(announced);

    await escalatePipelineHealth(relSnap("warning"), relSnap("blocking"), r.deps);
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    expect(res.delivered, "nothing was announced, so nothing may be un-announced").toEqual([]);
    expect(r.concierge.length).toBe(announced);
  });

  // ── …AND THE SAME MUST HOLD ONE HOP THROUGH `unknown` (roborev job 82208) ──────────────────────
  //
  // `unknown` is the state a component lands in when its probe times out, and it is NEITHER good NOR
  // an alarm. A drop guard that asked `!isAlarmState(pending.ev.from)` therefore mis-classified a
  // streak that reached blocking via a timed-out probe and re-ate the announced warning's all-clear
  // — the same bug, one hop away. These two pin the fact rather than the proxy: the first proves the
  // all-clear survives the detour, the second proves a streak with nothing underneath it is still
  // suppressed. A guard hardcoded to never flag would pass the first and fail the second.
  it("delivers the RECOVERY when the streak reached blocking via unknown, over an announced warning", async () => {
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the warning is announced").toBe(1);

    // The probe times out. `detectEscalations` emits nothing: not a worse edge, and `unknown` is not
    // a good state, so it is not a recovery either.
    const quiet = await escalatePipelineHealth(relSnap("warning"), relSnap("unknown"), r.deps);
    expect(quiet.delivered, "crossing into unknown never alarms").toEqual([]);

    await escalatePipelineHealth(relSnap("unknown"), relSnap("blocking"), r.deps);
    expect(r.concierge.length, "the blocking is unconfirmed").toBe(1);

    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    expect(res.delivered.map((e) => e.severity)).toEqual(["recovery"]);
    expect(r.concierge.length, "the announced warning still gets its all-clear").toBe(2);
  });

  it("stays silent for an unknown-to-blocking blip with nothing announced underneath it", async () => {
    const r = recorder();
    const res0 = await escalatePipelineHealth(relSnap("unknown"), relSnap("blocking"), r.deps);
    expect(res0.delivered, "unconfirmed, so nothing is announced").toEqual([]);

    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    expect(res.delivered, "no alarm was ever announced, so its all-clear is noise").toEqual([]);
    expect(r.concierge).toEqual([]);
  });

  // ── THE RECORD MUST BE RETIRED AGAINST THE SNAPSHOT, NOT A RECOVERY EVENT (roborev job 82209) ──
  //
  // `announcedAlarm` was cleared in exactly one place: the recovery branch of `passesGate`. But
  // `detectEscalations` emits a recovery only for `isAlarmState(from) && isGoodState(to)`, and
  // crossing OUT of `unknown` emits nothing — so an alarm that ends via `alarm → unknown → good`
  // left a PERMANENTLY stale entry, and the next unrelated blip read it as "the reader has been
  // told" and delivered an all-clear for an alarm nobody ever heard. Under a flap that is the
  // unbroken alternating stream ~61s apart this module exists to stop.
  //
  // Note this was a REGRESSION from the proxy it replaced: `!isAlarmState(pending.ev.from)` could
  // not go stale, because it read the edge in front of it rather than a remembered fact. Replacing
  // a proxy with a record is only an improvement if the record is also RETIRED correctly.
  it("retires an announced alarm that ends through unknown, so a later blip stays silent", async () => {
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the warning is announced").toBe(1);

    // The probe stops answering, then comes back green. NEITHER crossing emits an event: `unknown`
    // is not a worse state and not a good one, so there is no recovery to retire the record.
    await escalatePipelineHealth(relSnap("warning"), relSnap("unknown"), r.deps);
    await escalatePipelineHealth(relSnap("unknown"), relSnap("healthy"), r.deps);

    // A LATER, UNRELATED blip. Nothing about it was ever announced.
    await escalatePipelineHealth(relSnap("healthy"), relSnap("blocking"), r.deps);
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);

    expect(res.delivered, "an all-clear for an alarm nobody heard is pure noise").toEqual([]);
    expect(r.concierge.length, "still just the one warning from the start").toBe(1);
  });

  it("does not count a ZERO-SINK alarm as announced", async () => {
    // `passesGate` runs BEFORE routing, so an event that passes the gate and then reaches no sink at
    // all — the `undelivered` partition, whose own doc says the event "is simply gone" — was still
    // recorded as "the reader HAS been told". It had not been.
    const dead: EscalationDeps = {
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
      fileDurableBead: async () => {
        throw new Error("bd unavailable");
      },
    };
    const lost = await escalateWarning(relSnap("healthy"), relSnap("warning"), dead);
    expect(lost.undelivered, "the warning reached nothing").toHaveLength(1);
    expect(lost.delivered).toEqual([]);

    await escalatePipelineHealth(relSnap("warning"), relSnap("blocking"), dead); // held

    // Now the blip clears, with working channels. The all-clear must still be silent: the alarm
    // underneath it was never actually delivered to anyone.
    const r = recorder();
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r.deps);
    expect(res.delivered, "nothing was ever announced, so nothing may be un-announced").toEqual([]);
    expect(r.concierge).toEqual([]);
  });

  // ── …AND THE SUPPRESSION FLAG IS THE HALF THAT ACTUALLY GATES DELIVERY (roborev job 82210) ────
  //
  // The test above routes its clearing through `advancePendingBlocking`'s drop branch, which reads
  // `announcedAlarm` — so it exercises only the record that was moved to the sink result. The RECOVERY
  // gate reads the OTHER one, `unannouncedAlarm`, and that write stayed at gate time: an alarm that
  // passed the gate and reached no sink still CLEARED its suppression flag, so its later all-clear was
  // announced for an alarm nobody heard, waking a full Improve-Sparkle turn to close a bead that was
  // never opened. Two lines from the one that was fixed.
  //
  // This drives the measured shape the module documents: the improve inbox at its 50-message cap and
  // `bd` not installed, so every channel refuses — then the channels come back.
  it("a zero-sink alarm leaves the suppression flag SET, so its later all-clear stays silent", async () => {
    const dead: EscalationDeps = {
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
      fileDurableBead: async () => {
        throw new Error("bd unavailable");
      },
    };
    const lost = await escalateWarning(relSnap("healthy"), relSnap("warning"), dead);
    expect(lost.undelivered, "the warning reached nothing at all").toHaveLength(1);
    expect(lost.delivered).toEqual([]);

    // Channels recover, and so does the component. The all-clear must NOT be announced.
    const r = recorder();
    const res = await escalatePipelineHealth(relSnap("warning"), relSnap("healthy"), r.deps);
    expect(res.delivered, "an all-clear for an alarm that reached nobody is pure noise").toEqual([]);
    expect(r.concierge).toEqual([]);
    expect(r.woke, "and it must not wake the improvement pass either").toEqual([]);
  });

  // ── …BUT SUPPRESSION NEEDS THE CONJUNCT ITS SIBLING CARRIES (roborev job 82211) ────────────────
  //
  // The two sink-result writes are NOT symmetric, and assuming they were is what this pins.
  // `announcedAlarm.add` beside `delivered` is safe unconditionally: a set record can only BROADEN
  // later delivery. `unannouncedAlarm.add` beside `undelivered` SUPPRESSES, so it needs the same
  // "was anything announced underneath" conjunct `advancePendingBlocking`'s drop branch already
  // carries — otherwise a LOST alarm stacked on an ALREADY-DELIVERED one swallows that one's
  // all-clear, which is bug 82171 arriving by a different route.
  //
  // Both existing zero-sink tests open from a clean set, so `announcedAlarm` is empty and the missing
  // conjunct cannot show. This one deliberately announces something first.
  it("a lost alarm stacked on a DELIVERED one must not swallow that one's all-clear", async () => {
    const dead: EscalationDeps = {
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
      fileDurableBead: async () => {
        throw new Error("bd unavailable");
      },
    };
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the warning IS delivered — the reader has heard it").toBe(1);

    // It worsens; the blocking confirms — but by now every channel refuses, so the blocking itself
    // reaches nobody. That must not retroactively silence the warning's all-clear.
    await escalatePipelineHealth(relSnap("warning"), relSnap("blocking"), dead);
    const lost = await escalatePipelineHealth(relSnap("blocking"), relSnap("blocking"), dead);
    expect(lost.undelivered, "the confirmed blocking reached nothing").toHaveLength(1);

    const r2 = recorder();
    const res = await escalatePipelineHealth(relSnap("blocking"), relSnap("healthy"), r2.deps);
    expect(res.delivered.map((e) => e.severity), "the announced alarm is owed its all-clear").toEqual(
      ["recovery"],
    );
    expect(r2.concierge.length).toBe(1);
  });

  // ── THE THIRD WRITER OF THE SAME FLAG NEEDS THE SAME CONJUNCT (roborev job 82212) ──────────────
  //
  // `unannouncedAlarm` has THREE writers, not two: the drop branch, the sink-result restore, and the
  // warning DEBOUNCE branch. The first two ask whether anything was announced underneath; the third
  // did not, and the argument applies to it verbatim — it suppresses, so it needs the conjunct.
  //
  // Reachable through the same `unknown` hop as job 82208, and `unknown` is where a component lands
  // when its probe times out. `unknown` ranks BELOW `warning`, so `unknown → warning` does emit a
  // warning edge; and the end-of-sweep reconciliation cannot retire the announced record on the way
  // through, because `unknown` is not a good state.
  it("a DEBOUNCED warning stacked on a delivered alarm must not swallow its all-clear", async () => {
    const r = recorder();
    await escalateWarning(relSnap("healthy"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the warning is delivered — the reader HAS been told").toBe(1);

    // The probe stops answering, then answers again still degraded. Neither crossing clears the
    // announced record: no event on the way in, and `unknown` is not good on the way out.
    await escalatePipelineHealth(relSnap("warning"), relSnap("unknown"), r.deps);
    r.now += 120_000; // well inside WARNING_DEBOUNCE_MS
    await escalateWarning(relSnap("unknown"), relSnap("warning"), r.deps);
    expect(r.concierge.length, "the re-raised warning is debounced, as intended").toBe(1);

    // It clears. The alarm the reader WAS told about is owed its all-clear.
    const res = await escalatePipelineHealth(relSnap("warning"), relSnap("healthy"), r.deps);
    expect(res.delivered.map((e) => e.severity)).toEqual(["recovery"]);
    expect(r.concierge.length, "the announced warning must still get its all-clear").toBe(2);
  });
});

// ── THE RELEASE RUNNER'S REMEDY SPLITS THE WAY ITS DETAIL DOES (bead sparkle-00dmmc) ─────────────
//
// The old single string told the reader to "wake the founder's Mac, and repair the runner with `sudo
// scripts/runner/setup-self-hosted-runner.sh` if it does not re-register" — two faults, opposite
// repairs, one instruction. A Mac asleep between jobs has an intact registration and re-running the
// setup script at it is a destructive answer to a non-problem; a runner absent from the fleet cannot
// be woken at all. This is the human-facing half of the classifier split: the detail is what the
// probe computes, this is what the person actually reads.
//
// EVERY ASSERTION HERE IS PAIRED. A bare "does not mention setup-self-hosted-runner" would match the
// asleep remedy's OWN REQUIRED DENIAL, and a negative alone is green over copy trimmed to silence —
// deleting a lie is not the same fact as stating the truth (AGENTS.md, copy ratchets).
describe("releaseRunnerRemediation", () => {
  const ASLEEP =
    "the macOS release runner (sparkle-release) is REGISTERED but not online — no notarized DMG can be built until it is back.";
  const GONE =
    "NO runner carrying the release label (sparkle-release) is registered at all — it is ABSENT from the fleet.";

  it("tells an ASLEEP runner to be woken, and explicitly warns OFF re-registering", () => {
    const r = releaseRunnerRemediation(ASLEEP);
    expect(r, "the positive: it must say what to do").toMatch(/wake the founder's Mac/i);
    expect(r, "the positive: it must warn the reader off, not merely omit the command").toContain(
      "Do NOT run",
    );
    expect(r, "the negative: keyed on the PRESCRIBING phrase, not the command name").not.toContain(
      "Re-register it with",
    );
  });

  it("tells a DEREGISTERED runner to be re-registered, and does not carry the asleep warning-off", () => {
    const r = releaseRunnerRemediation(GONE);
    expect(r).toContain("Re-register it with");
    expect(r, "waking is not the fix here and must not be the instruction").not.toContain(
      "Do NOT run",
    );
  });

  it("the two remedies are genuinely different text, not one string behind two branches", () => {
    expect(releaseRunnerRemediation(ASLEEP)).not.toBe(releaseRunnerRemediation(GONE));
  });

  it("an UNRECOGNISED detail keeps the old conflated wording — naming both beats naming the wrong one", () => {
    // Reached by an older build's string, or a shape added later. Confidently prescribing one repair
    // for a detail we cannot classify is the failure mode this fallback exists to avoid.
    const r = releaseRunnerRemediation("some future detail nobody has written yet");
    expect(r).toContain("wake the founder's Mac");
    expect(r).toContain("setup-self-hosted-runner.sh");
  });

  it("is what `remediationFor` returns for release_runner — the split is actually WIRED", () => {
    // Without this the whole split is dead code: `remediationFor` is the only caller the escalation
    // path uses, and it returned a fixed string for years.
    expect(remediationFor("release_runner", ASLEEP)).toBe(releaseRunnerRemediation(ASLEEP));
    expect(remediationFor("release_runner", GONE)).toBe(releaseRunnerRemediation(GONE));
    expect(remediationFor("release_runner", ASLEEP)).not.toBe(remediationFor("release_runner", GONE));
  });
});

// ── THE WARNING CONFIRMATION WINDOW (bead sparkle-00dmmc, second half) ───────────────────────────
//
// THE MEASURED INCIDENT, and it is unusually clean evidence. Across 2026-09-08/09 the roborev
// component alarmed FIVE times. All five self-recovered unattended within roughly one poll interval
// and nobody ran the remediation at any point: five alarms, ZERO true positives. Every one carried
// identical text inferring a WEDGE from ONE failed connection plus two circumstantial facts (process
// alive, store small) — neither of which establishes a wedge; they only rule out two alternatives.
//
// WHY THE BLOCKING WINDOW DID NOT COVER THEM. `BLOCKING_CONFIRMATIONS` gates the `blocking` severity
// only. These were WARNING, and warnings took a different path: a 30-minute per-component debounce
// measured from the last warning delivered. Roborev recurred roughly HOURLY, so every occurrence fell
// outside that window and every one was delivered. The debounce works as designed — it simply never
// asks whether the reading is CONFIRMED.
//
// The two compose and are not redundant: CONFIRMATION decides whether a reading is real, the DEBOUNCE
// decides how often a real one may repeat. N=3 matches the never-wired `ROBOREV_WEDGE_CONFIRMATIONS`
// prior art and would have suppressed all five with nothing to miss.
describe("warning confirmation window", () => {
  /** Drive a warning edge through its confirmation window; returns the sweep that ANNOUNCES it. */
  async function confirmWarning(from: PipelineHealth, to: PipelineHealth, deps: EscalationDeps) {
    await escalatePipelineHealth(from, to, deps); // the edge — streak 1
    for (let i = 2; i < WARNING_CONFIRMATIONS; i++) await escalatePipelineHealth(to, to, deps);
    return escalatePipelineHealth(to, to, deps); // the confirming reading
  }

  // THE NUMBER ITSELF, pinned with LITERAL polls rather than a loop over the constant.
  //
  // Every other case here drives `confirmWarning`, which reads `WARNING_CONFIRMATIONS` to decide how
  // many sweeps to run — so it ADAPTS to whatever the constant says and can never fail for a wrong
  // value. Measured: raising the constant to 5 left all of them green. A test whose setup is derived
  // from the thing under test is only pinned in one direction, and the narrowing direction is the one
  // that goes silently missing. These literal counts are what make the threshold falsifiable both
  // ways: at 1 the two-reading assertion reds, at anything above 3 the third-reading one does.
  it("announces on exactly the THIRD consecutive reading, and not before", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps); // reading 1 — the edge
    await escalatePipelineHealth(snap("warning"), snap("warning"), r.deps); // reading 2
    expect(r.concierge, "two readings are not enough to page").toEqual([]);

    const third = await escalatePipelineHealth(snap("warning"), snap("warning"), r.deps);
    expect(third.delivered.map((e) => e.severity), "the third confirms it").toEqual(["warning"]);
    expect(r.concierge.length).toBe(1);
  });

  it("HOLDS a first warning reading instead of announcing it", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);

    expect(res.delivered, "one reading must never be enough to page").toEqual([]);
    expect(r.concierge).toEqual([]);
    expect(r.woke).toEqual([]);
  });

  it("ANNOUNCES a warning still present on the confirming poll", async () => {
    const r = recorder();
    const res = await confirmWarning(snap("healthy"), snap("warning"), r.deps);

    expect(res.delivered.map((e) => e.severity)).toEqual(["warning"]);
    expect(r.concierge.length, "a confirmed degradation must still reach the reader").toBe(1);
  });

  it("announces NOTHING for a warning that clears before it is confirmed — the roborev shape", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    const res = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);

    expect(res.delivered, "the blip must not page").toEqual([]);
    expect(r.concierge, "and no all-clear for an alarm nobody heard").toEqual([]);
  });

  it("does not let a self-healing blip consume the confirmation streak of a later real one", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps); // blip opens
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps); // …and clears
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);

    expect(res.delivered, "the streak must restart, or two blips read as one degradation").toEqual(
      [],
    );
  });

  // ── sparkle-l4bxty: the debounce clock must start when the reader is TOLD, not at the gate ──────
  //
  // `passesGate` runs BEFORE routing, so stamping `lastWarningAt` there starts the 30-minute window
  // for a warning that then reached NO sink at all. The module's own comment says the timestamp is
  // "measured from the last warning actually DELIVERED"; it was not. Net effect: a lost warning
  // silences its component for half an hour having told nobody anything — which is plausibly why the
  // debounce has never behaved the way anyone expected.
  it("a warning that reached NO sink does not start the debounce window", async () => {
    const dead: EscalationDeps = {
      now: () => 1_000_000,
      notifyConcierge: () => false,
      wakeImprove: async () => false,
      fileDurableBead: async () => {
        throw new Error("bd unavailable");
      },
    };
    const lost = await confirmWarning(snap("healthy"), snap("warning"), dead);
    expect(lost.undelivered, "the warning was confirmed and then reached nothing").toHaveLength(1);
    expect(lost.delivered).toEqual([]);

    // It clears, then degrades again well INSIDE the debounce window, with working channels. Nobody
    // has been told anything yet, so this one must be delivered rather than debounced.
    const r = recorder();
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    const res = await confirmWarning(snap("healthy"), snap("warning"), r.deps);

    expect(res.delivered.map((e) => e.severity), "nothing was ever announced to debounce against")
      .toEqual(["warning"]);
    expect(r.concierge.length).toBe(1);
  });

  // ── roborev jobs 82754 + 82758: a PARTIAL THAW used to lose a real, lasting warning ──────────
  //
  // `detectEscalations` emits NO event for `blocking→warning` (its own doc comment says so), so the
  // drop branch's claim that a worsened streak "opens its own streak" holds in ONE direction only.
  // Going up, the worse edge really is emitted and really does re-open. Coming back DOWN there is no
  // edge at all — so deleting the streak left the component sitting in `warning` with nothing
  // tracking it and nothing ever announced, and the eventual recovery suppressed on top, because the
  // drop had flagged it unannounced.
  //
  // 82758 is the SECOND half, and it is why `alarmRun` exists rather than a reset to streak 1: a
  // streak counts readings of ONE state, so a component alternating warning/blocking on every poll
  // never accumulates three consecutive warnings NOR two consecutive blockings and is silenced just
  // as permanently. The run counts readings at least as severe, which is the evidence a thaw needs.
  it("delivers a warning that survives a transient blocking flicker inside its window", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps); // degraded reading 1
    await escalatePipelineHealth(snap("warning"), snap("blocking"), r.deps); // reading 2 — flicker
    const res = await escalatePipelineHealth(snap("blocking"), snap("warning"), r.deps); // reading 3

    expect(
      res.delivered.map((e) => e.severity),
      "three consecutive degraded readings confirm the warning — the blocking one counts too",
    ).toEqual(["warning"]);
    expect(r.concierge.length, "and it must reach the concierge, not just the partition").toBe(1);
  });

  // THE REPEATING flicker — the shape a per-state streak cannot see however many times it re-opens.
  // The first thaw here is NOT enough (two degraded readings), a worsening then sits in the middle,
  // and the second thaw confirms only because the run survived that worsening.
  it("delivers a warning that flickers to blocking REPEATEDLY, never holding either state", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps); // reading 1
    const firstThaw = await escalatePipelineHealth(snap("blocking"), snap("warning"), r.deps); // 2
    expect(
      firstThaw.delivered,
      "two degraded readings are not three — the first thaw must NOT confirm the warning",
    ).toEqual([]);

    await escalatePipelineHealth(snap("warning"), snap("blocking"), r.deps); // reading 3
    const res = await escalatePipelineHealth(snap("blocking"), snap("warning"), r.deps); // reading 4

    expect(
      res.delivered.map((e) => e.severity),
      "a component in alarm on every poll must be announced, whatever it alternates between",
    ).toEqual(["warning"]);
    expect(r.concierge.length).toBe(1);
  });

  // The OTHER direction of the same predicate — the one a fix for the above can silently widen.
  // Carrying the run forward must not turn an alarm nobody heard into an announced recovery.
  it("still announces NO all-clear when a thawed warning clears before it is confirmed", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps); // reading 1
    await escalatePipelineHealth(snap("blocking"), snap("warning"), r.deps); // reading 2 — thaw
    const res = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);

    expect(res.delivered, "two readings never confirmed, so there is no all-clear to give").toEqual(
      [],
    );
    expect(r.concierge, "an all-clear for an unheard alarm is the expensive shape").toEqual([]);
  });

  // And the WORSENING direction stays as it was: a warning on its way to blocking is never announced
  // as a warning on the strength of readings that were really about the blocking. A warning reading
  // is no evidence that a blocking is real, so the run is NOT carried this way.
  it("does not announce a warning as a warning once it has worsened to blocking", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps); // warning streak 1
    await escalatePipelineHealth(snap("warning"), snap("blocking"), r.deps); // worsens — blocking s1
    const res = await escalatePipelineHealth(snap("blocking"), snap("blocking"), r.deps);

    expect(
      res.delivered.map((e) => e.severity),
      "the blocking confirms on ITS threshold; no warning may ride along",
    ).toEqual(["blocking"]);
  });

  // A run broken by an UNREADABLE meter starts over — the module's standing fail-safe rule.
  it("does not carry the alarm run across an `unknown` reading", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps); // reading 1
    await escalatePipelineHealth(snap("blocking"), snap("unknown"), r.deps); // probe timed out
    const res = await escalatePipelineHealth(snap("unknown"), snap("warning"), r.deps);

    expect(res.delivered, "an unreadable meter is not evidence that anything is degraded").toEqual(
      [],
    );
  });
});
