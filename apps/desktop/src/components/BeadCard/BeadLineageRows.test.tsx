// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BeadLineageRows } from "./BeadLineageRows";

afterEach(cleanup);

const T = "card";
const task = (id: string, label: string) => ({ id, label });
const agent = (id: string, label: string) => ({ id, label, projectId: "proj-1" });

// WHAT THESE COVER, AND WHAT THEY DELIBERATELY DO NOT. jsdom never lays out, so "as many pills as
// fit, then +N more" is unobservable here — every width reads 0 and the packer correctly concludes
// everything fits. That rule is a pure function and is tested against exact numbers in
// `engine/beadLineage.test.ts`. These pin what jsdom CAN see: which rows exist, what they read, and
// what a click does.
describe("BeadLineageRows", () => {
  it("labels the children row 'Tasks:' and names each child", () => {
    render(
      <BeadLineageRows
        testId={T}
        tasks={[task("b-1", "Sort-by control"), task("b-2", "Priority chiclet")]}
        buildAgents={[]}
      />,
    );
    const row = screen.getByTestId("card-tasks");
    expect(row.textContent).toContain("Tasks:");
    expect(row.textContent).toContain("Sort-by control");
    expect(row.textContent).toContain("Priority chiclet");
  });

  it("shows EVERY pill when the row could not be measured, rather than hiding them behind '+N more'", () => {
    // jsdom lays nothing out, so this is the unmeasured path on every render here — and it is a
    // real production path too (a display:none ancestor, a pre-layout frame). A width of 0 means
    // "no reading", not "no space"; packing against it would clip the row to one pill and withhold
    // the names the row exists to show, while looking perfectly plausible.
    const many = Array.from({ length: 8 }, (_, i) => task(`b-${i}`, `Task number ${i}`));
    render(<BeadLineageRows testId={T} tasks={many} buildAgents={[]} />);
    expect(screen.getAllByTestId("card-tasks-pill")).toHaveLength(8);
    expect(screen.queryByTestId("card-tasks-more")).toBeNull();
  });

  it("calls the row 'Build agents:' — his word, for parity with the Build column", () => {
    render(<BeadLineageRows testId={T} tasks={[]} buildAgents={[agent("a-1", "Bead Card")]} />);
    const row = screen.getByTestId("card-build-agents");
    expect(row.textContent).toContain("Build agents:");
    // "builders" was the alternative he considered and explicitly rejected.
    expect(row.textContent).not.toContain("builders");
    expect(row.textContent).not.toContain("Builders");
  });

  it("omits a row ENTIRELY when it is empty — never a bare label with nothing after it", () => {
    render(<BeadLineageRows testId={T} tasks={[task("b-1", "Only task")]} buildAgents={[]} />);
    expect(screen.getByTestId("card-tasks")).toBeTruthy();
    // The row's absence is the whole point: a leaf card must cost no extra height.
    expect(screen.queryByTestId("card-build-agents")).toBeNull();
    expect(document.body.textContent).not.toContain("Build agents:");
  });

  it("renders nothing at all when the bead has neither children nor agents", () => {
    const { container } = render(<BeadLineageRows testId={T} tasks={[]} buildAgents={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("card-lineage")).toBeNull();
  });

  it("a task pill jumps to that bead, and does NOT also toggle the card", () => {
    const onOpenBead = vi.fn();
    const onCardClick = vi.fn();
    render(
      <span onClick={onCardClick}>
        <BeadLineageRows
          testId={T}
          tasks={[task("b-7", "Sort-by control")]}
          buildAgents={[]}
          onOpenBead={onOpenBead}
        />
      </span>,
    );
    fireEvent.click(screen.getByTestId("card-tasks-pill"));
    expect(onOpenBead).toHaveBeenCalledWith("b-7");
    // The SIDE EFFECT that matters: the card body never saw the click. Without stopPropagation the
    // same gesture opens the task and collapses the card you opened it from.
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("a build-agent pill is a REAL link — it reveals that agent, addressed by project", () => {
    const onOpenAgent = vi.fn();
    render(
      <BeadLineageRows
        testId={T}
        tasks={[]}
        buildAgents={[agent("ag-3", "Bead Card Expand")]}
        onOpenAgent={onOpenAgent}
      />,
    );
    fireEvent.click(screen.getByTestId("card-build-agents-pill"));
    expect(onOpenAgent).toHaveBeenCalledWith({ agentId: "ag-3", projectId: "proj-1" });
  });

  it("lets a LONE oversized pill give ground, so it ellipsises instead of being cut off", () => {
    // THE CASE THE OVERFLOW GUARD COULD NOT SEE (VADE, PR #2436). With exactly one pill there is
    // nothing to overflow INTO, so `packPills` returns `overflow: 0` and a guard reading
    // `shown === 1 && overflow > 0` never fired. The pill stayed unshrinkable, the row's
    // `overflow: hidden` cut it mid-character, and nothing said anything had been cut — no
    // ellipsis, no "+N more". jsdom cannot lay out, so what is asserted is the style fact that
    // decides it.
    render(
      <BeadLineageRows
        testId={T}
        tasks={[task("b-1", "A single task whose title is far wider than the row could ever be")]}
        buildAgents={[]}
      />,
    );
    const pill = screen.getByTestId("card-tasks-pill");
    expect(pill.style.flex).toBe("0 1 auto");
    // …and it must NOT grow: `1 1 auto` would stretch a short sole pill across the whole row.
    expect(pill.style.flex).not.toBe("1 1 auto");
    // The rules that turn "may shrink" into a readable truncation rather than a hard cut.
    expect(pill.style.overflow).toBe("hidden");
    expect(pill.style.textOverflow).toBe("ellipsis");
    expect(pill.style.whiteSpace).toBe("nowrap");
  });

  it("does not let a pill shrink when it has SIBLINGS — their widths must stay natural", () => {
    // The paired case, and the reason the rule is scoped to a SOLE pill: `packPills` reasons about
    // natural widths, so a row of several pills that could squeeze would hand it numbers describing
    // a layout that only exists while it is measuring.
    render(
      <BeadLineageRows
        testId={T}
        tasks={[task("b-1", "First"), task("b-2", "Second")]}
        buildAgents={[]}
      />,
    );
    for (const pill of screen.getAllByTestId("card-tasks-pill")) {
      expect(pill.style.flex).toBe("0 0 auto");
    }
  });

  it("renders pills as STATIC text when the surface wired no jump", () => {
    render(<BeadLineageRows testId={T} tasks={[task("b-1", "Task")]} buildAgents={[]} />);
    const pill = screen.getByTestId("card-tasks-pill");
    // A control that cannot act must not advertise itself as one.
    expect(pill.getAttribute("role")).toBeNull();
    expect(pill.getAttribute("tabindex")).toBeNull();
  });

  it("keeps the row to ONE line — it may never wrap", () => {
    render(<BeadLineageRows testId={T} tasks={[task("b-1", "Task")]} buildAgents={[]} />);
    expect(screen.getByTestId("card-tasks").style.flexWrap).toBe("nowrap");
  });

  it("draws both rows, tasks first, when the card has children AND live agents", () => {
    render(
      <BeadLineageRows
        testId={T}
        tasks={[task("b-1", "A task")]}
        buildAgents={[agent("ag-1", "An agent")]}
      />,
    );
    const lineage = screen.getByTestId("card-lineage");
    const rows = [...lineage.children].map((c) => c.getAttribute("data-testid"));
    expect(rows).toEqual(["card-tasks", "card-build-agents"]);
  });

  it("uses phrasing content only — a <div> here is invalid inside the concierge's <p>", () => {
    const { container } = render(
      <BeadLineageRows
        testId={T}
        tasks={[task("b-1", "A task")]}
        buildAgents={[agent("ag-1", "An agent")]}
        onOpenBead={() => {}}
        onOpenAgent={() => {}}
        onExpand={() => {}}
      />,
    );
    // A <div> or <button> would be reparented OUT of the sentence by the HTML parser when the
    // concierge chrome mounts this inside <Markdown>'s <p>. The card is spans end to end.
    expect(container.querySelectorAll("div").length).toBe(0);
    expect(container.querySelectorAll("button").length).toBe(0);
  });
});
