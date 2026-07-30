// @vitest-environment jsdom
//
// TWO defects the founder reported in the concierge composer, and the pills are the whole of both:
//
//   1. A COMPLETED MENTION RENDERED AS PLAIN TEXT IN THE COMPOSE BOX. The pill only appeared after
//      Send, in the thread bubble — so the one surface where the aim is still changeable was the one
//      surface that didn't show it.
//   2. DICTATION COULD NOT PRODUCE ONE. You cannot say "@" out loud, so with the column patched to a
//      terminal there was no spoken way to address the concierge; every word went to the PTY.
//
// ══ WHAT THESE TESTS ASSERT, AND WHY IT IS THE SIDE EFFECT ══════════════════════════════════════
// AGENTS.md's #1 fleet-wide finding is the vacuous pill test: build a `ConciergeMention` object by
// hand, assert it has an `agentId`, ship a feature that renders nothing. Every test below instead
// drives the REAL picker (type a query, press Enter / mousedown a row) or the REAL dictation insert
// callback, and then asserts the RENDERED PILL IN THE COMPOSER'S DOM. None of these assertions can
// pass against the previous code: `concierge-compose-mention-pill` did not exist, so every one of them
// fails on the parent commit. Verified with scripts/mutation-check.sh.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { COMPOSE_MENTION_PILL_TESTID, MENTION_MIRROR_TESTID } from "./MentionMirror";
import { MENTION_PILL_STYLE } from "./MentionPill";
import { SPARKLE_MENTION_ID, type MentionAgent } from "./mentions";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return {
    projectId: "p1",
    projectName: "web",
    band: "running",
    canAcceptInput: true,
    ...over,
  };
}

const BLUEPRINT = agent({ id: "a1", name: "Blueprint UI/UX" });
const KRAKEN = agent({ id: "a2", name: "Kraken Auth" });

type Append = (text: string) => void;

function setup(
  over: { mentionAgents?: MentionAgent[]; withDictation?: boolean } = {},
) {
  const onSend = vi.fn();
  // A STABLE identity, as the box requires: an unstable one re-registers every render.
  const seen: (Append | null)[] = [];
  const registerInsert = (fn: Append | null) => {
    seen.push(fn);
  };
  render(
    <ComposeBox
      onSend={onSend}
      onAttach={vi.fn()}
      mentionAgents={over.mentionAgents ?? [BLUEPRINT, KRAKEN]}
      {...(over.withDictation ? { registerInsert } : {})}
    />,
  );
  // A committed segment arrives from a Tauri event, i.e. outside React, so drive it through act.
  const dictate = (segment: string) => {
    const append = seen.filter((f): f is Append => f !== null).at(-1);
    if (!append) throw new Error("no insert target registered");
    act(() => append(segment));
  };
  return { onSend, dictate };
}

// By LABEL, not by role: with the picker open the textarea reports `role="combobox"` rather than
// `textbox`, so a role query would find it only half the time.
const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const pills = () => screen.queryAllByTestId(COMPOSE_MENTION_PILL_TESTID);
const pillText = () => pills().map((p) => p.textContent);
const options = () => screen.queryAllByTestId("concierge-mention-option");
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));

/** Type into the box the way a user does — the value AND the caret, which is half of what decides
 *  whether a mention query is open. The value goes in through `fireEvent`'s own `target`, never by
 *  assigning `node.value` first: React installs a tracker on that property, so a direct assignment
 *  makes the change event that follows a no-op. */
function type(value: string, caret = value.length) {
  const ta = box();
  fireEvent.change(ta, { target: { value, selectionStart: caret, selectionEnd: caret } });
  ta.selectionStart = caret;
  ta.selectionEnd = caret;
  fireEvent.select(ta);
}

// ══ DEFECT 1 ═════════════════════════════════════════════════════════════════════════════════════

