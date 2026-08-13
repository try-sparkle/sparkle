// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BeadPriorityChip } from "./BeadPriorityChip";

afterEach(cleanup);

// The chip is a READOUT for a card face — these pin the two facts the founder asked for: it shows
// the bead's OWN level, and the urgent band (P0/P1) is visually distinct from the rest ("P0 red,
// descending"). Assertions are on the rendered OUTPUT, not on the props handed in.
describe("BeadPriorityChip", () => {
  it("renders the level it was given", () => {
    render(<BeadPriorityChip priority={0} />);
    const chip = screen.getByTestId("bead-priority-chip");
    expect(chip.getAttribute("data-priority")).toBe("0");
    expect(chip.textContent).toContain("P0");
  });

  it("shows P? for an unset priority rather than rendering nothing", () => {
    render(<BeadPriorityChip priority={undefined} />);
    const chip = screen.getByTestId("bead-priority-chip");
    expect(chip.getAttribute("data-priority")).toBe("");
    expect(chip.textContent).toContain("P?");
  });

  it("paints the URGENT band (P0/P1) differently from a low priority — the 'red descending' cue", () => {
    // Two chips, and the SIDE EFFECT is that their dot colours differ: an urgent bead is marked, a
    // low one is not. Comparing the two (rather than pinning a hex jsdom would normalise) keeps the
    // test about the banding, so flattening every level to one colour fails it.
    const { container: urgentC } = render(<BeadPriorityChip priority={0} testId="chip-urgent" />);
    const urgentDot = within(urgentC).getByTestId("chip-urgent").querySelector("span[aria-hidden]");
    const urgentColor = (urgentDot as HTMLElement).style.background;

    const { container: calmC } = render(<BeadPriorityChip priority={3} testId="chip-calm" />);
    const calmDot = within(calmC).getByTestId("chip-calm").querySelector("span[aria-hidden]");
    const calmColor = (calmDot as HTMLElement).style.background;

    expect(urgentColor).not.toBe("");
    expect(urgentColor).not.toBe(calmColor);
  });

  it("treats P1 as urgent and P2 as not — the band boundary the app already uses", () => {
    const { container: p1C } = render(<BeadPriorityChip priority={1} testId="chip-p1" />);
    const p1Color = (
      within(p1C).getByTestId("chip-p1").querySelector("span[aria-hidden]") as HTMLElement
    ).style.background;
    const { container: p2C } = render(<BeadPriorityChip priority={2} testId="chip-p2" />);
    const p2Color = (
      within(p2C).getByTestId("chip-p2").querySelector("span[aria-hidden]") as HTMLElement
    ).style.background;
    expect(p1Color).not.toBe(p2Color);
  });
});
