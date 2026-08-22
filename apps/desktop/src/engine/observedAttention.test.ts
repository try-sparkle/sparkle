// The overlay's truth table, and the wire contract's TypeScript half.
//
// The fixture read here — `apps/desktop/shared/observed-attention.fixture.json` — is the SAME file
// `src-tauri/src/observed_attention.rs`'s tests parse. Rust asserts its serializer PRODUCES those
// bytes; this asserts the parser ACCEPTS them. A drift on either side reds BOTH suites, which is
// the whole reason the file exists: AGENTS.md records two halves of a Rust→TS payload built in
// parallel, both suites green, the merge clean, and the shipped feature never once running.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTabStatus } from "../types";
import { AGENT_STATUS } from "@sparkle/ui/tokens";
import { needsAttention } from "./attention";
import {
  applyVerdict,
  parseObservedReading,
  withObservedAttention,
  type ObservedReading,
} from "./observedAttention";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/observed-attention.fixture.json",
);

const reading = (
  verdict: ObservedReading["verdict"],
  alternate = false,
): ObservedReading => ({ verdict, alternate, atMs: 1_787_251_205_196 });

const NO_PANE = () => false;

/** The colour a row would paint for `status`, asserting the status is actually present first — a
 *  missing key must never be able to satisfy a colour comparison below. */
const colorOf = (status: AgentTabStatus | undefined): string => {
  expect(status, "expected a status, got none").toBeDefined();
  return AGENT_STATUS[status as AgentTabStatus].color;
};
const PANE_MOUNTED = () => true;

describe("the shared wire fixture", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    event: string;
    samples: Array<{ why: string; payload: unknown }>;
  };

  it("is not empty — otherwise every assertion below passes vacuously", () => {
    expect(fixture.samples.length).toBeGreaterThan(0);
  });

  it("names the event the Rust producer emits", () => {
    expect(fixture.event).toBe("attention://observed");
  });

  it("parses every sample the producer can emit", () => {
    for (const sample of fixture.samples) {
      const parsed = parseObservedReading(sample.payload);
      expect(parsed, `rejected a payload the producer emits: ${sample.why}`).not.toBeNull();
    }
  });

  it("covers every verdict, so the parse assertion above proves what it looks like", () => {
    const seen = new Set(
      fixture.samples.map((s) => parseObservedReading(s.payload)?.reading.verdict),
    );
    expect(seen).toEqual(new Set(["awaiting", "unreadable", "calm", "gone"]));
  });

  it("gives each sample a DIFFERENT atMs, so a consumer that ignores it is detectable", () => {
    // All five carried one identical value once, which made any freshness assertion vacuous.
    const stamps = fixture.samples.map((s) => parseObservedReading(s.payload)?.reading.atMs);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("carries `unreadable` in BOTH polarities of `alternate`", () => {
    // A parked reader is unreadable on the NORMAL buffer, so a consumer must not key its unreadable
    // handling on the alternate flag.
    const unreadable = fixture.samples
      .map((s) => parseObservedReading(s.payload)?.reading)
      .filter((r) => r?.verdict === "unreadable");
    expect(new Set(unreadable.map((r) => r?.alternate))).toEqual(new Set([true, false]));
  });

  it("carries the alternate-buffer case in BOTH polarities", () => {
    const flags = new Set(
      fixture.samples.map((s) => parseObservedReading(s.payload)?.reading.alternate),
    );
    expect(flags).toEqual(new Set([true, false]));
  });
});

describe("an unknown verdict never resolves to `calm`", () => {
  // The contract's rule, and the reason it matters: a newer producer can always emit a token an
  // older consumer does not know, and reading that as "fine" reproduces the founder's bug through
  // the parser instead of through the mount.
  it("drops the payload rather than inventing a reading", () => {
    expect(parseObservedReading({ agentId: "a1", verdict: "napping", alternate: false, atMs: 1 }))
      .toBeNull();
  });

  it("leaves the row exactly as it was — never lowered to a calm-looking status", () => {
    // Asserts the SIDE EFFECT on the status map, which is what "must not resolve to calm" actually
    // means for a user; a null return alone does not establish it.
    const out = withObservedAttention([{ id: "a1" }], { a1: "waiting" }, {}, NO_PANE);
    expect(out.a1).toBe("waiting");
  });
});