describe("ComposeBox — a completed mention is a PILL in the composer, not plain text", () => {
  it("draws the pill once the user completes a mention through the picker", () => {
    setup();
    type("@Kra");
    // Still being typed — an incomplete query is not an address, so there is nothing to draw yet.
    expect(pills()).toHaveLength(0);

    fireEvent.keyDown(box(), { key: "Enter" }); // the founder's gesture: "if I press enter…"

    expect(pillText()).toEqual(["@Kraken Auth"]);
    expect(pills()[0]!.getAttribute("data-agent-id")).toBe("a2");
  });

  it("draws it for a mention chosen with the POINTER too", () => {
    setup();
    type("@Blue");
    fireEvent.mouseDown(options()[0]!);
    expect(pillText()).toEqual(["@Blueprint UI/UX"]);
  });

  // The derive-from-text rule means a hand-typed address is a first-class mention, so it must pill
  // identically — that is what makes dictation's `@Sparkle` (below) the SAME artifact as a picked one.
  it("draws it for an address typed by hand, with no picker involved", () => {
    setup();
    type("@Kraken Auth ship it");
    expect(pillText()).toEqual(["@Kraken Auth"]);
  });

  it("pills every address in the message, leaving the prose between them alone", () => {
    setup();
    type("@Kraken Auth please sync with @Blueprint UI/UX before landing");
    expect(pillText()).toEqual(["@Kraken Auth", "@Blueprint UI/UX"]);
    // The mirror carries the WHOLE draft, so the pills sit at the right offsets within it rather
    // than being three floating chips.
    expect(screen.getByTestId(MENTION_MIRROR_TESTID).textContent).toBe(
      "@Kraken Auth please sync with @Blueprint UI/UX before landing",
    );
  });

  it("draws NOTHING for a name that matches no agent in the fleet", () => {
    setup();
    type("@Nobody At All ship it");
    expect(pills()).toHaveLength(0);
  });

  // The pill is derived from the text, so deleting the address must delete the pill in the same
  // gesture — a pill outliving its words is the "aim disagrees with the screen" failure this whole
  // feature is built to make impossible.
  it("the pill disappears when Backspace takes the mention", () => {
    setup();
    type("@Kraken Auth ");
    expect(pills()).toHaveLength(1);

    fireEvent.keyDown(box(), { key: "Backspace" });

    expect(box().value).toBe("");
    expect(pills()).toHaveLength(0);
  });

  it("the pill goes away with the draft on send", () => {
    setup();
    type("@Kraken Auth ship it");
    expect(pills()).toHaveLength(1);
    send();
    expect(pills()).toHaveLength(0);
  });

  // An agent that leaves the fleet takes its aim with it (see mentions.ts's header), so it must take
  // its pill too — otherwise the composer promises a destination that no longer exists.
  it("an agent that is not in the roster gets no pill even with its name in the text", () => {
    setup({ mentionAgents: [BLUEPRINT] });
    type("@Kraken Auth ship it");
    expect(pills()).toHaveLength(0);
  });
});

