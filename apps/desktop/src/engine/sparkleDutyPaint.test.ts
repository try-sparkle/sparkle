// THE RULE, stated against a hand-built snapshot — no store, no clock, no Tauri.
//
// Every assertion here is on the OUTPUT of the overlay, never on its inputs: "the snapshot says
// pane-wedged" proves nothing, "the row comes back red `blocked` carrying the sentence that names
// the wedge" is the side effect. `AgentSidebar.sparkleDot.test.tsx` is the other half — that the
// rendered dot actually reads this.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { PASS_HOLD_TEXT } from "../services/pusherSnapshots";
import type { ImproveDutySnapshot } from "../services/improveDutySnapshot";
import type { AgentTabStatus } from "../types";
import { sparkleDutyPaint } from "./sparkleDutyPaint";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function snap(over: Partial<ImproveDutySnapshot> = {}): ImproveDutySnapshot {
  return { hold: null, holdText: null, nextPassAt: null, passElapsedMs: null, at: NOW, ...over };
}

/** A hold, spelled the way the writer spells it — the reason AND its canonical sentence together.
 *  Building the text by hand here would let the two drift and the test would still pass. */
function held(hold: NonNullable<ImproveDutySnapshot["hold"]>, over: Partial<ImproveDutySnapshot> = {}) {
  return snap({ hold, holdText: PASS_HOLD_TEXT[hold], ...over });
}

const GRAY = AGENT_STATUS.stopped.color;
const RED = AGENT_STATUS.blocked.color;

// ── 1. THE WEDGE IS RED ────────────────────────────────────────────────────────────────────────
describe("a wedged hourly pass", () => {
  it("raises the row to `blocked`, and that IS the shared table's red", () => {
    const out = sparkleDutyPaint("working", held("pane-wedged"));

    expect(out.status).toBe("blocked");
    // The hard rule, asserted as a COLOUR rather than as a name: this row reads the one shared
    // AGENT_STATUS table like every build row, so its red is byte-identical to a build row's red.
    expect(AGENT_STATUS[out.status].color).toBe(AGENT_STATUS.blocked.color);
    expect(AGENT_STATUS[out.status].color).not.toBe(GRAY);
  });

  it("hovers the sentence that says the human is the one who has to clear it", () => {
    const out = sparkleDutyPaint("working", held("pane-wedged"));

    expect(out.label).toBe(`Hourly pass held — ${PASS_HOLD_TEXT["pane-wedged"]}`);
    // The half of that sentence that makes red the right colour: nothing else will clear this.
    expect(out.label).toContain("interrupt or restart that pane");
  });

  it("raises a gray resting row too — a wedge is not less true when nothing is running", () => {
    expect(sparkleDutyPaint("stopped", held("pane-wedged")).status).toBe("blocked");
    expect(sparkleDutyPaint("idle", held("pane-wedged")).status).toBe("blocked");
  });

  it("raises the amber `lapsed` tier, which is calm rather than addressed to anyone", () => {
    expect(sparkleDutyPaint("lapsed", held("pane-wedged")).status).toBe("blocked");
  });

  it("does NOT restate itself over a tier that is addressed to the human", () => {
    // `errored` is in the notify set where `blocked` deliberately is not, and
    // waiting/approval/questions are counted by `engine/attention.needsAttention`. Writing
    // `blocked` over any of them would LOWER the row out of the attention set and silence a
    // notification — a fidelity change may never do that.
    for (const st of ["errored", "waiting", "approval", "questions"] as AgentTabStatus[]) {
      const out = sparkleDutyPaint(st, held("pane-wedged"));
      expect(out.status).toBe(st);
      expect(out.label).toBeUndefined();
    }
  });

  it("leaves an already-`blocked` row exactly as red, and only improves what it says", () => {
    const out = sparkleDutyPaint("blocked", held("pane-wedged"));
    expect(out.status).toBe("blocked");
    expect(out.label).toContain(PASS_HOLD_TEXT["pane-wedged"]);
  });
});

