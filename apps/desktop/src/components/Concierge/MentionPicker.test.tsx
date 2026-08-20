// @vitest-environment jsdom
//
// The mention picker's contract. It is PURELY presentational — the caret never leaves the compose
// box, so it owns no selection state and handles no keys; ComposeBox.mentions.test.tsx covers the
// keyboard, and mentions.test.ts covers the ordering this component is handed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C } from "../../theme/colors";
import { MentionPicker, ROW_H, ROW_H_TWO_LINE, mentionOptionId } from "./MentionPicker";
import { beadMentionId, type MentionAgent } from "./mentions";

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

function setup(over: { agents?: MentionAgent[]; selected?: number } = {}) {
  const onSelect = vi.fn();
  const onHover = vi.fn();
  // `rerender` is returned so a test can change the PROPS without remounting — the scroll rows
  // below need exactly that, since a remount would re-run the effect for a trivial reason and
  // could not distinguish "the list changed" from "the component is new".
  const { rerender } = render(
    <MentionPicker
      agents={over.agents ?? [BLUEPRINT, KRAKEN]}
      selected={over.selected ?? 0}
      onSelect={onSelect}
      onHover={onHover}
    />,
  );
  return { onSelect, onHover, rerender };
}

const options = () => screen.queryAllByTestId("concierge-mention-option");

describe("MentionPicker — the list", () => {
  it("renders one row per agent, sigil included, in the order it was handed", () => {
    setup();
    expect(options()).toHaveLength(2);
    expect(options()[0]!.textContent).toContain("@Blueprint UI/UX");
    expect(options()[1]!.textContent).toContain("@Kraken Auth");
  });

  // An empty panel over a composer is a dead end the user has to dismiss; typing on is the better
  // exit, so the caller closes rather than showing "no matches".
  it("renders NOTHING at all when there is nothing to offer", () => {
    setup({ agents: [] });
    expect(screen.queryByTestId("concierge-mention-picker")).toBeNull();
  });

  it("is a listbox of options, so the composer can point aria-activedescendant at a row", () => {
    setup();
    // The label names BOTH kinds: the list has offered beads since sparkle-1cpomd, and this string
    // is the only description of the overlay a screen-reader user gets.
    expect(screen.getByRole("listbox", { name: "Mention an agent or a bead" })).toBeTruthy();
    expect(options()[0]!.id).toBe(mentionOptionId("a1"));
  });
});

