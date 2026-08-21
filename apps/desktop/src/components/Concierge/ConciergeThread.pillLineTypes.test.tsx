// @vitest-environment jsdom
//
// ══ EVERY CHAT LINE THAT CAN NAME AN AGENT DRAWS A LIVE PILL (bead sparkle-s6gonk) ═════════════
//
// THE FOUNDER'S REPORT: he clicked `@Sparkle AGENTS.md Compression` inside a *"Refused the
// concierge's message to …"* line and nothing happened, and he wondered aloud whether the grey text
// meant it was not clickable. The standing hypothesis was that a refusal line went through a
// DIFFERENT render path — one that emitted the chip styling without the click handler.
//
// ══ THAT HYPOTHESIS IS WRONG, AND THIS FILE IS THE STANDING PROOF ══════════════════════════════
// There is ONE path. Every app-authored line is composed by `conciergeLine.ref()` into markdown
// (`[@Name](sparkle-agent:<id>)`), stored as `message.text` exactly like the concierge's own prose,
// and rendered by the same `<Markdown>` → `ExternalLink` → `<AgentPill>` chain. A refusal line's
// pill is the same `<button>` a reply's is. What was actually broken was one layer down (the host's
// opener revealed too weakly — `ConciergeHost.pillReveal.test.tsx`) and one layer up (the row's
// de-emphasis reached the label — `PillInk.test.tsx`).
//
// So this suite is not the fix. It is the REGRESSION FENCE around the claim the fix rests on: that
// no line type can quietly lose its handler. That claim was never asserted anywhere, which is why a
// plausible-but-wrong hypothesis about it survived long enough to be built against.
//
// ══ WHY EVERY TYPE IS MOUNTED IN ONE TREE ══════════════════════════════════════════════════════
// AGENTS.md's "N targets, only one mounted" rule. Asserting that a pill in a refusal line is a
// button proves nothing on its own about whether the rule is keyed to the row type — a build that
// made EVERY pill a button and a build that special-cased refusals look identical from one row. So
// all five line types render together and each is asserted separately, and each pill is clicked so
// the handler count is what rises rather than the DOM merely looking right.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { ConciergeThread } from "./ConciergeThread";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import type { ConciergeMessage } from "./types";

const AGENT = {
  id: "w1",
  name: "Sparkle AGENTS.md Compression",
  // `running` is the band that paints GREEN — the state the founder's agent was actually in while
  // its label read as disabled.
  band: "running",
  projectId: "p1",
  projectName: "sparkle",
} as never;

const REF = "[@Sparkle AGENTS.md Compression](sparkle-agent:w1)";

/** One message per LINE TYPE the thread can draw that is able to carry an agent reference. */
const MESSAGES: ConciergeMessage[] = [
  // 1. AN ORDINARY CONCIERGE REPLY — the control. The one type nobody doubted.
  { id: "reply-1", kind: "sparkle", text: `Ask ${REF} about it.`, settled: true },
  // 2. A PROACTIVE PUSH — the concierge speaking unasked. Its own arm in ConciergeMessageRow, with
  //    its own header, so it is a genuinely separate branch rather than a variant of (1).
  { id: "push-1", kind: "sparkle", push: true, text: `${REF} finished the compression pass.` },
  // 3. A REFUSAL RECEIPT — THE FOUNDER'S OWN LINE. Carries an `actionReceipt`, so it is drawn
  //    through the NOTICE arm: grey ink, "Sparkle → Concierge" header, addressed to the concierge.
  {
    id: "refusal-1",
    kind: "sparkle",
    text: `Refused the concierge's message to ${REF} — send_to_agent_terminal requires a goal.`,
    actionReceipt: { kind: "sent", ok: false, reason: "send_to_agent_terminal requires a goal." },
  },
  // 4. A SUCCESS RECEIPT — a TOOL RESULT the app posted about a call that worked. Same notice arm,
  //    opposite `ok`, and the treatment is keyed on recipient rather than on success — so a build
  //    that keyed it on `ok` would draw this one differently and be caught here.
  {
    id: "ok-1",
    kind: "sparkle",
    text: `The concierge wrote to ${REF}.`,
    actionReceipt: { kind: "sent", ok: true, channel: "terminal", subjectId: "w1", subjectName: "Sparkle AGENTS.md Compression" },
  },
  // 5. AN APP-AUTHORED SYSTEM LINE ADDRESSED TO THE FOUNDER — same author as (3) and (4), opposite
  //    recipient, so it keeps full weight and no header. A different treatment, and it must still
  //    produce a live pill.
  { id: "sys-1", kind: "sparkle", text: `${REF} is the one holding that branch.` },
] as ConciergeMessage[];

