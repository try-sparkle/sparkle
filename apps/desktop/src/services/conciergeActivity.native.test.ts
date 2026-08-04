// @vitest-environment jsdom
//
// THE HALF OF A TURN THAT USED TO BE INVISIBLE.
//
// The recorder's original scope was `concierge_tool` control calls, which are a minority of what a
// turn does. Everything else — `Bash` shelling out to git/gh/bd, `Read`, `Grep`, `Task` — went
// unrecorded, so the column had nothing to say for most of a turn's elapsed time and fell back to
// three animated dots. That fallback is what the founder was looking at when he said *"I'm
// wondering what more context you can give me about what you're actually doing"*.
//
// These cases pin the two additions that close it, and they are written to fail against the code as
// it was: every assertion is about the RECORD that gets produced or the LINE that gets rendered,
// never about the call having been made. The recorded-vs-rendered split matters — a record nothing
// can phrase is as useless as no record — so most cases assert through `conciergeActivityLine`.
import { beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "../stores/projectStore";
import { conciergeActivityLine, NATIVE_DOMAIN, PHASE_DOMAIN } from "../engine/conciergeActivityLine";
import {
  clearConciergeLiveness,
  noteConciergeSent,
  useConciergeLivenessStore,
} from "./conciergeLiveness";
import {
  _resetConciergeActivityForTests,
  noteConciergeNativeToolCall,
  noteConciergePhase,
  noteConciergeToolCall,
  useConciergeActivityStore,
} from "./conciergeActivity";

function latest() {
  return useConciergeActivityStore.getState().latest;
}

/** The rendered sentence for whatever is currently recorded — what the human would actually read. */
function line() {
  const l = latest();
  return l ? conciergeActivityLine(l) : null;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  clearConciergeLiveness();
});

describe("noteConciergePhase — the two gaps in every turn", () => {
  // THE FIRST DEAD ZONE: between the send and the first tool call. Before this, the column showed
  // the bare pulse for the whole of it.
  it("says 'Reading your message' for a turn that has only just started", () => {
    noteConciergePhase("reading_message");
    expect(line()?.text).toBe("Reading your message");
  });

  // THE SECOND DEAD ZONE: after the last tool, while the reply streams. The most recent tool line is
  // stale from the moment text starts flowing, and a stale line rendered as live is the exact class
  // of lie this feature exists to remove.
  it("says 'Composing' once the reply is streaming", () => {
    noteConciergePhase("composing");
    expect(line()?.text).toBe("Composing");
  });

  it("records the phase under the reserved phase domain, not as a tool", () => {
    noteConciergePhase("composing");
    expect(latest()).toMatchObject({ domain: PHASE_DOMAIN, op: "composing" });
  });

  // A phase is superseded, never finished — there is no moment at which "Composed" is the true thing
  // to say. Asserting the LINE is unchanged by the outcome field is what pins that.
  it("never renders a past tense, whatever the recorded outcome", () => {
    noteConciergePhase("composing");
    const l = latest()!;
    expect(conciergeActivityLine({ ...l, outcome: "done" })?.text).toBe("Composing");
    expect(conciergeActivityLine({ ...l, outcome: "refused" })?.text).toBe("Composing");
  });

  /**
   * IDEMPOTENT (roborev 57845, Medium). `composing` is written from the delta handler, and deltas
   * arrive roughly per token chunk — hundreds a turn. Each write is a fresh object literal and the
   * indicator selects `latest` under `Object.is`, so an unguarded repeat re-renders the column on
   * every chunk.
   *
   * Asserted on OBJECT IDENTITY, which is the property the re-render actually turns on. A test
   * comparing the rendered text would pass against the broken version, since the text was always
   * identical — that sameness was the (false) argument for not guarding it in the first place.
   */
  it("drops a repeat of the phase already recorded, rather than re-writing the slot", () => {
    noteConciergePhase("composing");
    const first = latest()!;
    noteConciergePhase("composing");
    expect(latest()).toBe(first);
    expect(latest()!.seq).toBe(first.seq);
  });

  /**
   * THE TURN BOUNDARY IS EXEMPT (roborev 57870, Medium), and this is the founder's own habit
   * rather than a corner case.
   *
   * A send SUPERSEDES the turn in flight rather than queueing behind it, so rapid re-sending
   * routinely produces consecutive turns that reach no tool and no text. `reading_message` is then
   * still `latest` when the next turn starts — and an unconditional idempotence guard would drop
   * the new turn's boundary entry, leaving nothing above `ThinkingIndicator`'s floor and the bare
   * pulse on screen for the whole gap.
   *
   * Asserted on the SEQ ADVANCING, because that is the property the floor comparison turns on; the
   * text is identical either way, so a text assertion would pass against the bug.
   */
  it("always records a new turn's boundary, even back-to-back on a rapid re-send", () => {
    noteConciergePhase("reading_message");
    const firstTurn = latest()!.seq;
    // The user sends again before anything ran. The next turn's floor is `firstTurn`.
    noteConciergePhase("reading_message");
    expect(latest()!.seq).toBeGreaterThan(firstTurn);
    expect(line()?.text).toBe("Reading your message");
  });

  // ...but a DIFFERENT phase still lands. The guard must not wedge the slot.
  it("still records a change of phase", () => {
    noteConciergePhase("composing");
    const first = latest()!;
    noteConciergePhase("reading_message");
    expect(latest()).not.toBe(first);
    expect(line()?.text).toBe("Reading your message");
  });

  // Falls back to the pulse rather than inventing a sentence for a phase nobody wrote a phrase for.
  it("renders nothing for an unknown phase", () => {
    noteConciergePhase("reading_message");
    expect(conciergeActivityLine({ ...latest()!, op: "daydreaming" })).toBeNull();
  });

  /**
   * THE ASYMMETRY, and it is load-bearing rather than tidy.
   *
   * `reading_message` is recorded BY the send. If it counted as a sign of life, every send would
   * instantly clear the silence it had just started, the liveness clock could never run, and a turn
   * that died on arrival would be indistinguishable from one being answered — which is the precise
   * failure (149 of 378 turns killed and silent in one day) the liveness ladder was built for.
   *
   * Asserted through `silentSince` MOVING or not, which is the actual mechanism, rather than through
   * a spy on the notifier — a spy would pass even if the reducer ignored the call.
   */
  it("does NOT reset the silence clock — a send must not clear the silence it just started", () => {
    // A send 45s ago: silent long enough that any reset would be unmistakable.
    const sentAt = Date.now() - 45_000;
    noteConciergeSent(sentAt);
    expect(useConciergeLivenessStore.getState().silentSince).toBe(sentAt);
    noteConciergePhase("reading_message");
    expect(useConciergeLivenessStore.getState().silentSince).toBe(sentAt);
    expect(useConciergeLivenessStore.getState().sawOutput).toBe(false);
  });
});

