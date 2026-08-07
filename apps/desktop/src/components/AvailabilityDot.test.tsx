// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { AvailabilityDot, AVAILABILITY, availabilityLabel } from "./AvailabilityDot";
import { AGENT_STATUS } from "@sparkle/ui";
import type { Availability } from "../engine/social";

afterEach(cleanup);

const ALL: Availability[] = ["available", "away", "offline"];

const mark = (container: HTMLElement): HTMLElement =>
  container.querySelector("[data-availability]") as HTMLElement;

describe("AvailabilityDot — its own taxonomy, not the PTY one", () => {
  it("covers every Availability with a distinct colour", () => {
    const colors = ALL.map((a) => AVAILABILITY[a].color);
    expect(new Set(colors).size).toBe(ALL.length);
  });

  it("has a WORD for every state — the accessible channel colour cannot carry", () => {
    for (const a of ALL) expect(availabilityLabel(a)).toMatch(/\S/);
  });

  it("does NOT key off AGENT_STATUS: no availability is spelled like a PTY status", () => {
    // The mistake this component exists to prevent is mapping `available` onto the agent status
    // `working` to steal the green — which would make a human answer to the status-filter chips.
    // If these key spaces ever overlapped, a lookup could silently succeed against the wrong table.
    const ptyStatuses = Object.keys(AGENT_STATUS);
    for (const a of ALL) expect(ptyStatuses).not.toContain(a);
  });

  it("paints THAT availability's mapped colour — the map is what the component renders", () => {
    for (const a of ALL) {
      const { container } = render(<AvailabilityDot availability={a} />);
      // Equality, not merely "something was set": asserting non-empty would stay green if all three
      // entries shared one colour, if `offline` painted the success green, or if the component
      // ignored `meta.color` and hardcoded a constant — i.e. against every way the one behaviour
      // this component exists for can break. jsdom never loads the stylesheet, so a class-derived
      // paint reads empty (docs/jsdom-test-caveats.md); the colour is inline, which is the real
      // mechanism and is readable here.
      expect(mark(container).style.background).toBe(AVAILABILITY[a].color);
      expect(mark(container).getAttribute("data-availability")).toBe(a);
      cleanup();
    }
  });

  it("degrades to the OFFLINE mark for a value outside the union, instead of throwing in render", () => {
    // socialApi's JSON read is an unchecked `as T` and setPeople's `?? DEFAULT_AVAILABILITY` only
    // rescues null/undefined — a bogus string sorts fine and reaches here. An unguarded
    // `AVAILABILITY[x].color` would throw DURING RENDER, and an uncaught throw in render unmounts
    // the whole subtree: the chat column would disappear because one row had a typo'd status.
    const bogus = "busy" as unknown as Availability;
    const { container } = render(<AvailabilityDot availability={bogus} />);
    expect(mark(container).style.background).toBe(AVAILABILITY.offline.color);
    expect(mark(container).getAttribute("title")).toBe(AVAILABILITY.offline.label);
  });

  it("availabilityLabel degrades the same way rather than throwing", () => {
    expect(availabilityLabel("busy" as unknown as Availability)).toBe(AVAILABILITY.offline.label);
  });

  it("is a circle at the requested diameter", () => {
    const { container } = render(<AvailabilityDot availability="available" size={12} />);
    expect(mark(container).style.width).toBe("12px");
    expect(mark(container).style.height).toBe("12px");
    expect(mark(container).style.borderRadius).toBe("50%");
  });

  it("titles itself with the label by default, and defers to an override", () => {
    const { container } = render(<AvailabilityDot availability="away" />);
    expect(mark(container).getAttribute("title")).toBe(AVAILABILITY.away.label);
    cleanup();
    const second = render(<AvailabilityDot availability="away" title="Ada — Away" />);
    expect(mark(second.container).getAttribute("title")).toBe("Ada — Away");
  });

  it("is aria-hidden, and therefore contributes NOTHING to the accessible tree on its own", () => {
    const { container } = render(<AvailabilityDot availability="available" />);
    expect(mark(container).getAttribute("aria-hidden")).toBe("true");
    // The composing surface owns the name; a bare dot must not be a queryable image.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws the ring ONLY when given a colour, and never as a border", () => {
    const { container } = render(<AvailabilityDot availability="available" />);
    expect(mark(container).style.boxShadow).toBe("");
    cleanup();
    const ringed = render(<AvailabilityDot availability="available" ringColor="#abcdef" ringWidth={3} />);
    expect(mark(ringed.container).style.boxShadow).toBe("0 0 0 3px #abcdef");
    expect(mark(ringed.container).style.border).toBe("");
  });

  it("does not animate — no pulse class, for the reason StatusDot dropped its own", () => {
    const { container } = render(<AvailabilityDot availability="available" />);
    expect(mark(container).className).not.toContain("sparkle-pulse");
  });
});