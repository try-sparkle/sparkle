// @vitest-environment jsdom
//
// The peer row — what the founder actually sees of one agent talking to another.
//
// THE ROW MOUNTS THROUGH `ConciergeMessageRow`, not directly, in the integration describe at the
// bottom. A test that only ever mounted `PeerMessageRow` would keep passing if the `kind === "peer"`
// branch were removed from the row dispatch, which is the wiring that makes any of this visible.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import {
  PeerMessageRow,
  PEER_ROW_TESTID,
  PEER_EXPAND_TESTID,
  PEER_BODY_TESTID,
  PEER_APP_PARTY_TESTID,
} from "./PeerMessageRow";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import { peerMessageEntry } from "../../services/peerMessageLog";
import type { MentionAgent } from "./mentions";
import type { RevealOutcome } from "../../services/agentReveal";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

/**
 * Stand in for a layout engine. jsdom performs no layout and reports 0 for both heights, which the
 * row reads as NOT MEASURED — so these are what let the measurement path be driven at all, in both
 * directions. Without them only the fail-safe branch would ever be exercised, and "it fits, so no
 * control" would be covered by nothing.
 */
function stubLayout(scrollHeight: number, clientHeight: number): void {
  for (const [prop, value] of [
    ["scrollHeight", scrollHeight],
    ["clientHeight", clientHeight],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => value,
    });
  }
}

function clearLayoutStub(): void {
  for (const prop of ["scrollHeight", "clientHeight"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 0 });
  }
}

/**
 * A fake `ResizeObserver` that hands the callback back, so the RE-MEASURE path can be driven.
 *
 * jsdom never lays out and therefore never fires a real one (docs/jsdom-test-caveats.md), so without
 * this the resize branch would be covered by nothing — and "the observer exists" is not the claim
 * that matters. What matters is that firing it re-reads the heights and brings the control back.
 */
let resizeCallbacks: Array<() => void> = [];

function stubResizeObserver(): void {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  };
}

/** Narrow the column: change what the element measures, then fire the observer. */
function resizeTo(scrollHeight: number, clientHeight: number): void {
  stubLayout(scrollHeight, clientHeight);
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });
}

afterEach(() => {
  cleanup();
  clearLayoutStub();
  resizeCallbacks = [];
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

const ORCH = agent({ id: "a1", name: "Orchestrator" });
const RUST = agent({ id: "a2", name: "Rust Half", band: "needs_you" });

function ctx(over: Partial<AgentPillContextValue> = {}): AgentPillContextValue {
  return { agents: [ORCH, RUST], onOpenAgent: vi.fn((): RevealOutcome => "revealed"), ...over };
}

const LONG = "I am claiming src/parser.rs and its test.\nDo not edit it.\nThe codegen half is yours.";

function entry(over: { gist?: string; message?: string } = {}) {
  return peerMessageEntry({
    id: "peer-1",
    from: { id: "a1", name: "Orchestrator" },
    to: { id: "a2", name: "Rust Half" },
    message: over.message ?? LONG,
    gist: over.gist ?? "taking the parser; you own the codegen",
  });
}

function mount(m = entry(), value = ctx()) {
  return render(
    <AgentPillProvider value={value}>
      <PeerMessageRow message={m} />
    </AgentPillProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PeerMessageRow — the two-line clamp", () => {
  it("shows the sender's gist and NOT the message it stands for", () => {
    mount();
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
    // The whole point of a clamp: the full text is not in the document at all until asked for, so a
    // long message cannot push the rest of the conversation off the screen.
    expect(screen.queryByText(/The codegen half is yours/)).toBeNull();
  });

  it("clamps to two lines rather than relying on the message being short", () => {
    mount();
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
  });
});

describe("PeerMessageRow — expanding in place", () => {
  it("reveals the full message verbatim, in the same row", () => {
    mount();
    const row = screen.getByTestId(PEER_ROW_TESTID);
    expect(row.getAttribute("data-expanded")).toBe("false");

    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));

    // IN PLACE: the same row element, still mounted, now carrying the full text. Asserting the row
    // survived is what separates "expanded" from "navigated somewhere that also shows the text".
    expect(screen.getByTestId(PEER_ROW_TESTID)).toBe(row);
    expect(row.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(LONG);
  });

  it("collapses again, so an opened row is not a one-way door", () => {
    mount();
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    expect(screen.getByTestId(PEER_ROW_TESTID).getAttribute("data-expanded")).toBe("false");
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
  });

  it("renders no expand control when the gist IS the whole message AND it measurably fits", () => {
    // Nothing to reveal. A control that opens a row onto the text already on screen is a promise
    // the row cannot keep, and the reader learns to stop trusting the affordance.
    //
    // THE MEASUREMENT IS NOW PART OF THE CLAIM, and that is the correction roborev 68701 forced.
    // This case used to assert the same absence with no layout at all, which quietly encoded "if the
    // strings match, nothing is hidden" — the assumption that shipped unreachable text three times.
    // Identical strings are necessary but NOT sufficient; the clamp must also be measured to fit.
    stubLayout(36, 36);
    mount(entry({ gist: "", message: "one short line" }));
    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();
  });

  it("renders the message as plain text, never as markdown", () => {
    // A peer message is a machine string written for another machine: `_` and `*` are characters.
    mount(entry({ message: "use `_foo_` and *not* **bar**", gist: "styling note" }));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.textContent).toBe("use `_foo_` and *not* **bar**");
    expect(body.querySelector("em")).toBeNull();
    expect(body.querySelector("strong")).toBeNull();
  });
});

