// @vitest-environment jsdom
//
// ══ THE PILL'S LABEL IS NEUTRAL; THE DOT ALONE CARRIES STATUS (bead sparkle-s6gonk) ════════════
//
// THE FOUNDER'S SECOND QUESTION, verbatim: *"is it grayed out because it's no longer relevant? Is
// that what's going on?"* It was not. The pill he was looking at had a GREEN status dot and its
// agent was actively working. The grey was coming from somewhere else entirely, and it was
// contradicting the dot sitting six pixels away.
//
// WHERE FROM: `NoticeAttribution.NOTICE_INK_VARS` redefines `--c-cream` on a concierge-addressed
// row so its SENTENCE recedes — a deliberate, founder-approved treatment. Every pill painted
// `C.cream`, i.e. that same token, so the de-emphasis reached the pill's LABEL too. The dot does
// not: it resolves `bandColor(band)`, an unrelated token. Two adjacent signals, one row apart from
// the truth.
//
// THE RULE, chosen by the founder on 2026-08-20: **the dot alone carries status, and the label is
// plainly neutral everywhere a pill renders.** `--c-pill-ink` is what encodes it — a token with the
// same VALUE as `--c-cream` whose whole purpose is to be overridable separately.
//
// ══ WHY THE TWO ROWS THAT RE-INK THEIR SUBTREE GET OPPOSITE ANSWERS ════════════════════════════
// This is the part a future edit is most likely to get wrong, so it is asserted in both directions
// rather than described:
//
//   • `SENT_CARD_INK_VARS` changes the GROUND (a card that is black in BOTH themes). A pill there
//     MUST re-ink or its label is near-black on black in light mode. It pins `--c-pill-ink`.
//   • `NOTICE_INK_VARS` changes only the EMPHASIS. A pill there must NOT re-ink. It leaves the
//     token alone.
//
// A test that only checked the notice row would pass for a build that had deleted the token
// entirely; one that only checked the sent card would pass for a build that greyed every pill. The
// pair is what pins the rule.
//
// ══ WHAT THIS TIER CANNOT SEE ══════════════════════════════════════════════════════════════════
// jsdom never loads the stylesheet, so `var(--c-pill-ink)` resolves to nothing here and no computed
// colour can be read. These assertions are about DECLARATIONS. The painted result is measured in
// real Chrome by `scripts/visual/notice-attribution-probe.mjs`, which reads the pill label's and
// the dot's computed colours off the real tree — see its pill-ink block.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AgentPill, AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { MENTION_PILL_STYLE } from "./MentionPill";
import { NOTICE_INK_VARS } from "./NoticeAttribution";
import { SENT_CARD_INK_VARS } from "./SentToAgentRow";
import { C } from "../../theme/colors";

const AGENT = {
  id: "ag-1",
  name: "Sparkle AGENTS.md Compression",
  band: "working",
  projectId: "p1",
  projectName: "sparkle",
} as never;

const WIRED: AgentPillContextValue = { agents: [AGENT], onOpenAgent: () => "revealed" };

afterEach(() => cleanup());

describe("a live pill's label paints the pill ink, not the prose ink", () => {
  it("declares var(--c-pill-ink) and NOT var(--c-cream)", () => {
    render(
      <AgentPillProvider value={WIRED}>
        <AgentPill agentId="ag-1" fallbackName="Sparkle AGENTS.md Compression" />
      </AgentPillProvider>,
    );
    const pill = screen.getByTestId("concierge-agent-pill");
    // The literal token, not `C.pillInk`'s identity — an assertion that compared the constant to
    // itself would pass for any value, including `var(--c-cream)`.
    expect(pill.style.color).toBe("var(--c-pill-ink)");
    expect(pill.style.color).not.toBe("var(--c-cream)");
  });

  it("the composer's mention pill agrees, so both halves of a mention read alike", () => {
    // The founder's standing ask is that mentions be SYMMETRICAL: an agent the concierge names must
    // read the same as one he addressed. A rule applied to one and not the other is the drift that
    // ask rules out.
    expect(MENTION_PILL_STYLE.color).toBe("var(--c-pill-ink)");
  });
});

describe("the two rows that re-ink their subtree answer this OPPOSITELY, on purpose", () => {
  it("a NOTICE row de-emphasises its prose and leaves the pill ink alone", () => {
    const vars = NOTICE_INK_VARS as Record<string, string>;
    // The de-emphasis is still there — this must not read as "the notice treatment was deleted".
    expect(vars["--c-cream"]).toBe("var(--c-concierge-muted)");
    expect(vars.color).toBe("var(--c-concierge-muted)");
    // …and the pill ink is untouched, which is what keeps a live control full weight inside it.
    expect(vars["--c-pill-ink"]).toBeUndefined();
  });

  it("the SENT card pins the pill ink too, because it changes the GROUND", () => {
    const vars = SENT_CARD_INK_VARS as Record<string, string>;
    expect(vars["--c-pill-ink"]).toBeDefined();
    // The SAME fixed ink the rest of that black card uses. A pill left on the themed value would be
    // near-black on black in light mode.
    expect(vars["--c-pill-ink"]).toBe(vars["--c-cream"]);
  });
});

describe("the token exists and is a token", () => {
  it("C.pillInk is the custom property, so a row can override it in isolation", () => {
    expect(C.pillInk).toBe("var(--c-pill-ink)");
    // Distinct from cream at the TOKEN level even though the two hexes match — that separation is
    // the entire mechanism. If these ever collapse to one name the bug returns silently.
    expect(C.pillInk).not.toBe(C.cream);
  });
});