describe("MentionPicker — selection", () => {
  it("marks the selected row and only that row", () => {
    setup({ selected: 1 });
    expect(options()[0]!.getAttribute("aria-selected")).toBe("false");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  // The gold rail is the same signal the command palette uses for its selected row. It must be the
  // THEMED token: the literal gold has no visible edge on the light palette's panel.
  it("paints the selected row with the themed concierge gold rail", () => {
    setup({ selected: 0 });
    expect((options()[0] as HTMLElement).style.borderLeft).toContain(C.goldFill);
    expect((options()[1] as HTMLElement).style.borderLeft).toContain("transparent");
  });

  it("reports a hover so the composer can move its selection to the pointer", () => {
    const { onHover } = setup();
    fireEvent.mouseEnter(options()[1]!);
    expect(onHover).toHaveBeenCalledWith(1);
  });
});

describe("MentionPicker — choosing", () => {
  // THE CARET GUARD. A click blurs the textarea before it lands, and a blurred textarea has no
  // selectionStart to insert at — so the pick would go in at offset 0, or nowhere. Choosing has to
  // happen on mousedown WITH the default prevented, which is what keeps the caret where it was.
  it("chooses on mousedown and prevents the default so the caret survives", () => {
    const { onSelect } = setup();
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(options()[1]!, ev);
    expect(onSelect).toHaveBeenCalledWith(KRAKEN);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does NOT choose an agent that cannot take a message", () => {
    const cloud = agent({ id: "c", name: "Cloud Runner", canAcceptInput: false });
    const { onSelect } = setup({ agents: [cloud] });
    fireEvent.mouseDown(options()[0]!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("MentionPicker — what a row says about itself", () => {
  // "No such agent" and "that one is a cloud agent" are different answers. Hiding the row would
  // collapse them into one, so the row stays and states its reason.
  it("shows an undeliverable agent, disabled, with a reason", () => {
    const cloud = agent({ id: "c", name: "Cloud Runner", canAcceptInput: false });
    setup({ agents: [cloud] });
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(options()[0]!.textContent).toContain("Can't take a message");
  });

  // The project no longer rides on a SECOND LINE when two rows share a name — it rides in the
  // ADDRESS itself (mentions.withMentionLabels), so the distinction travels with the message
  // instead of living only in a picker row the user has already dismissed.
  it("shows the disambiguated address for same-named agents", () => {
    setup({
      agents: [
        agent({ id: "d1", name: "Docs", projectName: "web", label: "Docs (web)" }),
        agent({ id: "d2", name: "Docs", projectName: "mobile", label: "Docs (mobile)" }),
      ],
    });
    expect(options()[0]!.textContent).toContain("@Docs (web)");
    expect(options()[1]!.textContent).toContain("@Docs (mobile)");
  });

  it("spends no second line on a row that has nothing extra to say", () => {
    setup({ agents: [BLUEPRINT, KRAKEN] });
    expect(screen.queryByText("web")).toBeNull();
  });

  // The founder bans emoji as icons across sparkle.ai — this column uses react-icons/fi.
  it("carries no emoji: every icon is an inline Feather svg", () => {
    setup({ agents: [agent({ id: "c", name: "Cloud Runner", canAcceptInput: false })] });
    const panel = screen.getByTestId("concierge-mention-picker");
    expect(panel.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(panel.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

// ══ BEAD ROWS ═══════════════════════════════════════════════════════════════════════════════════
//
// A bead is offered by the same list as an agent, and three things about an agent row are FALSE on
// one: the "send this to it" tooltip, the status dot, and the disabled "can't take a message" line.
// A bead carries `canAcceptInput: false` honestly — a unit of work cannot receive a prompt — so a
// picker that read deliverability as choosability would grey the row out and refuse the click, i.e.
// ship the founder's feature visibly inert.
//
// ══ EVERY ASSERTION HERE MOUNTS BOTH KINDS AT ONCE ══════════════════════════════════════════════
// Deliberate, and it is the repo's rule for a rule that picks one of N targets: absence in a
// component that was never rendered proves nothing. A bead row missing "Send this message to" is
// only evidence if an AGENT row in the same list still has it — otherwise the same PASS is produced
// by a picker that dropped the copy for everyone, which is a different and worse bug.
const BEAD = agent({
  id: beadMentionId("sparkle-1cpomd"),
  name: "Chat about a bead from its card",
  projectId: "",
  projectName: "",
  band: "done",
  canAcceptInput: false,
  kind: "bead",
});

/** The agent row and the bead row, in that order, from a list holding both. */
function bothKinds() {
  setup({ agents: [KRAKEN, BEAD] });
  const rows = options();
  return { agentRow: rows[0] as HTMLElement, beadRow: rows[1] as HTMLElement };
}

describe("MentionPicker — a bead is not an agent", () => {
  it("offers a bead REFERENTIALLY while the agent beside it keeps the send copy", () => {
    const { agentRow, beadRow } = bothKinds();
    // The agent still reads as a destination…
    expect(agentRow.getAttribute("title")).toBe("Send this message to Kraken Auth");
    // …and the bead does not, in either direction: it is not a destination and it is not a refusal.
    expect(beadRow.getAttribute("title")).toBe("Reference Chat about a bead from its card");
    expect(beadRow.getAttribute("title")).not.toContain("Send this message to");
  });

  // The whole point of the row. `canAcceptInput: false` used to mean "unchoosable", so every bead
  // was listed and then silently dropped by both the mouse and Enter.
  it("CHOOSES a bead on mousedown, though it can never take a message", () => {
    const onSelect = vi.fn();
    render(<MentionPicker agents={[BEAD]} selected={0} onSelect={onSelect} onHover={vi.fn()} />);
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(options()[0]!, ev);
    expect(onSelect).toHaveBeenCalledWith(BEAD);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does NOT mark a bead disabled, while an undeliverable AGENT still is", () => {
    const cloud = agent({ id: "c", name: "Cloud Runner", canAcceptInput: false });
    setup({ agents: [cloud, BEAD] });
    const rows = options();
    expect(rows[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(rows[0]!.textContent).toContain("Can't take a message");
    // Same `canAcceptInput: false`, opposite rendering — which is the only way to tell that the
    // component branched on what the row IS rather than on what it can receive.
    expect(rows[1]!.getAttribute("aria-disabled")).toBeNull();
    expect(rows[1]!.textContent).not.toContain("Can't take a message");
  });

  it("says the bead's ID on its second line, and says it only for the bead", () => {
    const { agentRow, beadRow } = bothKinds();
    expect(beadRow.textContent).toContain("@Chat about a bead from its card");
    expect(beadRow.textContent).toContain("sparkle-1cpomd");
    // The agent row spends no second line at all — the id line is bead-shaped, not a new row
    // decoration every candidate grew.
    expect(agentRow.querySelector('[data-testid="concierge-mention-bead-id"]')).toBeNull();
    expect(beadRow.querySelector('[data-testid="concierge-mention-bead-id"]')).toBeTruthy();
  });

  // `bandColor` is a claim about a running process. A bead has none, so painting it `done`-coloured
  // would say "this agent finished" about something that was never an agent.
  it("gives the bead a glyph instead of the agent's status dot", () => {
    const { agentRow, beadRow } = bothKinds();
    const dotOf = (row: HTMLElement) =>
      Array.from(row.querySelectorAll("span")).find(
        (el) => el.style.borderRadius === "50%" && el.style.width === "6px",
      );
    expect(dotOf(agentRow)).toBeTruthy();
    expect(dotOf(beadRow)).toBeUndefined();
    // …and it is a Feather svg, not a character or an emoji (this column's standing rule).
    expect(beadRow.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(beadRow.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // The routing/rendering split: bead-ness for DRAWING comes off `kind`, and the id namespace is
  // what keeps a bead's option id from ever colliding with an agent uuid.
  it("keys a bead row by its namespaced id, so it cannot collide with an agent's", () => {
    const { beadRow } = bothKinds();
    expect(beadRow.id).toBe(mentionOptionId("bead:sparkle-1cpomd"));
    expect(beadRow.getAttribute("data-agent-id")).toBe("bead:sparkle-1cpomd");
  });
});

// ══ THE HIGHLIGHTED ROW IS SCROLLED INTO VIEW (roborev 65710) ═══════════════════════════════════
//
// The list clips at LIST_MAX_H with `overflowY: "auto"`, so ↑/↓ past the visible window used to
// advance the selection and `aria-activedescendant` while the panel kept showing the same rows.
//
// WHY THIS NEEDS A TEST RATHER THAN A CAREFUL READING: the call site is
// `selectedRowRef.current?.scrollIntoView?.({...})` — DOUBLY optional, because jsdom defines no
// layout and no `scrollIntoView` at all. That guard is load-bearing for the suite and is also a
// perfect hiding place: a ref attached to the wrong element, an effect whose deps never fire, or an
// out-of-range index all fail silently and look exactly like success. Installing the method turns
// the `?.` back into a jsdom accommodation instead of a hole.
describe("the highlighted row is kept on screen", () => {
  const FLEET = Array.from({ length: 30 }, (_, i) => agent({ id: `ag${i}`, name: `Agent ${i}` }));
  let spy: ReturnType<typeof vi.fn>;
  let original: unknown;

  beforeAll(() => {
    original = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });
  afterAll(() => {
    (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = original;
  });

  beforeEach(() => {
    spy = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
  });

  // THE ASSERTION THAT HAS POWER is which ELEMENT was scrolled, not that something was. A ref on
  // the wrong row still calls the method.
  it("scrolls the SELECTED row, not merely some row", () => {
    setup({ agents: FLEET, selected: 20 });
    expect(spy).toHaveBeenCalled();
    const scrolled = spy.mock.instances[spy.mock.instances.length - 1] as HTMLElement;
    expect(scrolled.getAttribute("aria-selected")).toBe("true");
    expect(scrolled.getAttribute("data-agent-id")).toBe("ag20");
  });

  it("asks for the nearest edge, so an already-visible row does not jump the list", () => {
    setup({ agents: FLEET, selected: 5 });
    expect(spy).toHaveBeenCalledWith({ block: "nearest" });
  });

  // ══ THE ROW SET IS A DEPENDENCY, NOT JUST THE INDEX ═════════════════════════════════════════
  // `scrollTop` survives a re-render but the row AT an index does not. Wheel-scroll a long list,
  // type another character, and ComposeBox calls setSelected(0) when `selected` is ALREADY 0 — no
  // state change, so an effect keyed on the index alone never runs and the container stays parked
  // far from the highlight. Re-rendering with a DIFFERENT list at the SAME index must re-seat it.
  it("re-seats the highlight when the list changes underneath an unmoved index", () => {
    const { rerender } = setup({ agents: FLEET, selected: 0 });
    spy.mockClear();
    rerender(
      <MentionPicker
        agents={FLEET.slice(3)}
        selected={0}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    expect(spy).toHaveBeenCalled();
    const scrolled = spy.mock.instances[spy.mock.instances.length - 1] as HTMLElement;
    expect(scrolled.getAttribute("data-agent-id")).toBe("ag3");
  });
});

// ══ THE ROW HEIGHTS ARE APPLIED, NOT MERELY DECLARED (roborev 65738) ═══════════════════════════
//
// mentions.test.ts asserts a PIXEL budget out of ROW_H and ROW_H_TWO_LINE. Those assertions are
// arithmetic between two exported numbers: they hold whether or not the layout obeys them. Delete
// the `height` this component sets and every one of them stays green while the constants go back to
// describing nothing — which is the exact failure the pixel budget replaced, one level up.
//
// So the construction itself needs a test, and it needs ALL THREE kinds mounted AT ONCE: a row's
// height is chosen by a predicate over the row, and asserting one kind in isolation cannot catch a
// predicate keyed to the wrong side.
describe("row heights are what the pixel budget claims", () => {
  const CHOOSABLE = agent({ id: "ok1", name: "Kraken Auth" });
  const CANNOT = agent({ id: "no1", name: "Cloud Runner", canAcceptInput: false });
  const BEAD = agent({
    id: beadMentionId("sparkle-1cpomd"),
    name: "Chat button on every bead card",
    kind: "bead",
    canAcceptInput: false,
  });

  const heightOf = (agentId: string) => {
    const row = options().find((o) => o.getAttribute("data-agent-id") === agentId);
    return (row as HTMLElement).style.height;
  };

  it("gives a one-line row ROW_H and every second-line row ROW_H_TWO_LINE", () => {
    setup({ agents: [CHOOSABLE, CANNOT, BEAD] });
    // The choosable agent draws no second line.
    expect(heightOf("ok1")).toBe(`${ROW_H}px`);
    // The agent that cannot take input draws its reason…
    expect(heightOf("no1")).toBe(`${ROW_H_TWO_LINE}px`);
    // …and the bead draws its id. A bead is CHOOSABLE despite canAcceptInput:false, so this also
    // pins that the height keys on the second line rather than on deliverability.
    expect(heightOf(BEAD.id)).toBe(`${ROW_H_TWO_LINE}px`);
  });

  // The height and the two conditional second lines read ONE value. If they ever diverge, a row
  // keeps the one-line height while rendering two lines and `overflow: hidden` clips it silently.
  it("marks exactly the rows that draw a second line, and says which one", () => {
    setup({ agents: [CHOOSABLE, CANNOT, BEAD] });
    const marker = (id: string) =>
      options().find((o) => o.getAttribute("data-agent-id") === id)!.getAttribute("data-two-line");
    expect(marker("ok1")).toBeNull();
    expect(marker("no1")).toBe("reason");
    expect(marker(BEAD.id)).toBe("bead");
  });
});
