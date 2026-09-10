import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeNarrateActivity, type NarrateActivityDeps } from "./activityNarrator";
import { NARRATION_MIN_INTERVAL_MS } from "../engine/activityNarrationPolicy";

const NOW = 5_000_000;
// Long enough to clear the policy's length floor, so each test varies exactly one thing.
const TURN =
  "I added the login form, wired it to the sessions endpoint, and covered it with three tests.";

type TestDeps = NarrateActivityDeps & { write: ReturnType<typeof vi.fn> };

// Replaced before each case; shared by every deps() built inside that case so two calls for the
// same agent throttle each other exactly as they would in the app.
let ledger = new Map<string, number>();

function deps(over: Partial<NarrateActivityDeps> = {}): TestDeps {
  return {
    agentKey: "agent-1",
    lastNarratedAt: undefined,
    // No deliberate self-report in the way, so each case varies only what it is about. The
    // self-report protection has its own block below.
    existingSource: "narrated" as const,
    now: () => NOW,
    enabled: () => true,
    narrate: async () => "Wiring the login screen",
    write: vi.fn(),
    attempts: ledger,
    ...over,
  } as TestDeps;
}

describe("maybeNarrateActivity", () => {
  // Each case gets its OWN attempt ledger, so module state cannot leak between them and a test that
  // expects to narrate is never throttled by an earlier one's attempt. Injected rather than reset
  // via an exported helper: a test-only export on the production surface is what
  // scripts/dormant-exports.mjs fails the build for, and rightly.
  beforeEach(() => {
    ledger = new Map<string, number>();
  });

  it("writes the narrated line, stamped with the time policy judged against", async () => {
    const d = deps();
    await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("narrated");
    // THE SIDE EFFECT, not the precondition: the line actually reached the store.
    expect(d.write).toHaveBeenCalledWith("Wiring the login screen", NOW);
  });

  it("stamps with the SAME now the policy used, not a second clock read", async () => {
    // If the stamp came from a fresh Date.now() after the await, a slow model call would push the
    // next eligible time out and the throttle would silently run longer than documented. Simulate
    // that by making the call take real time while the injected clock stays fixed.
    const d = deps({
      narrate: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "Wiring the login screen";
      },
    });
    await maybeNarrateActivity(TURN, d);
    expect(d.write).toHaveBeenCalledWith("Wiring the login screen", NOW);
  });

  it("spends nothing when the AI gate is off", async () => {
    const narrate = vi.fn(async () => "should never be called");
    const d = deps({ enabled: () => false, narrate });
    await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("disabled");
    // The MODEL CALL is what costs money — asserting only that nothing was written would pass even
    // if we had paid for a line and then dropped it.
    expect(narrate).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("spends nothing while throttled", async () => {
    const narrate = vi.fn(async () => "should never be called");
    const d = deps({ lastNarratedAt: NOW - 1_000, narrate });
    await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("throttled");
    expect(narrate).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("narrates again once the interval has elapsed", async () => {
    const d = deps({ lastNarratedAt: NOW - NARRATION_MIN_INTERVAL_MS });
    await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("narrated");
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous line when the model returns nothing", async () => {
    // A failed narration must NOT clear the line. A stale line that says how old it is still tells
    // you what the agent was last known to be doing; an empty one tells you nothing at all.
    // A DISTINCT agent per case: they would otherwise throttle each other, which is now correct
    // behaviour (roborev 82233) but is not what this test is about.
    for (const [i, bad] of [null, "", "   "].entries()) {
      const d = deps({ narrate: async () => bad, agentKey: `no-line-${i}` });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("no-line");
      expect(d.write).not.toHaveBeenCalled();
    }
  });

  it("does not spend a call on a turn too short to summarize", async () => {
    const narrate = vi.fn(async () => "nope");
    const d = deps({ narrate });
    await expect(maybeNarrateActivity("Done.", d)).resolves.toBe("turn-too-short");
    expect(narrate).not.toHaveBeenCalled();
  });

  it("passes the project label through to the model call", async () => {
    const narrate = vi.fn(async () => "Wiring the login screen");
    const d = deps({ narrate, project: "acme-web" });
    await maybeNarrateActivity(TURN, d);
    expect(narrate).toHaveBeenCalledWith(TURN, "acme-web");
  });

  describe("a FAILING narrator is throttled exactly like a succeeding one (roborev 82233)", () => {
    // THE BUG: the throttle used to key on a successful WRITE. Every failure arm — no CLI, signed
    // out, ai_busy, a 60s timeout, a parse failure, a whitespace-only reply — returns null and
    // writes nothing, so `lastNarratedAt` never moved and a wedged CLI was retried at FULL Stop
    // frequency, holding one of only 3 background permits for up to 60s each time.
    it("does not re-spend on the very next turn after a failed call", async () => {
      const narrate = vi.fn(async () => null);
      const d = deps({ narrate });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("no-line");
      expect(narrate).toHaveBeenCalledTimes(1);

      // Same agent, a moment later, still nothing written — the OLD code called again here.
      const d2 = deps({ narrate, now: () => NOW + 1_000 });
      await expect(maybeNarrateActivity(TURN, d2)).resolves.toBe("throttled");
      expect(narrate).toHaveBeenCalledTimes(1);
    });

    it("retries once the interval has elapsed, so a recovered CLI is picked up", async () => {
      // The throttle must not become a permanent lockout: a user who installs or signs into the CLI
      // has to get narration back without restarting the app.
      const narrate = vi.fn(async () => null);
      await maybeNarrateActivity(TURN, deps({ narrate }));
      const later = deps({ narrate, now: () => NOW + NARRATION_MIN_INTERVAL_MS });
      await maybeNarrateActivity(TURN, later);
      expect(narrate).toHaveBeenCalledTimes(2);
    });

    it("counts a whitespace-only reply as a spend — a child really ran", async () => {
      const narrate = vi.fn(async () => "   \n  ");
      await expect(maybeNarrateActivity(TURN, deps({ narrate }))).resolves.toBe("no-line");
      const d2 = deps({ narrate, now: () => NOW + 1_000 });
      await expect(maybeNarrateActivity(TURN, d2)).resolves.toBe("throttled");
      expect(narrate).toHaveBeenCalledTimes(1);
    });

    it("throttles per agent, so one wedged agent cannot mute the others", async () => {
      const narrate = vi.fn(async () => null);
      await maybeNarrateActivity(TURN, deps({ narrate, agentKey: "agent-1" }));
      // A DIFFERENT agent must still be eligible — a shared stamp would let one failing agent
      // suppress narration fleet-wide.
      await maybeNarrateActivity(TURN, deps({ narrate, agentKey: "agent-2" }));
      expect(narrate).toHaveBeenCalledTimes(2);
    });

    it("records the attempt BEFORE awaiting, so two concurrent Stops do not both spend", async () => {
      // A slow call with a second Stop arriving mid-flight. Stamping after the await would let both
      // pass the throttle and both bill.
      let release: (v: string | null) => void = () => {};
      const narrate = vi.fn(
        () => new Promise<string | null>((r) => { release = r; }),
      );
      const first = maybeNarrateActivity(TURN, deps({ narrate }));
      const second = await maybeNarrateActivity(TURN, deps({ narrate, now: () => NOW + 500 }));
      expect(second).toBe("throttled");
      expect(narrate).toHaveBeenCalledTimes(1);
      release("Wiring the login screen");
      await first;
    });
  });

  describe("a fresh deliberate self-report survives (roborev 82272)", () => {
    it("does not spend, and does not overwrite, while a self-report is fresh", async () => {
      // The founder-visible half: an agent that said "Blocked on the schema decision" must not have
      // that replaced by a recap of the turn that just ended. Asserting the MODEL CALL was skipped
      // as well as the write — asserting only the write would pass for code that paid and discarded.
      const narrate = vi.fn(async () => "Wiring the login screen");
      const d = deps({
        narrate,
        existingSource: "self",
        lastNarratedAt: NOW - 61_000,
      });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("self-report-fresh");
      expect(narrate).not.toHaveBeenCalled();
      expect(d.write).not.toHaveBeenCalled();
    });

    it("takes over once that self-report is stale — the abandoned line is the whole point", async () => {
      const d = deps({ existingSource: "self", lastNarratedAt: NOW - 10 * 60_000 });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("narrated");
      expect(d.write).toHaveBeenCalledWith("Wiring the login screen", NOW);
    });
  });

  describe("a self-report that lands DURING the model call also survives (roborev 82276)", () => {
    // THE BUG: the protection above was a check-then-act. It is read once, before a model call that
    // spends up to the backend's whole timeout, and the write then landed unconditionally. Every
    // test above holds its deps FIXED, so none of them can express a row that changes across the
    // await — which is exactly why the gap survived the fix that introduced the protection.

    /** A mutable row, and a `narrate` that flips it mid-flight — the shape no fixed-deps test has. */
    function racing(over: Partial<NarrateActivityDeps> = {}) {
      const row: { source: "self" | "narrated" | undefined; at: number | undefined } = {
        source: "narrated",
        at: NOW - 10 * 60_000,
      };
      const d = deps({
        lastNarratedAt: row.at,
        existingSource: row.source,
        currentLine: () => row,
        narrate: async () => {
          // The agent calls set_agent_activity while we are waiting on the model.
          row.source = "self";
          row.at = NOW + 3_000;
          return "Wiring the login screen";
        },
        ...over,
      });
      return { d, row };
    }

    it("abandons the line it already paid for rather than clobbering the self-report", async () => {
      const { d } = racing();
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("self-report-arrived");
      // THE SIDE EFFECT: nothing reached the store, so the agent's own words — and its `"self"`
      // provenance, which is what keeps the free notification body available — are still there.
      expect(d.write).not.toHaveBeenCalled();
    });

    it("still writes when nothing changed under it, so the feature is not merely disabled", async () => {
      // The paired positive. Without it, a re-check that bailed unconditionally would pass the test
      // above while narrating nothing, ever.
      const { d } = racing({
        narrate: async () => "Wiring the login screen",
      });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("narrated");
      expect(d.write).toHaveBeenCalledWith("Wiring the login screen", NOW);
    });

    it("still writes over a line that went STALE-self mid-flight", async () => {
      // Only a FRESH self-report is protected. A `"self"` line older than the protection window is
      // the abandoned-line case this whole feature exists to replace, whenever it is observed.
      const { d } = racing({
        narrate: async () => "Wiring the login screen",
        currentLine: () => ({ source: "self" as const, at: NOW - 10 * 60_000 }),
      });
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("narrated");
      expect(d.write).toHaveBeenCalledWith("Wiring the login screen", NOW);
    });

    it("counts the abandoned call as a spend — the model still ran", async () => {
      const { d } = racing();
      await expect(maybeNarrateActivity(TURN, d)).resolves.toBe("self-report-arrived");
      // Bailing must not reopen the retry hole roborev 82233 closed: the attempt was stamped before
      // the await, so the next Stop a second later is throttled rather than paying again.
      const again = deps({ now: () => NOW + 1_000 });
      await expect(maybeNarrateActivity(TURN, again)).resolves.toBe("throttled");
    });
  });
});
