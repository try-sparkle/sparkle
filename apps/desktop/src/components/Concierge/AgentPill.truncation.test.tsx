// @vitest-environment jsdom
//
// ── THE PILL TRUNCATES RATHER THAN OVERHANGING (bead sparkle-kk9dg.1) ──────────────────────────
// The very-narrow end of the founder's hybrid: once the pill ALONE is wider than its line, it is
// the only thing left to give, and what it must do is ellipsize ("@Concierge Say…") while staying
// clickable — not overhang its container and get clipped mid-glyph with nothing to say it was cut.
//
// THE LABEL COULD NOT ELLIPSIZE AT ALL, and that is the specific defect. It was rendered as a BARE
// TEXT NODE beside the status dot (`{dot}@{agent.name}`); `text-overflow` applies to a block
// container, and a bare text node is not one, so there was nothing for the property to apply to.
// The sigil and the name are now wrapped TOGETHER in one clippable span.
//
// THE TRAP THESE TESTS ALSO PIN, AT BOTH LEVELS. The clip must NOT go on the pill's OUTER
// inline-flex box: an inline-level box whose `overflow` is other than `visible` takes its BOTTOM
// MARGIN EDGE as its baseline instead of its text baseline, and this pill renders inside
// `<Markdown>` prose (i.e. inside a `<p>`), so every pill in every concierge reply would shift
// vertically against its own sentence. `max-width: 100%` bounds the outer box without touching how
// it sits on the line.
//
// AND IT MUST NOT MAKE THE INNER NAME SPAN A SCROLL CONTAINER EITHER, which is where the first fix
// put it back (roborev 58698/58699). A scroll container's alignment baseline is synthesised from its
// border box, and a flex container's first baseline comes from its FIRST FLEX ITEM — which that span
// IS in every dot-less form of the pill. Hence `.clip-no-scroll` rather than `overflow: hidden`; see
// the dedicated case below for why it is a class and not an inline `overflow: clip`.
//
// jsdom cannot observe the truncation itself (no layout engine — `getBoundingClientRect` is zeros
// and `text-overflow` never evaluates; see docs/jsdom-test-caveats.md), so these assert the
// declarations that make it possible, every one of which was absent before. The real-browser half
// lives in `scripts/visual/recap-narrow-probe.mjs`.
import { cleanup, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPill, AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import type { MentionAgent } from "./mentions";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/** Long enough that it alone overruns a 200px column — the case that produced the clipped glyph. */
const LONG_NAME = "Concierge Says What It Is Doing";

/**
 * "This length is declared, and it is zero." NOT an exact `"0px"` comparison, which fails on a
 * perfectly correct declaration: React appends no unit to a numeric zero, so `minWidth: 0` reaches
 * the DOM as `"0"`. Still fails on `""` — the property being absent is the state that caused the
 * bug, and is what these tests exist to catch.
 */
const isZeroLength = (v: string) => v !== "" && Number.parseFloat(v) === 0;

const AGENT: MentionAgent = {
  id: "agent-7",
  name: LONG_NAME,
  projectId: "p1",
  projectName: "web",
  band: "needs_you",
  canAcceptInput: true,
};

function mount(value: AgentPillContextValue, agentId = "agent-7") {
  return render(
    <AgentPillProvider value={value}>
      <AgentPill agentId={agentId} fallbackName={`@${LONG_NAME}`} />
    </AgentPillProvider>,
  );
}

const wired = (over: Partial<AgentPillContextValue> = {}): AgentPillContextValue => ({
  agents: [AGENT],
  onOpenAgent: vi.fn((): RevealOutcome => "revealed"),
  ...over,
});

/** The four forms the pill wears, each mounted the way a real surface produces it — and each with
 *  the tooltip it owes a reader whose copy of the name has been eaten by the ellipsis. */
const FORMS: Array<{ what: string; mount: () => void; testid: string; title: string }> = [
  {
    what: "the live pill",
    mount: () => mount(wired()),
    testid: "concierge-agent-pill",
    title: `Open ${LONG_NAME} in web`,
  },
  {
    what: "the unresolved pill with a history route",
    // A wired surface whose roster no longer holds the id: known closed before the click.
    mount: () => mount(wired({ agents: [], onSeeHistory: vi.fn() })),
    testid: "concierge-agent-pill-closed",
    title: `${LONG_NAME} is closed.`,
  },
  {
    what: "the unresolved pill with no route out",
    mount: () => mount(wired({ agents: [] })),
    testid: "concierge-agent-pill-closed",
    title: `${LONG_NAME} is closed.`,
  },
  {
    what: "the unwired pill",
    // No opener at all — SupportModal and agent replies render `<Markdown>` like this.
    mount: () => mount({ agents: [AGENT] }),
    testid: "concierge-agent-pill-unwired",
    // JUST THE NAME. This surface is not wired, so its roster is not authoritative and the pill may
    // make no claim about the agent's lifecycle — "…is closed" here would be the false claim the
    // component's own comments spend three paragraphs preventing. The name is a fact about the
    // TEXT, which is the only thing the ellipsis took away.
    title: `@${LONG_NAME}`,
  },
];

describe.each(FORMS)("$what truncates its name", ({ mount: mountForm, testid, title }) => {
  it("keeps the FULL name recoverable on hover — the safety net for EVERY form", () => {
    // ── THE ONE FORM THAT HAD NO TOOLTIP AT ALL (roborev 58699) ─────────────────────────────────
    // Truncation applies to all four forms; the tooltip did not. The live pill promised "Open X in
    // Y" and both closed forms carried "X is closed.", and the UNWIRED form carried nothing — so a
    // name cut to "@Concierge Say…" there was unrecoverable by any means. That is the form
    // SupportModal and agent replies render, i.e. the one that actually reaches a reader.
    //
    // Asserted PER FORM rather than once, because "the ellipsis is allowed to eat the name on
    // screen precisely because hovering still recovers it" is a claim about every form that can
    // ellipsize, and testing it on one of them is how three forms went uncovered.
    mountForm();
    const t = screen.getByTestId(testid).getAttribute("title");
    expect(t).not.toBeNull();
    expect(t).toContain(LONG_NAME);
    expect(t).toBe(title);
  });

  it("carries the ellipsis on the NAME span, which is a block container that can take it", () => {
    mountForm();
    const label = screen.getByTestId("concierge-agent-pill-name");
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(label.style.whiteSpace).toBe("nowrap");
    // Without this the same `min-width: auto` floor keeps the span at full width and the overflow
    // — and therefore the ellipsis — never triggers.
    expect(isZeroLength(label.style.minWidth)).toBe(true);
  });

  it("clips WITHOUT becoming a scroll container — the hazard, one level down", () => {
    // ── WHAT SHIPPED, AND WHY IT WAS THE SAME BUG AS THE ONE IT AVOIDED (roborev 58698/58699) ───
    // This span carried `overflow: hidden` inline. `hidden` clips, but it also makes the box a
    // SCROLL CONTAINER — and a scroll container's alignment baseline is SYNTHESISED from its border
    // box rather than taken from its text (CSS Box Alignment §9). A flex container takes its first
    // baseline from its FIRST FLEX ITEM, and in every DOT-LESS form of the pill this span IS that
    // item: the inert closed span, the closed disclosure button, the unwired span, and a resolved
    // pill showing `showClosed`. So the clip that was moved one level in to protect the pill's
    // baseline reintroduced the same hazard one level down, on the forms nothing had measured.
    //
    // THE CLASS, NOT AN INLINE `overflow: clip`. `clip` is the right value — it clips without
    // establishing a scroll container, and `text-overflow` still applies — but it is WebKit 16+ and
    // `tauri.conf.json` still declares `minimumSystemVersion: "11.0"`, where the declaration is
    // DROPPED. That leaves `overflow: visible`, which takes the ellipsis with it (text-overflow
    // needs a non-visible overflow), so a long name would paint out of the card with nothing to say
    // it was cut. `index.css`'s `.clip-no-scroll` is `hidden` upgraded to `clip` under `@supports`,
    // which is the only form that has both; `@supports` has no inline spelling.
    //
    // SO THE INLINE `overflow` MUST BE ABSENT, not merely different: an inline declaration wins over
    // the class, so re-adding one would silently undo the upgrade while this file still saw the
    // class it expects. Both halves are asserted.
    mountForm();
    const label = screen.getByTestId("concierge-agent-pill-name");
    expect(label.className).toContain("clip-no-scroll");
    expect(label.style.overflow).toBe("");
  });

  it("bounds the OUTER box without clipping it, so its baseline stays a text baseline", () => {
    // The trap: an inline-level box whose `overflow` is not `visible` takes its bottom margin edge
    // as its baseline, which would drop every pill in every concierge reply relative to the
    // sentence it sits in.
    //
    // THIS ASSERTION IS THE ONLY THING GUARDING IT. The real-browser probe was run with
    // `overflow: "hidden"` added to the pill's outer box and measured NO baseline shift — Chrome
    // takes an `inline-flex` container's baseline from its first flex item rather than from that
    // rule. So the hazard is latent (one `display` change away) rather than currently observable,
    // which is exactly the kind of thing a geometry test cannot hold and a declaration test can.
    mountForm();
    const pill = screen.getByTestId(testid);
    expect(pill.style.maxWidth).toBe("100%");
    expect(isZeroLength(pill.style.minWidth)).toBe(true);
    expect(pill.style.overflow).toBe("");
    expect(pill.style.verticalAlign).toBe("baseline");
  });

  it("keeps the sigil glued to the name it qualifies", () => {
    // Wrapping the name ALONE would let a truncated pill read as a lone "@" followed by a stub.
    mountForm();
    expect(screen.getByTestId("concierge-agent-pill-name").textContent).toBe(`@${LONG_NAME}`);
  });
});

describe("the class the clip is delegated to", () => {
  // ── A CLASS NAME IS ONLY AS GOOD AS THE RULE BEHIND IT, AND JSDOM NEVER LOADS THE STYLESHEET ──
  // Every assertion above reads `className`, which proves the pill ASKED for the clip and nothing
  // more. jsdom does not load `index.css` (see docs/jsdom-test-caveats.md), so `getComputedStyle`
  // would report an empty overflow whether the rule exists, was renamed, or was deleted as unused —
  // and it currently has no other consumer in the app, which is exactly the state in which someone
  // deletes it. That would leave every pill name with NO clip and no ellipsis, with this whole file
  // still green.
  //
  // So read the source. Not a substitute for the real-browser check — the probe asserts the
  // COMPUTED `overflow: clip` on a live element, which is the strong form — but this one runs in
  // the unit suite, where the deletion would actually be made.
  it("really is `hidden` upgraded to `clip`, in the stylesheet the app ships", () => {
    // Resolved from the CWD, not from `import.meta.url`: under vite-node a source module's
    // `import.meta.url` is not a `file:` URL, and `new URL(…)` throws "The URL must be of scheme
    // file" rather than reading anything. Both candidates are listed because the suite is run both
    // from the package (`pnpm vitest`) and from the repo root (`pnpm --filter`).
    const cssPath = ["src/index.css", "apps/desktop/src/index.css"]
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    expect(cssPath, "could not locate index.css from " + process.cwd()).toBeDefined();
    const css = readFileSync(cssPath!, "utf8");
    const rule = css.slice(css.indexOf(".clip-no-scroll"));
    expect(rule, "the .clip-no-scroll utility is gone from index.css").not.toBe("");
    // The floor every engine honours…
    expect(rule).toMatch(/\.clip-no-scroll\s*\{[^}]*overflow:\s*hidden/);
    // …and the upgrade, guarded so that a WebKit without `clip` keeps the floor rather than losing
    // the clip and the ellipsis together.
    expect(rule).toMatch(/@supports\s*\(overflow:\s*clip\)/);
    expect(rule).toMatch(/@supports[^{]*\{\s*\.clip-no-scroll\s*\{[^}]*overflow:\s*clip/);
  });
});

describe("truncation changes nothing else about the pill", () => {
  it("leaves the pill's own text exactly one sigil and the live name", () => {
    mount(wired());
    expect(screen.getByTestId("concierge-agent-pill").textContent).toBe(`@${LONG_NAME}`);
  });

  it("keeps the FULL name in the tooltip — where it survives the visible truncation", () => {
    // This is the whole safety net for the very-narrow case: the ellipsis is allowed to eat the
    // name on screen precisely because hovering still recovers it.
    mount(wired());
    expect(screen.getByTestId("concierge-agent-pill").getAttribute("title")).toBe(
      `Open ${LONG_NAME} in web`,
    );
  });

  it("keeps the identity attributes the column and the tests both key on", () => {
    mount(wired());
    const pill = screen.getByTestId("concierge-agent-pill");
    expect(pill.getAttribute("data-agent-id")).toBe("agent-7");
    expect(pill.getAttribute("data-band")).toBe("needs_you");
  });

  it("keeps the unresolved pill's disclosure wiring intact", () => {
    mount(wired({ agents: [], onSeeHistory: vi.fn() }));
    const pill = screen.getByTestId("concierge-agent-pill-closed");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(pill.getAttribute("aria-controls")).toBeTruthy();
    expect(pill.getAttribute("title")).toBe(`${LONG_NAME} is closed.`);
  });
});