describe("parseObservedReading — a bad payload costs ONE agent, never the map", () => {
  const good = { agentId: "a1", verdict: "awaiting", alternate: false, atMs: 1 };

  it("accepts the canonical shape", () => {
    expect(parseObservedReading(good)).toEqual({
      agentId: "a1",
      reading: { verdict: "awaiting", alternate: false, atMs: 1 },
    });
  });

  it.each([
    ["a null payload", null],
    ["a non-object", "awaiting"],
    ["a missing agentId", { ...good, agentId: undefined }],
    ["an empty agentId", { ...good, agentId: "" }],
    ["a verdict this side does not know", { ...good, verdict: "probably-fine" }],
    // The trap AGENTS.md names: `alternate` is backed by a plain Rust `bool`, never an `Option`, so
    // `null` is a shape the producer cannot emit and must not be silently read as `false`.
    ["a null alternate", { ...good, alternate: null }],
    ["an absent alternate", { agentId: "a1", verdict: "awaiting", atMs: 1 }],
    ["a non-finite atMs", { ...good, atMs: Number.NaN }],
  ])("rejects %s", (_label, payload) => {
    expect(parseObservedReading(payload)).toBeNull();
  });
});

describe("withObservedAttention — `awaiting` raises a row NOBODY has opened", () => {
  const agents = [{ id: "a1" }];

  it("turns a latched green row RED, which is the founder's bug", () => {
    const base: Record<string, AgentTabStatus> = { a1: "working" };
    // Non-vacuity: the row is NOT red before the overlay runs. Without this the assertion below
    // would pass against a fixture that was already red.
    expect(colorOf(base.a1)).toBe(AGENT_STATUS.working.color);

    const out = withObservedAttention(agents, base, { a1: reading("awaiting") }, NO_PANE);

    expect(out.a1).toBe("waiting");
    // Assert the SIDE EFFECT that matters — the colour the row paints — not just the status token.
    expect(colorOf(out.a1)).toBe(AGENT_STATUS.waiting.color);
    expect(colorOf(out.a1)).not.toBe(AGENT_STATUS.working.color);
  });

  it("leaves the row alone when a pane IS mounted — that writer is live and richer", () => {
    const base: Record<string, AgentTabStatus> = { a1: "working" };
    const out = withObservedAttention(agents, base, { a1: reading("awaiting") }, PANE_MOUNTED);
    expect(out.a1).toBe("working");
  });

  it("does NOT repaint `questions` — blue is good news and must not wear the alarm colour", () => {
    const base: Record<string, AgentTabStatus> = { a1: "questions" };
    const out = withObservedAttention(agents, base, { a1: reading("awaiting") }, NO_PANE);
    expect(out.a1).toBe("questions");
    expect(colorOf(out.a1)).not.toBe(AGENT_STATUS.waiting.color);
  });

  it.each<AgentTabStatus>(["waiting", "approval", "errored"])(
    "does not overwrite the more specific status `%s`",
    (status) => {
      const out = withObservedAttention(agents, { a1: status }, { a1: reading("awaiting") }, NO_PANE);
      expect(out.a1).toBe(status);
    },
  );

  it("DOES promote `blocked` — a stall-timer inference loses to a reading of the grid", () => {
    const out = withObservedAttention(agents, { a1: "blocked" }, { a1: reading("awaiting") }, NO_PANE);
    expect(out.a1).toBe("waiting");
    // The colour is unchanged (both are red); the BAND is what moves. `blocked` sits outside
    // `needsAttention` on purpose, so this is what puts a positively-read prompt on the dock badge.
    expect(colorOf(out.a1)).toBe(colorOf("blocked"));
    expect(needsAttention(out.a1)).toBe(true);
    expect(needsAttention("blocked")).toBe(false);
  });

  it("DOES raise `lapsed` — a genuine red outranks amber, per tokens.ts", () => {
    const out = withObservedAttention(agents, { a1: "lapsed" }, { a1: reading("awaiting") }, NO_PANE);
    expect(out.a1).toBe("waiting");
  });

  it("raises an agent that has no status at all", () => {
    const out = withObservedAttention(agents, {}, { a1: reading("awaiting") }, NO_PANE);
    expect(out.a1).toBe("waiting");
  });

  it("raises through the alternate buffer when Claude Code owns it", () => {
    const out = withObservedAttention(
      agents,
      { a1: "working" },
      { a1: reading("awaiting", true) },
      NO_PANE,
    );
    expect(out.a1).toBe("waiting");
  });
});