describe("ComposeBox — the pill layer cannot disturb the box it paints behind", () => {
  // The mirror is a SIBLING of the textarea inside the overlay wrapper, and that wrapper's
  // non-textarea children are measured as a PLACEHOLDER FLOOR under auto-grow. The mirror tracks the
  // CONTENT, so measuring it would add the textarea's chrome to a height that already includes the
  // padding and grow the box by about a line for every draft with text in it. It opts out by
  // attribute; this proves the opt-out is honoured, by giving it a height that would be impossible to
  // miss if it leaked into the floor.
  it("is NOT measured as a placeholder floor", () => {
    setup();
    type("hello");
    Object.defineProperty(screen.getByTestId(MENTION_MIRROR_TESTID), "scrollHeight", {
      value: 500,
      configurable: true,
    });

    type("hello!"); // re-runs the measuring layout effect

    // jsdom reports a 0 scrollHeight for the textarea, so the box rests at its one-line minimum.
    // Were the mirror measured, the floor would be clamped to the ten-line cap (212px) instead.
    expect(box().style.height).toBe("41px");
  });

  it("takes no pointer events, so every click and drag-select still reaches the textarea", () => {
    setup();
    type("@Kraken Auth ship it");
    expect(screen.getByTestId(MENTION_MIRROR_TESTID).style.pointerEvents).toBe("none");
  });

  // Decorative: the textarea holds the real text and carries the accessible name ("Message"), so
  // announcing the mirrored copy as well would read the draft out twice.
  it("is hidden from assistive tech", () => {
    setup();
    expect(screen.getByTestId(MENTION_MIRROR_TESTID).getAttribute("aria-hidden")).toBe("true");
  });

  // The fills are painted behind the real glyphs, so any divergence in the type ramp or the box
  // metrics slides them off the words they belong to — and a misaligned pill still renders, so
  // nothing else would fail. Both elements spread ONE object (COMPOSE_TEXT_METRICS); this fails if
  // either of them is ever given its own hardcoded copy.
  it("shares the textarea's exact BOX geometry", () => {
    setup();
    const mirror = screen.getByTestId(MENTION_MIRROR_TESTID);
    for (const prop of ["fontSize", "lineHeight", "padding", "borderWidth", "borderStyle"] as const) {
      expect(mirror.style[prop]).not.toBe(""); // the shared object actually reached this element
      expect(mirror.style[prop]).toBe(box().style[prop]);
    }
  });

  // ══ roborev 55574 (High) — the box metrics are NOT the whole of alignment ══════════════════════
  // The case above equalises the BOX and is silent about INLINE content, which is where the mirror
  // actually lost its alignment: the shared pill style carries `padding: "1px 4px"`, and inside the
  // mirror that is 8px of horizontal ADVANCE the textarea's text does not have — so the fill ran long
  // and every glyph after a pill was pushed right, accumulating per pill. `whiteSpace: "nowrap"` was
  // the same mistake in the other axis: the textarea wraps `@Blueprint UI/UX` at its internal space,
  // so refusing to wrap made whole lines diverge.
  //
  // jsdom has no layout, so it cannot measure the drift — but it CAN read the declarations that cause
  // it, and that is the only guard this layer can have. Asserted on the longhands because jsdom
  // expands the shorthand.
  it("gives its pills ZERO layout footprint, so they cannot shift a glyph", () => {
    setup();
    type("@Kraken Auth ship it");
    const pill = pills()[0]!;
    expect(pill.style.paddingLeft).toBe("0px");
    expect(pill.style.paddingRight).toBe("0px");
    // Wraps exactly as the textarea does — `nowrap` here would diverge past the first wrap point.
    expect(pill.style.whiteSpace).toBe("inherit");
    // …and the visual inset is repainted by something OUTSIDE the layout flow, or the pill would
    // stop looking like a pill in exchange for being aligned.
    expect(pill.style.boxShadow).toContain("3px");
  });

  // The other half of that fix: the shared style must KEEP its padding. Flattening MENTION_PILL_STYLE
  // would align the mirror by making the sent bubble's pill and the concierge's agent pill look wrong,
  // which is the fix nobody wants and the one a reader of the case above might reach for.
  it("takes the padding off the MIRROR only, never off the shared pill", () => {
    expect(MENTION_PILL_STYLE.padding).toBe("1px 4px");
    expect(MENTION_PILL_STYLE.whiteSpace).toBe("nowrap");
  });
});

// ══ DEFECT 2 ═════════════════════════════════════════════════════════════════════════════════════