// ── 2. A LIVE PASS IS GREEN, AND SAYS HOW LONG IT HAS BEEN ONE ─────────────────────────────────
describe("a pass that is running", () => {
  it("keeps `working` and names the elapsed minutes", () => {
    const out = sparkleDutyPaint("working", snap({ passElapsedMs: 12 * MIN + 40_000 }));

    expect(out.status).toBe("working");
    expect(out.label).toBe("Working — 12m into this pass");
    expect(AGENT_STATUS[out.status].color).toBe(AGENT_STATUS.working.color);
  });

  it("says `just started` under the first minute rather than showing a zero", () => {
    expect(sparkleDutyPaint("working", snap({ passElapsedMs: 4_000 })).label).toBe(
      "Working — just started",
    );
    expect(sparkleDutyPaint("working", snap({ passElapsedMs: 59_999 })).label).toBe(
      "Working — just started",
    );
  });

  // ⚠️ REQUIRED GUARD — the founder's ruling: WAITING ON SUB-AGENTS IS HEALTHY WORK, NOT A STALL,
  // and the improvement pass does it constantly by design. A pass child that is `active` but quiet
  // is what the 10s process poll exists to see; the row stays GREEN and this rule LABELS it rather
  // than recolouring it.
  it("stays GREEN for a quiet pass that is only waiting on its sub-agents", () => {
    // 26 minutes in and silent — no output, no turn of its own, just children running.
    const out = sparkleDutyPaint("working", snap({ passElapsedMs: 26 * MIN }));

    expect(out.status).toBe("working");
    expect(AGENT_STATUS[out.status].color).toBe(AGENT_STATUS.working.color);
    expect(AGENT_STATUS[out.status].color).not.toBe(GRAY);
    expect(AGENT_STATUS[out.status].color).not.toBe(RED);
    // Labelled, not recoloured: the length is reported so a hung pass is legible, and it changes
    // nothing about the dot.
    expect(out.label).toBe("Working — 26m into this pass");
  });

  it("adds nothing when the row is working but no pass child was observed", () => {
    // An interactive pane session, not a pass. There is no elapsed clock to report and inventing
    // one would attribute the pane's work to the hourly duty.
    expect(sparkleDutyPaint("working", snap()).label).toBeUndefined();
  });

  it("outranks the countdown but NOT the wedge", () => {
    const both = held("pane-wedged", { passElapsedMs: 3 * MIN });
    expect(sparkleDutyPaint("working", both).status).toBe("blocked");
  });
});

// ── 3. EVERY OTHER HOLD, NAMED IN ITS OWN WORDS ────────────────────────────────────────────────
describe("a hold that is not a wedge", () => {
  // Keyed off PASS_HOLD_TEXT itself, so a new arm of `PassHoldReason` is covered the day it lands
  // rather than the day someone remembers this file.
  // `already-running` is excluded alongside `pane-wedged` and for the mirror-image reason (roborev
  // 67801): the wedge gets its OWN COLOUR, and this one gets its OWN SENTENCE. Routing it through
  // the HELD prefix produced "Hourly pass held — a pass is already in flight", which contradicts
  // itself — the duty is not held, the pass is running. Its dedicated assertions are at the bottom
  // of this file; a sweep that swallowed it would have kept pinning the self-contradiction.
  const others = (Object.keys(PASS_HOLD_TEXT) as Array<keyof typeof PASS_HOLD_TEXT>).filter(
    (k) => k !== "pane-wedged" && k !== "already-running",
  );

  it.each(others)("renders %s's own sentence on a resting row, without recolouring it", (hold) => {
    const out = sparkleDutyPaint("stopped", held(hold));

    expect(out.status).toBe("stopped");
    expect(out.label).toBe(`Hourly pass held — ${PASS_HOLD_TEXT[hold]}`);
  });

  it("names the hold in preference to the countdown — WHY beats WHEN", () => {
    const out = sparkleDutyPaint(
      "idle",
      held("offline", { nextPassAt: NOW + 20 * MIN }),
    );
    expect(out.label).toBe(`Hourly pass held — ${PASS_HOLD_TEXT.offline}`);
    expect(out.label).not.toContain("Resting");
  });

  it("does not put a schedule sentence on a row that is doing something", () => {
    // `working` is a live producer's word about this agent; only a wedge outranks it.
    expect(sparkleDutyPaint("working", held("consent-off")).label).toBeUndefined();
    expect(sparkleDutyPaint("errored", held("consent-off")).label).toBeUndefined();
  });
});