function mount(onOpenAgent: () => "revealed") {
  const value: AgentPillContextValue = { agents: [AGENT], onOpenAgent };
  render(
    <AgentPillProvider value={value}>
      <ConciergeThread messages={MESSAGES} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />
    </AgentPillProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;

afterEach(() => cleanup());

describe("a pill is a live control in EVERY line type that can hold one", () => {
  // The ids are listed rather than derived from MESSAGES so that DELETING a fixture is a visible
  // edit here too. A loop over the fixture array would silently shrink its own coverage.
  const CASES: Array<[string, string]> = [
    ["a concierge reply", "reply-1"],
    ["a proactive push", "push-1"],
    ["a REFUSAL line — the founder's case", "refusal-1"],
    ["a success receipt (tool result)", "ok-1"],
    ["an app-authored system line", "sys-1"],
  ];

  for (const [label, id] of CASES) {
    it(`${label} renders a real button whose click fires the opener`, () => {
      const onOpenAgent = vi.fn(() => "revealed" as const);
      mount(onOpenAgent);

      const pill = within(row(id)).getByTestId("concierge-agent-pill");
      // A BUTTON, not a styled span. The dead-end shape this forbids is a chip that LOOKS
      // identical to a working pill and does nothing — which is worse than plain text, because the
      // reader keeps clicking it.
      expect(pill.tagName).toBe("BUTTON");
      expect(pill.getAttribute("data-agent-id")).toBe("w1");

      fireEvent.click(pill);

      expect(onOpenAgent).toHaveBeenCalledTimes(1);
      // The spy is typed `() => "revealed"`, so its recorded args are a 0-tuple to TypeScript even
      // though the pill really passes a target. Read through `vi.mocked(...).mock.calls` as unknown
      // rather than indexing the tuple, which does not typecheck.
      const args = (onOpenAgent.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]!;
      expect(args[0]).toMatchObject({ agentId: "w1", projectId: "p1" });
    });
  }

  it("the refusal and success rows really ARE the notice arm, and the others really are not", () => {
    // Without this the five cases above could all be passing because every row is drawn as ordinary
    // prose — i.e. because the treatment under discussion is not applied at all. The contrast is
    // what makes "even in a de-emphasised row" a claim with content.
    mount(vi.fn(() => "revealed" as const));
    expect(row("refusal-1").getAttribute("data-recipient")).toBe("concierge");
    expect(row("ok-1").getAttribute("data-recipient")).toBe("concierge");
    expect(row("reply-1").getAttribute("data-recipient")).toBe("founder");
    // A push is app-DELIVERED but concierge-AUTHORED prose aimed at the founder, so it lands on the
    // founder side of the same axis rather than outside it. Asserted as measured, not as guessed.
    expect(row("push-1").getAttribute("data-recipient")).toBe("founder");
    expect(row("sys-1").getAttribute("data-recipient")).toBe("founder");
  });

  it("and the status DOT is drawn in every one of them, since it is what carries status", () => {
    // The rule the label change encodes only holds if the dot is actually present everywhere. A
    // pill that lost its dot inside some row type would leave status signalled by nothing at all.
    mount(vi.fn(() => "revealed" as const));
    for (const [, id] of CASES) {
      const pill = within(row(id)).getByTestId("concierge-agent-pill");
      expect(pill.querySelector("span[aria-hidden]")).toBeTruthy();
    }
  });
});
