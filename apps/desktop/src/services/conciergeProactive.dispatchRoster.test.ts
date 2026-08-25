// THE OPEN-DELEGATION ROSTER ON THE *PROACTIVE* SEAM.
//
// The user-turn fold-in is covered end to end in components/ConciergeHost.dispatchRoster.test.tsx.
// This file exists because a fold-in present on one seam and missing on the other is the kind of
// half-wiring that reads as done and is not — and an UNPROMPTED turn is exactly where re-grounding
// matters most, since there is no human message to re-supply the context.
//
// Every row asserts the SIDE EFFECT: the string handed to `startTurn` — the prompt the model
// actually reads — contains the delegation. Deleting the fold-in in `fire` turns them red.
import { describe, expect, it } from "vitest";
import {
  PROACTIVE_COALESCE_MS,
  createProactiveScheduler,
  type ProactiveDeps,
} from "./conciergeProactive";
import { buildDispatchPreamble, DISPATCH_PREAMBLE_HEADER } from "../stores/conciergeDispatchStore";
import type { RecalledDispatch } from "./dispatchRecall";
import type { ConciergeAgent, ConciergeFeed } from "./conciergeFeed";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const agent = (over: Partial<ConciergeAgent> & { id: string }): ConciergeAgent =>
  ({
    name: over.id,
    projectId: "p1",
    projectName: "sparkle-desktop",
    kind: "build",
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you",
    inScope: true,
    muted: false,
    topLevel: true,
    parentRowId: null,
    representedElsewhere: false,
    rolledUpGreen: false,
    ...over,
  }) as ConciergeAgent;

function feed(agents: ConciergeAgent[]): ConciergeFeed {
  const count = (band: string) => agents.filter((a) => a.band === band && a.inScope && !a.muted).length;
  const counts = {
    needs_you: count("needs_you"),
    questions: count("questions"),
    running: count("running"),
    done: count("done"),
  };
  return {
    projects: [{ id: "p1", name: "sparkle-desktop", inScope: true, counts, agents }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as ConciergeFeed;
}

function dispatch(over: Partial<RecalledDispatch> = {}): RecalledDispatch {
  const dispatchedAtMs = over.dispatchedAtMs ?? NOW - 8 * MIN;
  return {
    targetId: "8f590b78",
    channel: "build",
    name: "Sparkle Preview Card Inline",
    nameAtDispatch: "Sparkle Preview Card Inline",
    renamedSince: false,
    projectId: "p1",
    projectName: "sparkle",
    dispatchedAtMs,
    ageMs: NOW - dispatchedAtMs,
    ask: "make the preview cards inline in chat, one-third width",
    brief: "Investigate rendering preview cards inline at one-third width.",
    briefTruncated: false,
    beads: [],
    mode: "build",
    by: "concierge",
    status: "working",
    addressable: true,
    ...over,
  };
}

/** The same manual clock + timer queue the main proactive suite uses, with `fired` collected
 *  asynchronously because a scheduler carrying the roster settles on a microtask. */
function harness(over: Partial<ProactiveDeps> = {}) {
  let now = NOW;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fired: { prompt: string }[] = [];
  const deps: ProactiveDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++nextHandle;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    startTurn: (prompt) => {
      fired.push({ prompt });
      return true;
    },
    ...over,
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { deps, fired, advance };
}

/** Let the roster read — and therefore the deferred `startTurn` — settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Drive the scheduler to exactly one proactive turn. */
function nudge(s: ReturnType<typeof createProactiveScheduler>, h: ReturnType<typeof harness>) {
  s.observe(feed([agent({ id: "a", status: "working", band: "running", statusLabel: "Working" })]));
  s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
  h.advance(PROACTIVE_COALESCE_MS);
}

describe("an unprompted turn carries the open delegations too", () => {
  it("puts the delegation AHEAD of the roster line the push is actually about", async () => {
    const h = harness({
      readDispatchPreamble: async () => buildDispatchPreamble([dispatch()], NOW),
    });
    const s = createProactiveScheduler(h.deps);
    nudge(s, h);
    await flush();

    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    // THE SIDE EFFECT: the delegation's own subject and its handle are in the prompt the model reads.
    expect(prompt).toContain("make the preview cards inline in chat, one-third width");
    expect(prompt).toContain("8f590b78");
    expect(prompt).toContain(DISPATCH_PREAMBLE_HEADER);
    // "Approve?" is the roster line's status label — what the push is nominally about. The
    // delegations lead, because they are background the brain should already hold.
    expect(prompt).toContain("Approve?");
    expect(prompt.indexOf(DISPATCH_PREAMBLE_HEADER)).toBeLessThan(prompt.indexOf("Approve?"));
  });

  it("composes ALONGSIDE the memory section rather than displacing it", async () => {
    const h = harness({
      peekMemoryPreamble: () => "WHAT YOU'VE REMEMBERED — 1 fact(s):\n\n- founder-priority: wall-clock speed",
      readDispatchPreamble: async () => buildDispatchPreamble([dispatch()], NOW),
    });
    const s = createProactiveScheduler(h.deps);
    nudge(s, h);
    await flush();

    const prompt = h.fired[0]!.prompt;
    // Both sections survive — a sibling that swallowed the memory block would be a silent regression
    // of roborev 63933, which exists precisely because one seam carried a section and the other did not.
    expect(prompt).toContain("wall-clock speed");
    expect(prompt).toContain("make the preview cards inline in chat, one-third width");
    expect(prompt.indexOf(DISPATCH_PREAMBLE_HEADER)).toBeLessThan(prompt.indexOf("wall-clock speed"));
  });

  it("adds NOTHING when nothing is open — no standing empty section on every push", async () => {
    const h = harness({ readDispatchPreamble: async () => buildDispatchPreamble([], NOW) });
    const s = createProactiveScheduler(h.deps);
    nudge(s, h);
    await flush();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).not.toContain(DISPATCH_PREAMBLE_HEADER);
    expect(h.fired[0]!.prompt).toContain("Approve?");
  });

  it("still speaks when the ledger read fails — the roster may cost the section, never the turn", async () => {
    const h = harness({
      readDispatchPreamble: async () => {
        throw new Error("history.db is locked");
      },
    });
    const s = createProactiveScheduler(h.deps);
    nudge(s, h);
    await flush();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Approve?");
  });

  it("settles SYNCHRONOUSLY for a host that supplies no roster dep — the old path is untouched", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    nudge(s, h);
    // No await. The scheduler's determinism promise (`startTurn` returns `boolean | Promise<boolean>`
    // so a synchronous edge settles synchronously) must not be paid for by every existing caller.
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).not.toContain(DISPATCH_PREAMBLE_HEADER);
  });
});
