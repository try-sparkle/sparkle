// @vitest-environment jsdom
//
// The mention picker's contract. It is PURELY presentational — the caret never leaves the compose
// box, so it owns no selection state and handles no keys; ComposeBox.mentions.test.tsx covers the
// keyboard, and mentions.test.ts covers the ordering this component is handed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C } from "../../theme/colors";
import { MentionPicker, mentionOptionId } from "./MentionPicker";
import type { MentionAgent } from "./mentions";

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
  render(
    <MentionPicker
      agents={over.agents ?? [BLUEPRINT, KRAKEN]}
      selected={over.selected ?? 0}
      onSelect={onSelect}
      onHover={onHover}
    />,
  );
  return { onSelect, onHover };
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
    expect(screen.getByRole("listbox", { name: "Mention an agent" })).toBeTruthy();
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