// ── 4. RESTING, WITH THE NEXT SLOT NAMED ───────────────────────────────────────────────────────
describe("a resting row between slots", () => {
  it("says how far off the next pass is, in RELATIVE time", () => {
    const out = sparkleDutyPaint("stopped", snap({ nextPassAt: NOW + 48 * MIN }));

    expect(out.status).toBe("stopped");
    expect(out.label).toBe("Resting — next pass in ~48m");
  });

  it("never says `Idle`, on any resting status", () => {
    // The founder's standing complaint: rows that read as nothing-happening when the work is fine.
    // `idle`'s taxonomy label is "Done — your turn", which claims something is owed when nothing is
    // and the next pass is up to an hour away.
    for (const st of ["stopped", "idle", "done", "new"] as AgentTabStatus[]) {
      const label = sparkleDutyPaint(st, snap({ nextPassAt: NOW + 5 * MIN })).label ?? "";
      expect(label).toContain("Resting");
      expect(label).not.toMatch(/idle/i);
      expect(label).not.toContain("your turn");
      expect(label).not.toBe("Stopped");
    }
  });

  it("renders NO absolute clock time — there is no configured timezone behind one", () => {
    const label = sparkleDutyPaint("stopped", snap({ nextPassAt: NOW + 48 * MIN })).label ?? "";
    // "4:15 PM", "16:15", "4 PM" — any of these would be a guess presented as a fact.
    expect(label).not.toMatch(/\d{1,2}:\d{2}/);
    expect(label).not.toMatch(/\b(am|pm)\b/i);
  });

  it("says `due now` rather than counting down past zero", () => {
    expect(sparkleDutyPaint("stopped", snap({ nextPassAt: NOW })).label).toBe(
      "Resting — next pass due now",
    );
    expect(sparkleDutyPaint("stopped", snap({ nextPassAt: NOW - 9 * MIN })).label).toBe(
      "Resting — next pass due now",
    );
  });

  it("floors at one minute instead of promising `~0m`", () => {
    expect(sparkleDutyPaint("stopped", snap({ nextPassAt: NOW + 20_000 })).label).toBe(
      "Resting — next pass in ~1m",
    );
  });

  it("reads in hours when a backwards clock puts the slot further out than an hour", () => {
    expect(sparkleDutyPaint("stopped", snap({ nextPassAt: NOW + 125 * MIN })).label).toBe(
      "Resting — next pass in ~2h 5m",
    );
    expect(sparkleDutyPaint("stopped", snap({ nextPassAt: NOW + 120 * MIN })).label).toBe(
      "Resting — next pass in ~2h",
    );
  });

  it("leaves the taxonomy label alone when nothing has been observed at all", () => {
    // A window that has never ticked. The overlay may only add fidelity it has actually seen.
    const out = sparkleDutyPaint("stopped", snap());
    expect(out).toEqual({ status: "stopped", label: undefined });
  });
});