describe("withObservedAttention — `unreadable` holds NO opinion", () => {
  const agents = [{ id: "a1" }];

  it("does NOT relabel a live agent's green as a finished session", () => {
    // It used to map `working` -> `stopped`. `stopped` is a LIFECYCLE claim, not a neutral gray:
    // `unmergedAttention.RESTING` reads it as "Needs merge", `stallEscalation.GRAY_STATUSES` repaints
    // it amber `lapsed`, and `retirementReadiness.UNREACHABLE_STATUSES` calls the agent unaskable.
    // `unreadable` fires for a LIVE agent every time flow control parks the reader or a full-screen
    // TUI holds the buffer, so that mapping relabelled working agents as dead ones (roborev 67199).
    const out = withObservedAttention(agents, { a1: "working" }, { a1: reading("unreadable") }, NO_PANE);
    expect(out.a1).toBe("working");
    expect(out.a1).not.toBe("stopped");
  });

  it.each<AgentTabStatus>(["waiting", "approval", "errored", "blocked"])(
    "never lowers the red row `%s` — an unread screen is not evidence the question was answered",
    (status) => {
      const out = withObservedAttention(agents, { a1: status }, { a1: reading("unreadable") }, NO_PANE);
      expect(out.a1).toBe(status);
    },
  );

  it.each<AgentTabStatus>(["idle", "new", "done", "stopped", "unmerged"])(
    "never raises the calm row `%s` — no new alarm",
    (status) => {
      const out = withObservedAttention(agents, { a1: status }, { a1: reading("unreadable") }, NO_PANE);
      expect(out.a1).toBe(status);
    },
  );
});

describe("withObservedAttention — a stale `gone` holds no opinion", () => {
  // The listener deletes the row rather than storing `gone`, so the overlay should never see one.
  // "Should never" is not a guarantee, and a retraction that accidentally READ as an alarm would be
  // the worst possible failure for the agent it describes: gone, and shouting.
  const agents = [{ id: "a1" }];
  it.each<AgentTabStatus>(["working", "waiting", "blocked", "idle"])(
    "leaves `%s` exactly as it was",
    (status) => {
      const out = withObservedAttention(agents, { a1: status }, { a1: reading("gone") }, NO_PANE);
      expect(out.a1).toBe(status);
    },
  );
});

describe("withObservedAttention — `calm` is inert", () => {
  const agents = [{ id: "a1" }];

  it.each<AgentTabStatus>(["working", "waiting", "blocked", "idle", "questions", "lapsed"])(
    "does not touch `%s` — retraction belongs to movementRetraction, not to a grid scrape",
    (status) => {
      const out = withObservedAttention(agents, { a1: status }, { a1: reading("calm") }, NO_PANE);
      expect(out.a1).toBe(status);
    },
  );
});

