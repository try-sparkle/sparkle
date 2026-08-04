// @vitest-environment jsdom
//
// THE PER-MESSAGE STATUS, and the three promises it makes that a screenshot would not catch.
//
//   1. NO STATUS, NO ROW. Almost every bubble in a settled thread has none, so "absent" has to mean
//      nothing in the DOM at all — not an empty box, not a reserved line of height.
//   2. THE TEXT CARRIES THE COLOUR, and NOTHING ELSE MOVES between tones. The founder rejected a
//      version of ThinkingIndicator whose row reflowed between states (see its header); this surface
//      inherits that rule, and the assertion below is made across ALL FOUR tones at once rather than
//      one case at a time, because "only the ink differs" is a claim about the whole set — checked
//      one tone per test, a fifth property that happened to vary with tone would slip through every
//      individual comparison.
//   3. IT INVENTS NO WORDING. The producer composes the phrase; this draws it verbatim.
//
// AND ONE NEGATIVE: it is not a live region. The column owns exactly ONE announcer, and a second in
// this subtree double-announces — `ConciergeThread.roleLabels` asserts that and has caught it before.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { C } from "../../theme/colors";
import {
  MESSAGE_STATUS_TESTID,
  MessageStatus,
  type ConciergeMessageStatus,
} from "./MessageStatus";

afterEach(() => cleanup());

/** The rendered ink, canonicalised.
 *
 *  Through a scratch node first, exactly as ThinkingIndicator.test.tsx does and for the same reason:
 *  the theme's tokens are not all the same KIND of value. The two muted inks are `var(--…)` and
 *  survive verbatim, while sienna is a literal the CSSOM rewrites to `rgb(…)`. Comparing raw strings
 *  would make the red case fail for a reason that has nothing to do with this component. */
const canon = (v: string) => {
  const el = document.createElement("div");
  el.style.color = v;
  return el.style.color;
};

const TONES = ["waiting", "slow", "stalled", "settled"] as const;

function node(): HTMLElement | null {
  return screen.queryByTestId(MESSAGE_STATUS_TESTID);
}

function draw(status?: ConciergeMessageStatus | null) {
  return render(<MessageStatus status={status} />);
}