describe("PeerMessageRow — text is never clamped out of reach (roborev 68628 / 68649 / 68701)", () => {
  // ONE BUG, FOUR ROUNDS. Every string-based prediction of "did the clamp hide something" was
  // optimistic in the direction that hides text: the string compare, the aggregate character budget,
  // and ceil(len/width). The question is a LAYOUT fact, so the row measures instead — and these pin
  // both halves of that: the fail-safe when nothing can be measured, and the measurement itself.

  it("offers the control when nothing can be measured, whatever the text looks like", () => {
    // THE SAFETY PROPERTY. With no layout engine the row cannot know, and "cannot know" must never
    // resolve to "it fits" — that resolution is what shipped three times.
    mount(entry({ gist: "", message: "ok" }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("offers it for the word-wrap shape a character budget got wrong (roborev 68701)", () => {
    // The literal message the peer-messaging contract prescribes. 63 characters on ONE source line:
    // `ceil(63/40)` is 2 and "fits", but greedy wrap puts `taking`, the path, and `and its test` on
    // three rendered lines. No arithmetic on the string sees that; the layout engine does.
    const real = "taking apps/desktop/src/services/controlListener.ts and its test";
    expect([...real].length).toBeLessThan(80);
    mount(entry({ gist: "", message: real }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("offers it when the clamp IS measurably hiding text", () => {
    stubLayout(90, 36);
    mount(entry({ gist: "", message: "a message the clamp is cutting off" }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("retires the control ONLY on an affirmative measurement that it fits", () => {
    // The nicety the first three rounds were reaching for, now earned rather than guessed: when the
    // browser says the body is not overflowing, there is genuinely nothing to reveal.
    stubLayout(36, 36);
    mount(entry({ gist: "", message: "short" }));
    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();
  });

  it("keeps the control when the gist and message differ, even if the clamp fits", () => {
    // The other, measurement-free reason: a sender-written gist is DIFFERENT CONTENT, so expanding
    // shows something new no matter what the layout did.
    stubLayout(36, 36);
    mount(entry({ gist: "taking the parser", message: LONG }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("and expanding drops the clamp, so the hidden tail is actually reachable", () => {
    const real = "taking apps/desktop/src/services/controlListener.ts and its test";
    mount(entry({ gist: "", message: real }));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("");
    expect(body.textContent).toBe(real);
  });
});

describe("PeerMessageRow — the measurement follows the column's width", () => {
  // THE VERCEL FINDING ON #2602. A measurement is only true of the WIDTH it was taken at, and the
  // concierge column is user-resizable — so a `fits` recorded in a wide column goes stale the moment
  // the reader drags it narrower, retiring the control exactly as the text starts being clamped.
  // The same failure as the three character heuristics, arriving through time rather than arithmetic.

  it("brings the control back when the column narrows enough to clamp the text", () => {
    stubResizeObserver();
    stubLayout(36, 36); // wide: it fits, so no control
    mount(entry({ gist: "", message: "taking the parser and its test" }));
    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();

    resizeTo(90, 36); // narrowed: now clamped

    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("retires it again when the column widens back out", () => {
    // Both directions, so the observer is re-reading the heights rather than latching one answer.
    stubResizeObserver();
    stubLayout(90, 36);
    mount(entry({ gist: "", message: "taking the parser and its test" }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();

    resizeTo(36, 36);

    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();
  });

  it("still renders where ResizeObserver does not exist, keeping the fail-safe", () => {
    // Its absence must not throw during render setup, and must not resolve to "it fits".
    expect((globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBeUndefined();
    mount(entry({ gist: "", message: "ok" }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });
});

describe("PeerMessageRow — an app-global end is never called closed (roborev 68628)", () => {
  const withConcierge = () =>
    peerMessageEntry({
      id: "peer-c",
      from: { id: "sparkle:concierge", name: "Sparkle", appGlobal: true },
      to: { id: "a2", name: "Rust Half" },
      message: "the founder asked for the parser split",
      gist: "relaying a decision",
    });

  it("does not claim the concierge is closed", () => {
    // `AgentPill` reads "not in the roster I was given" as evidence the agent is GONE. The
    // concierge's id is deliberately not a roster row, so a pill here announced that the assistant
    // the human is mid-conversation with is closed — on every row it appears in.
    mount(withConcierge());
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    expect(screen.getByTestId(PEER_ROW_TESTID).textContent).not.toContain("is closed");
  });

  it("still names it, as prose rather than a pill wired to nothing", () => {
    mount(withConcierge());
    const party = screen.getByTestId(PEER_APP_PARTY_TESTID);
    expect(party.textContent).toBe("Sparkle");
    expect(party.tagName).not.toBe("BUTTON");
  });

  it("leaves the ORDINARY end a real pill — the fix is scoped to app-global ids", () => {
    // A spun-down worker SHOULD still read as closed; that claim is true. Only the app-global ids
    // are the false case, so the repair must not flatten every end into prose.
    mount(withConcierge());
    // The EXACT id, not a regex — `concierge-agent-pill-closed` and `-unwired` both contain it, so
    // a loose match would be satisfied by the very failure this describe is about.
    const pills = screen.getAllByTestId("concierge-agent-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.getAttribute("data-agent-id")).toBe("a2");
  });
});

describe("PeerMessageRow — the agent pills", () => {
  it("draws BOTH ends as real, clickable agent pills carrying their ids", () => {
    mount();
    const pills = screen.getAllByTestId("concierge-agent-pill");
    expect(pills.map((p) => p.getAttribute("data-agent-id"))).toEqual(["a1", "a2"]);
    // Real pills, not lookalikes — the dead-label bug SentToAgentRow was written to fix.
    expect(pills.every((p) => p.tagName === "BUTTON")).toBe(true);
  });

  it("opens the agent a pill names", () => {
    const onOpenAgent = vi.fn((): RevealOutcome => "revealed");
    mount(entry(), ctx({ onOpenAgent }));
    const pills = screen.getAllByTestId("concierge-agent-pill");
    // The RECIPIENT pill — asserted to exist rather than indexed blind, so a row that stopped
    // drawing the second pill fails here instead of throwing an opaque undefined-target error.
    expect(pills).toHaveLength(2);
    fireEvent.click(pills[1]!);
    expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a2" }));
  });

  it("falls back to the recorded name when the roster no longer resolves the agent", () => {
    // An agent that has since been spun down still has to be readable — the row is a record of
    // something that happened, and it must not degrade into a bare uuid.
    mount(entry(), ctx({ agents: [] }));
    expect(screen.getByTestId(PEER_ROW_TESTID).textContent).toContain("Rust Half");
  });
});

describe("PeerMessageRow — copy all", () => {
  it("copies the FULL message, not the gist that is on screen", async () => {
    // The founder's use for this button is pasting what one agent told another into a PR or a
    // message to a person. Copying the two-line clamp would silently hand him a summary.
    mount();
    fireEvent.click(screen.getByTestId("concierge-copy-peer"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it("copies the full message while the row is still collapsed", async () => {
    mount();
    expect(screen.getByTestId(PEER_ROW_TESTID).getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("concierge-copy-peer"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(LONG);
  });
});

describe("the row dispatch", () => {
  it("ConciergeMessageRow draws a peer message as the peer row", () => {
    // The wiring, not the component: without the `kind === "peer"` branch this message would fall
    // through to the sparkle-bubble default and render as an assistant reply.
    render(
      <AgentPillProvider value={ctx()}>
        <ConciergeMessageRow
          message={entry()}
          wired={false}
          shownBlockIds=""
          onOpenPayload={vi.fn()}
          onNudgeClick={vi.fn()}
          onNudgeAction={vi.fn()}
          onAnswerCopied={vi.fn()}
          onMessageCopied={vi.fn()}
        />
      </AgentPillProvider>,
    );
    expect(screen.getByTestId(PEER_ROW_TESTID)).toBeTruthy();
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
  });
});