// ── 5. THE HARD RULE, AND THE ONE THAT KEEPS RECURRING ─────────────────────────────────────────
describe("the invariants", () => {
  /** Every state × every plausible snapshot. Small enough to be exhaustive, which is the point. */
  const ALL = Object.keys(AGENT_STATUS) as AgentTabStatus[];
  const SNAPS: ImproveDutySnapshot[] = [
    snap(),
    snap({ nextPassAt: NOW + 30 * MIN }),
    snap({ nextPassAt: NOW - 30 * MIN }),
    snap({ passElapsedMs: 0 }),
    snap({ passElapsedMs: 19 * MIN }),
    ...(Object.keys(PASS_HOLD_TEXT) as Array<keyof typeof PASS_HOLD_TEXT>).map((h) => held(h)),
    held("pane-wedged", { passElapsedMs: 2 * MIN, nextPassAt: NOW + MIN }),
  ];

  it("only ever returns a status that is a key of the ONE shared table", () => {
    // The founder, non-overridable: "I do want it to work exactly like the build agents… The
    // colours work the same between the two, and don't let any instruction ever override that."
    for (const st of ALL) {
      for (const s of SNAPS) {
        const out = sparkleDutyPaint(st, s);
        expect(AGENT_STATUS).toHaveProperty(out.status);
        expect(AGENT_STATUS[out.status].color).toBeTypeOf("string");
      }
    }
  });

  it("supplies no colour of its own — the return shape has nowhere to put one", () => {
    // A new tier or a bespoke hue would have to arrive as a third key. Asserting the shape is what
    // makes that a test failure rather than a code review someone has to remember to do.
    const out = sparkleDutyPaint("working", held("pane-wedged"));
    expect(Object.keys(out).sort()).toEqual(["label", "status"]);
  });

  // ⚠️ REQUIRED GUARD, asked for by name. A quota-blocked / session-limited row must NEVER resolve
  // to a GRAY status. The pattern behind every recurrence of this bug is a status STAMPED ONCE and
  // then quietly re-derived into something calmer; this is the only thing that stops a fourth one.
  it("NEVER lowers a red row to gray, whatever the duty says", () => {
    for (const st of ["blocked", "errored"] as AgentTabStatus[]) {
      for (const s of SNAPS) {
        const out = sparkleDutyPaint(st, s);
        // The status itself is untouched…
        expect(out.status).toBe(st);
        // …and, said the way the founder sees it, the dot is not gray.
        expect(AGENT_STATUS[out.status].color).not.toBe(GRAY);
        expect(AGENT_STATUS[out.status].color).toBe(RED);
      }
    }
  });

  it("never lowers a red row that is ADDRESSED to the human out of the attention set", () => {
    for (const st of ["waiting", "approval", "questions"] as AgentTabStatus[]) {
      for (const s of SNAPS) {
        expect(sparkleDutyPaint(st, s).status).toBe(st);
      }
    }
  });

  it("never turns a green row gray", () => {
    for (const s of SNAPS) {
      const out = sparkleDutyPaint("working", s);
      expect(AGENT_STATUS[out.status].color).not.toBe(GRAY);
    }
  });
});

// ══ THE TRIAGE CASES (roborev 67801 / 67802) ════════════════════════════════════════════════════
describe("sparkleDutyPaint — already-running is not a hold", () => {
  it("says the pass is STARTING, not that the duty is held", () => {
    const out = sparkleDutyPaint("stopped", {
      hold: "already-running",
      holdText: "a pass is already in flight",
      nextPassAt: null,
      passElapsedMs: null,
      at: 0,
    });
    // The old label read "Hourly pass held — a pass is already in flight", which contradicts itself.
    expect(out.label).toBe("Working — pass starting");
    expect(out.label).not.toContain("held");
    // ⚠️ AND THE DISC MOVES WITH IT (roborev 67831). Keeping the resting status here left a GRAY dot
    // whose own hover text said the pass was working — the disc and its label describing different
    // situations. The latch is claimed, so a pass genuinely is in flight; green is the honest disc.
    expect(out.status).toBe("working");
  });

  it("prefers the elapsed time once the child is reporting one", () => {
    const out = sparkleDutyPaint("stopped", {
      hold: "already-running",
      holdText: "a pass is already in flight",
      nextPassAt: null,
      passElapsedMs: 12 * 60_000,
      at: 0,
    });
    expect(out.label).toContain("12m");
    expect(out.label).not.toContain("held");
    expect(out.status).toBe("working");
  });
});
