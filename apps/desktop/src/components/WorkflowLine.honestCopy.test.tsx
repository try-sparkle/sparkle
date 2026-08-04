// @vitest-environment jsdom
//
// The EXPANDED card's stage copy (roborev 57877).
//
// `StageChip` renders only in the sidebar's COLLAPSED arm. On the expanded hover card — the row the
// user has actually stopped on — `WorkflowLine` is the SOLE stage copy, and it called `stageMeta`
// directly, printing "Building locally: unsaved changes — closing now loses this work." verbatim,
// in larger text, underneath a header saying "nothing here is at risk". Fixing the chip left that
// untouched: same lie, third location, different code path.
//
// Tested at the component rather than through AgentSidebar because the card is a hover-triggered
// portal — driving it would test the hover plumbing, not the copy rule. This asserts the rendered
// side effect directly, and the mutation check (make the component ignore `section`) turns it red.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLine } from "./WorkflowLine";

afterEach(() => cleanup());

describe("WorkflowLine — copy may not contradict the rung the row was filed under", () => {
  it("does NOT claim work will be lost for a `local_none` row", () => {
    render(<WorkflowLine stage="building_unsaved" expanded section="local_none" />);
    expect(document.body.textContent).not.toMatch(/loses this work/);
    expect(document.body.textContent).toMatch(/nothing here is at risk/);
    // The accessible name is stage copy too, and it read "Building Locally (Unsaved)".
    expect(screen.queryByLabelText(/Building Locally \(Unsaved\)/)).toBeNull();
    expect(screen.getByLabelText(/Nothing Built Yet/)).toBeTruthy();
  });

  it("STILL says it for a row genuinely holding unsaved edits", () => {
    // The control. Without it, blanking the copy for every `building_unsaved` row would pass above
    // while destroying the warning that row actually needs.
    render(<WorkflowLine stage="building_unsaved" expanded section="local_uncommitted" />);
    expect(document.body.textContent).toMatch(/loses this work/);
    expect(screen.getByLabelText(/Building Locally \(Unsaved\)/)).toBeTruthy();
  });

  it("says it when the section is UNKNOWN — absence of evidence changes nothing", () => {
    // A caller that does not pass the section (or a row whose worktree was never read) must keep the
    // cautious copy, matching `sectionOfRow`'s own `undefined` arm.
    render(<WorkflowLine stage="building_unsaved" expanded />);
    expect(document.body.textContent).toMatch(/loses this work/);
  });

  it("leaves every other stage's copy alone under the same rung", () => {
    // `local_none` also holds the planning stages. Their copy describes planning that genuinely
    // happened and says nothing about the worktree, so overriding it would erase real information.
    render(<WorkflowLine stage="planned" expanded section="local_none" />);
    expect(document.body.textContent).toMatch(/tracked task on the Plan board/);
  });
});