describe("withObservedAttention — housekeeping", () => {
  it("returns the SAME object when nothing changed, so a quiet fleet churns no render", () => {
    const base: Record<string, AgentTabStatus> = { a1: "idle" };
    const out = withObservedAttention([{ id: "a1" }], base, { a1: reading("calm") }, NO_PANE);
    expect(out).toBe(base);
  });

  it("ignores a reading for an agent that is not in this project", () => {
    const base: Record<string, AgentTabStatus> = { a1: "working" };
    const out = withObservedAttention([{ id: "a1" }], base, { other: reading("awaiting") }, NO_PANE);
    expect(out).toBe(base);
    expect(out.other).toBeUndefined();
  });

  it("does not mutate the map it was given", () => {
    const base: Record<string, AgentTabStatus> = { a1: "working" };
    withObservedAttention([{ id: "a1" }], base, { a1: reading("awaiting") }, NO_PANE);
    expect(base.a1).toBe("working");
  });

  it("applies each agent independently", () => {
    const out = withObservedAttention(
      [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
      { a1: "working", a2: "working", a3: "working" },
      { a1: reading("awaiting"), a2: reading("unreadable"), a3: reading("calm") },
      NO_PANE,
    );
    expect(out).toMatchObject({ a1: "waiting", a2: "working", a3: "working" });
  });
});

describe("applyVerdict — the decision, directly", () => {
  it("returns undefined (meaning 'no opinion') rather than echoing the input back", () => {
    // This distinction is what lets the overlay skip the copy entirely on a quiet fleet.
    expect(applyVerdict("idle", "calm")).toBeUndefined();
    expect(applyVerdict("waiting", "awaiting")).toBeUndefined();
    expect(applyVerdict("blocked", "awaiting")).toBe("waiting");
    expect(applyVerdict("idle", "unreadable")).toBeUndefined();
    expect(applyVerdict("working", "unreadable")).toBeUndefined();
  });
});

// ══ GUARD 2 — THE SELF ROW AND A BUILD ROW MUST DERIVE COLOUR IDENTICALLY ═══════════════════════
//
// The founder's HARD RULE (2026-08-22), verbatim: "I do want it to work exactly like the build
// agents, so that's the hard rule. The colors work the same between the two, and don't let any
// instruction ever override that."
//
// He asked for this guard BY NAME, because the divergence it catches had already shipped once and
// he expected it to regress again. It did ship: `withObservedAttention` iterated only the array it
// was handed, both call sites hand it `project.agents`, and `services/knownAgents.ts` keeps the
// app-owned Improve Sparkle row out of that array by design — so the whole overlay skipped it and
// the self row kept the green-while-blocked bug after build rows were fixed.
//
// ⚠️ THE EMPTY `agents` ARRAY IS THE POINT, not a shortcut. That is the REAL condition for the self
// row — it is genuinely never in the roster — so a version of this test that puts the sparkle id in
// `agents` would pass against the very bug it exists to catch.
describe("parityAcrossRowKinds — the founder's hard rule", () => {
  const VERDICTS = ["awaiting", "unreadable", "calm"] as const;
  // Both spellings resolve through `isSparkleAgentId`: the bare namespace and the per-window form.
  const SELF_IDS = ["__sparkle_self__", "__sparkle_self__-main"];

  it.each(VERDICTS)(
    "a build row and the self row reach the same STATUS for verdict `%s`",
    (verdict) => {
      for (const selfId of SELF_IDS) {
        const build = withObservedAttention(
          [{ id: "a1" }],
          { a1: "working" },
          { a1: reading(verdict) },
          NO_PANE,
        );
        // No roster entry — exactly how the self row actually arrives here.
        const self = withObservedAttention(
          [],
          { [selfId]: "working" },
          { [selfId]: reading(verdict) },
          NO_PANE,
        );
        expect(self[selfId], `self row diverged from a build row on \`${verdict}\``).toBe(
          build.a1,
        );
      }
    },
  );

  it.each(VERDICTS)(
    "…and the same COLOUR, which is what the founder actually sees, for verdict `%s`",
    (verdict) => {
      for (const selfId of SELF_IDS) {
        const build = withObservedAttention(
          [{ id: "a1" }],
          { a1: "working" },
          { a1: reading(verdict) },
          NO_PANE,
        );
        const self = withObservedAttention(
          [],
          { [selfId]: "working" },
          { [selfId]: reading(verdict) },
          NO_PANE,
        );
        expect(colorOf(self[selfId])).toBe(colorOf(build.a1));
      }
    },
  );

  // NON-VACUITY, asserted rather than assumed. If `awaiting` ever stops moving a green build row,
  // both assertions above collapse into "gray === gray" and would pass against a dead overlay.
  it("the `awaiting` case actually MOVES a build row, so the parity assertions mean something", () => {
    const build = withObservedAttention(
      [{ id: "a1" }],
      { a1: "working" },
      { a1: reading("awaiting") },
      NO_PANE,
    );
    expect(build.a1).toBe("waiting");
    expect(colorOf(build.a1)).not.toBe(AGENT_STATUS.working.color);
  });

  // A reading for an id that is neither in the roster nor the self row must still be ignored —
  // widening the overlay for Improve Sparkle must not have widened it for everything.
  it("still ignores a reading for a foreign agent that is in no roster", () => {
    const out = withObservedAttention([], { other: "working" }, { other: reading("awaiting") }, NO_PANE);
    expect(out.other).toBe("working");
  });
});