describe("ComposeBox — dictating 'sparkle' inserts an @Sparkle pill", () => {
  it("turns a spoken address into the same artifact the picker produces", () => {
    const { dictate } = setup({ withDictation: true });

    dictate("Sparkle, what is the status of the build?");

    // The literal the picker would have written — sigil, name, one separating space — and the
    // vocative comma the speaker paused for is gone rather than left in the prose.
    expect(box().value).toBe("@Sparkle what is the status of the build?");
    expect(pillText()).toEqual(["@Sparkle"]);
    expect(pills()[0]!.getAttribute("data-agent-id")).toBe(SPARKLE_MENTION_ID);
  });

  // The point of the whole exercise: the founder's routing reads `ConciergeMention[]` off the send,
  // so a pill nobody can act on would be decoration. The SHAPE is unchanged — `{agentId, name}`.
  it("reports the concierge as a mention on the send", () => {
    const { dictate, onSend } = setup({ withDictation: true });
    dictate("Sparkle, what broke?");

    send();

    expect(onSend).toHaveBeenCalledWith("@Sparkle what broke?", [
      { agentId: SPARKLE_MENTION_ID, name: "Sparkle" },
    ]);
  });

  it("takes the name alone, when that is the whole utterance", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("Sparkle");
    expect(box().value).toBe("@Sparkle ");
    expect(pillText()).toEqual(["@Sparkle"]);
  });

  // Typing and speaking must leave the box in the SAME state — that is the founder's phrasing of the
  // requirement ("so speech and typing produce the same artifact"), and it is what lets everything
  // downstream stay ignorant of which one happened.
  it("produces exactly what typing the address produces", () => {
    const spoken = setup({ withDictation: true });
    spoken.dictate("Sparkle, ship it");
    const dictatedValue = box().value;
    cleanup();

    setup();
    type("@Sparkle ship it");

    expect(box().value).toBe(dictatedValue);
    expect(pillText()).toEqual(["@Sparkle"]);
  });

  it("is deletable like any other pill", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("Sparkle");
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(box().value).toBe("");
    expect(pills()).toHaveLength(0);
  });
});

// The narrow half of the rule, and the reason it is narrow: "sparkle" is this app's own name, so it
// occurs in ordinary dictated prose. Only the ADDRESSING POSITION — the head of the message, which is
// where `mentions[0]` already means "the envelope" — becomes a pill. Full reasoning, including why
// the wake phrase ("Hey Sparkle") and stop phrase ("Sparkle, stop") cannot reach this code at all,
// is on mentions.dictatedSparkleAddress.
describe("ComposeBox — dictated prose that merely CONTAINS 'sparkle' is left alone", () => {
  it("does not pill it mid-sentence", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("the sparkle desktop app keeps crashing");
    expect(box().value).toBe("the sparkle desktop app keeps crashing");
    expect(pills()).toHaveLength(0);
  });

  it("does not pill it when the segment lands after words already in the box", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("fix the crash");
    dictate("Sparkle, and tell me when it is done");
    expect(box().value).toBe("fix the crash Sparkle, and tell me when it is done");
    expect(pills()).toHaveLength(0);
  });

  it("does not pill it when it lands after text the user TYPED", () => {
    const { dictate } = setup({ withDictation: true });
    type("look at this: ");
    dictate("Sparkle desktop");
    expect(pills()).toHaveLength(0);
  });

  // The boundary is a word boundary that is not more name — an apostrophe or a letter means the
  // speaker said a different word, and pilling the first seven characters would strand the rest.
  it("does not pill a longer word that merely starts with it", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("Sparklers are on sale");
    expect(box().value).toBe("Sparklers are on sale");
    expect(pills()).toHaveLength(0);
  });

  it("does not pill the possessive", () => {
    const { dictate } = setup({ withDictation: true });
    dictate("Sparkle's release notes are wrong");
    expect(box().value).toBe("Sparkle's release notes are wrong");
    expect(pills()).toHaveLength(0);
  });

  // An ordinary dictated sentence reports NO second argument, exactly as it always has — the send
  // contract for an unaddressed message is untouched by any of this.
  it("sends unaddressed prose with no mentions argument at all", () => {
    const { dictate, onSend } = setup({ withDictation: true });
    dictate("the sparkle desktop app keeps crashing");
    send();
    expect(onSend).toHaveBeenCalledWith("the sparkle desktop app keeps crashing");
  });
});
