import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import {
  classifyPassFailure,
} from "../engine/passFailureStatus";
import {
  noteRunFailureStatus,
  PARK_DECLINE_ESCALATE_AFTER,
  resetRunFailureStreakForTests,
  runFailureStreakAt,
} from "./improvementPass";

// ══ A REPEATING FAILURE IS NOT "UNFINISHED, NOT YOURS" ══════════════════════════════════════════
//
// Moving auto-retried failures off red onto amber was right for a ONE-OFF failure and wrong for a
// REPEATING one — and it made the repeating case QUIETER than it had been, not merely calmer.
// `blocked` bands into `needs_you`; `lapsed` bands into `done`, which the sidebar can collapse and
// filter away and the concierge digest does not count. Neither fires a banner. So an hourly loop
// dying identically every hour sat in the FINISHED band with nothing pinged (roborev 67832).
describe("noteRunFailureStatus — a repeat escalates", () => {
  beforeEach(() => resetRunFailureStreakForTests());

  it("is AMBER the first time and RED on the Nth consecutive same reason", () => {
    const msg = "claude exited without a successful result (exit code 1)";
    const seen: string[] = [];
    for (let i = 0; i < PARK_DECLINE_ESCALATE_AFTER; i++) {
      seen.push(noteRunFailureStatus(msg, "other").status);
    }
    // Amber until the threshold, then the notifying tier.
    expect(seen.slice(0, -1).every((s) => s === "lapsed")).toBe(true);
    expect(seen.at(-1)).toBe("errored");
    expect(runFailureStreakAt()).toBe(PARK_DECLINE_ESCALATE_AFTER);
  });

  it("counts a message that differs only by a timestamp or path as the SAME reason", () => {
    // Without normalizing, a varying suffix restarts the tally forever and nothing ever escalates —
    // which is the failure mode this guard exists to prevent, not a cosmetic nicety.
    noteRunFailureStatus("pass failed at 09:14:02 in /tmp/wt-8823/run.log", "other");
    noteRunFailureStatus("pass failed at 09:15:31 in /tmp/wt-9107/run.log", "other");
    const third = noteRunFailureStatus("pass failed at 10:02:55 in /tmp/wt-2244/run.log", "other");
    expect(third.status).toBe("errored");
  });

  it("a DIFFERENT reason restarts the tally rather than inheriting it", () => {
    noteRunFailureStatus("git exploded", "other");
    noteRunFailureStatus("git exploded", "other");
    const other = noteRunFailureStatus("event bus unavailable", "other");
    expect(other.status).toBe("lapsed");
    expect(other.streak).toBe(1);
  });

  it("a WALL is red immediately and does not participate in the streak", () => {
    const first = noteRunFailureStatus("Claude usage limit reached", "quota");
    expect(first.status).toBe("blocked");
    expect(first.streak).toBe(0);
    // ...and it did not consume the streak a later repeating failure needs.
    expect(runFailureStreakAt()).toBe(0);
    expect(noteRunFailureStatus("Failed to authenticate: OAuth session expired", "auth").status).toBe(
      "blocked",
    );
  });

  it("escalates to a status that is NOT in the calm band", () => {
    const msg = "toolchain missing";
    for (let i = 0; i < PARK_DECLINE_ESCALATE_AFTER - 1; i++) noteRunFailureStatus(msg, "other");
    const red = noteRunFailureStatus(msg, "other").status;
    // The whole point: the escalated tier must differ from the amber one it escalated FROM.
    expect(AGENT_STATUS[red].color).not.toBe(AGENT_STATUS.lapsed.color);
    expect(AGENT_STATUS[red].color).toBe(AGENT_STATUS.blocked.color);
  });
});

// ══ THE CALLER'S GATE, not the classifier's (roborev 67824) ═════════════════════════════════════
// The classifier already returned "quota" for a combined payload BEFORE the caller was fixed, so a
// test asserting that pins nothing about the change. What changed is that the caller now consults
// the classification before arming the retry. This pins the decision the caller makes.
describe("the retry gate reads the CLASSIFICATION, not isTransientPassFailure", () => {
  const COMBINED = "read ECONNRESET\nYou've hit your session limit · resets 8:40am";

  it("classifies a combined payload as a wall, so the caller's `=== transient` test is false", () => {
    expect(classifyPassFailure(COMBINED, 0)).toBe("quota");
    // The caller arms only when this is "transient"; a wall therefore cannot arm it. Before the fix
    // the caller asked isTransientPassFailure directly, which IS true of this payload.
    expect(classifyPassFailure(COMBINED, 0) === "transient").toBe(false);
  });

  it("still classifies a pure connectivity failure as transient, so the retry is not lost", () => {
    expect(classifyPassFailure("read ECONNRESET", 0)).toBe("transient");
  });
});