describe("noteConciergeNativeToolCall — Bash, Read, Grep, Task", () => {
  it("records the tool name and its arguments under the reserved native domain", () => {
    noteConciergeNativeToolCall("Bash", '{"command":"git status"}');
    expect(latest()).toMatchObject({
      domain: NATIVE_DOMAIN,
      op: "Bash",
      nativeInput: '{"command":"git status"}',
    });
  });

  /**
   * NO OUTCOME, EVER — and this is a claim about what the app is entitled to say, not an oversight.
   *
   * A native call's result comes back as a `tool_result` block on a *user* record, and Rust's
   * capture reads only `assistant` records. The app therefore never observes the call finishing, so
   * it must not claim it did. These entries stay `running` and are superseded rather than settled;
   * the age ladder's colour is what tells the reader a line has gone stale.
   */
  it("stays in flight — the app never observes a native call finishing, so it cannot say it did", () => {
    noteConciergeNativeToolCall("Bash", "{}");
    expect(latest()?.outcome).toBe("running");
  });

  /**
   * THE TURN FLOOR DEPENDS ON THIS. `ThinkingIndicator` tells this turn's activity from the previous
   * turn's leftovers by snapshotting the counter and showing only entries above it. A native call
   * that did not advance the SAME counter would either be filtered out of its own turn or leak into
   * the next one — so sharing the counter with control calls is the mechanism, not a detail.
   */
  it("advances the same monotonic counter control calls use", () => {
    noteConciergeToolCall("terminal", "read_agent_terminal", {});
    const afterControl = latest()!.seq;
    noteConciergeNativeToolCall("Bash", "{}");
    expect(latest()!.seq).toBe(afterControl + 1);
    noteConciergePhase("composing");
    expect(latest()!.seq).toBe(afterControl + 2);
  });

  /**
   * A turn that spends a minute shelling out to `git` and `gh` emits no control calls and no text.
   * Fed on deltas and control calls alone, the liveness detector would paint a visibly working
   * concierge red — the one false claim it must not make.
   *
   * Asserted by driving the store to a real silence and checking the clock MOVES, which is the
   * mechanism; a spy on the notifier would stay green even if the reducer dropped the call.
   */
  it("resets the silence clock — a shelling-out turn is a working turn, not a stalled one", () => {
    // A send 45s ago. Left alone this is already past SLOW_AFTER_MS, i.e. the column has gone
    // amber on a turn that is in fact busy running `git` — the exact misreport this closes.
    const sentAt = Date.now() - 45_000;
    noteConciergeSent(sentAt);
    expect(useConciergeLivenessStore.getState().silentSince).toBe(sentAt);
    noteConciergeNativeToolCall("Bash", '{"command":"git status"}');
    const after = useConciergeLivenessStore.getState();
    expect(after.silentSince).toBeGreaterThan(sentAt);
    expect(after.sawOutput).toBe(true);
    // A tool call is a sign of LIFE, not an ANSWER — the unanswered-message receipt turns on
    // exactly this difference, so a native call must not set it either.
    expect(after.sawText).toBe(false);
  });

  // The arguments are raw material for a heuristic, never words. Keeping them off `subject` is what
  // makes it structurally impossible for a shell command or a path to reach the screen through the
  // control path's renderer.
  it("never puts the raw arguments where a subject would be rendered", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/Users/someone/secret.txt"}');
    expect(latest()?.subject).toBeNull();
    expect(latest()?.agentId).toBeNull();
  });

  /**
   * THE ASSERTION THAT WAS MISSING, and its absence is exactly why a High-severity defect shipped
   * (roborev 57845). Every phase case here went through the RENDERED sentence; not one native case
   * did — they all stopped at the recorded fields. So a native entry that recorded perfectly and
   * rendered `null` looked green. Asserting the record is asserting an intermediate; the line is
   * the thing the human reads, and it is the only assertion that can catch a missing phrase table.
   */
  it("produces a RENDERED line, not merely a record", () => {
    noteConciergeNativeToolCall("Grep", '{"pattern":"conciergeActivity"}');
    const rendered = line();
    expect(rendered).not.toBeNull();
    expect(rendered!.text.length).toBeGreaterThan(0);
  });

  /**
   * ══ THE REGRESSION THIS FEATURE COULD HAVE CAUSED ═════════════════════════════════════════════
   *
   * `mcp__sparkle-control__*` calls arrive on the SAME live channel as the native ones. The store
   * is a single slot, so recording one would destroy whatever line was there — and the phrasing
   * module returns null for them by design, so what replaced the good line would render as nothing
   * and drop the column back to the bare pulse.
   *
   * The victim is not some unrelated line either: it is the RICH line `controlListener` produced
   * for THE SAME CALL, with a resolved agent name and a clickable pill. Untreated, the feature
   * would have made the column strictly worse than before it existed.
   *
   * Asserted on the surviving line rather than on a "was it recorded" flag, because surviving is
   * the property that matters.
   */
  it("does not let a control call arriving on the live channel clobber its own richer line", () => {
    const projectId = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    const name = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!.name;
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId });
    expect(line()?.text).toBe(`Reading ${name}'s terminal`);
    // The very same call, seen again on the live tool channel.
    noteConciergeNativeToolCall("mcp__sparkle-control__sparkle_terminal", '{"action":"read"}');
    expect(line()?.text).toBe(`Reading ${name}'s terminal`);
    expect(line()?.agentRef?.agentId).toBe(agentId);
  });

  // The counter must not advance for a call that was refused a slot either — a phantom bump would
  // push the turn floor past entries that never got to exist.
  it("leaves the counter untouched when it declines to record", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/x"}');
    const before = latest()!.seq;
    noteConciergeNativeToolCall("mcp__sparkle-control__sparkle_fleet", "{}");
    expect(latest()!.seq).toBe(before);
  });

  // REGRESSION: the control path is untouched by any of this. Its richer line — resolved name, and
  // the pill data behind it — is the thing a generic native line must never replace.
  it("leaves control calls phrasing exactly as they did", () => {
    const projectId = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    const name = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!.name;
    const settle = noteConciergeToolCall("terminal", "read_agent_terminal", { agentId });
    expect(line()?.text).toBe(`Reading ${name}'s terminal`);
    settle(true);
    expect(line()?.text).toBe(`Read ${name}'s terminal`);
    expect(line()?.agentRef?.agentId).toBe(agentId);
  });
});