describe("MessageStatus — absent is nothing at all", () => {
  it("renders NO node, and no reserved height, without a status", () => {
    // Both spellings of absent: the prop omitted entirely, and an explicit null (which is what a
    // producer holding a nullable field hands down).
    for (const absent of [undefined, null] as const) {
      const { container, unmount } = draw(absent);
      expect(node()).toBeNull();
      // The container is EMPTY — not "contains a node with zero height". A box reserving a line for
      // a surface that is almost always absent would push the whole transcript down per message,
      // and jsdom has no layout engine to measure that with, so the structural assertion is the
      // only honest one available (see the repo's jsdom note).
      expect(container.innerHTML).toBe("");
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });
});

describe("MessageStatus — the producer owns the words", () => {
  it("draws the composed phrase verbatim and adds nothing to it", () => {
    draw({ text: "Checking git", tone: "waiting" });
    // `toBe`, not `toContain`: a component that appended "· 12s" or a tone name to the producer's
    // phrase would pass a containment check while breaking the one rule this file's header states.
    expect(node()?.textContent).toBe("Checking git");
  });

  it("draws a DIFFERENT phrase for the same tone — the wording is never derived from the tone", () => {
    // The mirror of the row above, and the reason it exists: if this component ever grew a
    // tone → phrase map, the first test would still pass on whichever phrase happened to match.
    draw({ text: "Reading your message", tone: "waiting" });
    expect(node()?.textContent).toBe("Reading your message");
  });
});

describe("MessageStatus — the ink is the ENTIRE signal", () => {
  /** Every inline declaration EXCEPT `color`, as a sorted string — the whole layout of the row. */
  function layoutWithoutInk(el: HTMLElement): string {
    return (el.getAttribute("style") ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && !d.toLowerCase().startsWith("color:"))
      .sort()
      .join("; ");
  }

  it("renders the same text and the SAME layout in all four tones, differing only in colour", () => {
    const drawn = TONES.map((tone) => {
      const { unmount } = draw({ text: "Checking git", tone });
      const el = node();
      expect(el).not.toBeNull();
      const seen = {
        tone,
        text: el!.textContent,
        tag: el!.tagName,
        layout: layoutWithoutInk(el!),
        ink: el!.style.color,
        dataTone: el!.getAttribute("data-tone"),
      };
      unmount();
      return seen;
    });

    // ONE layout across the set. Compared as a set rather than pairwise against the first, so the
    // failure message names how many distinct layouts there were.
    expect(new Set(drawn.map((d) => d.layout)).size).toBe(1);
    // …and it is not the empty string, which would make the check above vacuously true for a
    // component that dropped its styling entirely.
    expect(drawn[0]!.layout.length).toBeGreaterThan(0);
    expect(new Set(drawn.map((d) => d.text)).size).toBe(1);
    expect(new Set(drawn.map((d) => d.tag)).size).toBe(1);
    // The tone reaches the DOM, so a screenshot diff (and the row-level suite) can name the rung
    // without reading a colour back out of a style attribute.
    expect(drawn.map((d) => d.dataTone)).toEqual([...TONES]);
    // The inks, and they are ThinkingIndicator's — the same ladder, so the column and the bubble
    // cannot say "slow" in two different yellows.
    expect(drawn.map((d) => d.ink)).toEqual([
      canon(C.conciergeMuted),
      canon(C.amberInk),
      canon(C.sienna),
      canon(C.conciergeMuted),
    ]);
    // The three RUNGS are three different colours. Asserting the mapping above alone would pass if
    // all four tokens resolved to the same value, which is exactly the regression a palette edit
    // could introduce without touching this file.
    expect(new Set([drawn[0]!.ink, drawn[1]!.ink, drawn[2]!.ink]).size).toBe(3);
  });

  it("truncates rather than wrapping — a long phrase must not reflow the transcript", () => {
    draw({
      text: "Reading Kraken Auth's terminal and checking the last three PR runs on drodio/sparkle",
      tone: "slow",
    });
    const el = node()!;
    // The STYLE EXPRESSION, not a measurement: jsdom has no layout engine, so `getBoundingClientRect`
    // is 0 and a width assertion would prove nothing (see the repo's jsdom note).
    expect(el.style.whiteSpace).toBe("nowrap");
    expect(el.style.overflow).toBe("hidden");
    expect(el.style.textOverflow).toBe("ellipsis");
    // `100%` — the entry above this box already caps at 92% OF THE COLUMN, and it is shrink-to-fit,
    // so a second percentage here would measure this box against a width this box just contributed
    // to and clip 8% off it (roborev 57853-M1). Asserted as an exact value rather than "some
    // maxWidth is set" because the regression is a plausible-looking number, not a missing one.
    expect(el.style.maxWidth).toBe("100%");
    // Without this the flex column's default `min-width: auto` lets the content push past `maxWidth`
    // and the ellipsis never engages.
    // `"0"`, not `"0px"` — React writes the unitless number through and the CSSOM keeps it verbatim.
    expect(el.style.minWidth).toBe("0");
  });

  it("sits on the right edge — the founder's 'bottom right corner'", () => {
    draw({ text: "Composing", tone: "waiting" });
    expect(node()?.style.textAlign).toBe("right");
    expect(node()?.style.marginLeft).toBe("auto");
  });
});

describe("MessageStatus — not a second live region", () => {
  it("announces nothing: no aria-live, no status/alert/log role", () => {
    // The column has ONE announcer (ConciergeColumn). A second region in this subtree
    // double-announces — see ConciergeThread.roleLabels, which caught exactly that.
    const { container } = draw({ text: "Checking git", tone: "slow" });
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(
      0,
    );
    // And it is not hidden from assistive tech either — it is ordinary readable text, reachable the
    // way any other paragraph in the column is.
    expect(node()?.getAttribute("aria-hidden")).toBeNull();
  });
});
