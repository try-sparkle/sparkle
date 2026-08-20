// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrPill } from "./PrPill";
import { pillStyle } from "./pillStyle";
import { C } from "../../theme/colors";
import { __clearRepoSlugCache, __setRepoSlugForTest } from "../../services/conciergeTools/repoSlug";
import { useProjectStore } from "../../stores/projectStore";

const launch = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../services/sparkleApi", () => ({ launch }));

const ROOT = "/Users/x/Projects/sparkle";

function selectProject(rootPath: string | null) {
  if (rootPath === null) {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    return;
  }
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", rootPath, agents: [] }] as never,
    selectedProjectId: "p1",
  });
}

beforeEach(() => {
  launch.mockClear();
  __clearRepoSlugCache();
  selectProject(ROOT);
});
afterEach(cleanup);

describe("PrPill — a QUALIFIED reference (the app knew the repo)", () => {
  it("renders the number as a chiclet and opens THAT repo, ignoring the selected project", () => {
    // The selected project resolves to a DIFFERENT repo. A qualified reference must not consult it:
    // the app wrote the repo it actually merged, and inferring one would be a chance to be wrong.
    __setRepoSlugForTest(ROOT, "someone/else");
    render(<PrPill number={2164} slug="drodio/sparkle" />);

    const pill = screen.getByTestId("concierge-pr-pill");
    expect(pill.textContent).toBe("#2164");

    fireEvent.click(pill);
    expect(launch).toHaveBeenCalledWith("https://github.com/drodio/sparkle/pull/2164");
  });

  it("names the destination before it is opened", () => {
    render(<PrPill number={2164} slug="drodio/sparkle" />);
    expect(screen.getByTestId("concierge-pr-pill").getAttribute("title")).toBe(
      "drodio/sparkle#2164 — open on GitHub",
    );
  });
});

describe("PrPill — an UNQUALIFIED reference (recovered from prose)", () => {
  it("resolves the repo from the SELECTED project and opens it", () => {
    __setRepoSlugForTest(ROOT, "drodio/sparkle");
    render(<PrPill number={2100} slug={null} />);

    fireEvent.click(screen.getByTestId("concierge-pr-pill"));
    expect(launch).toHaveBeenCalledWith("https://github.com/drodio/sparkle/pull/2100");
  });

  it("FOLLOWS the reader to another project rather than holding a snapshot", () => {
    // Rule 1 — re-read live state on every render. A pill that captured the slug at mount would keep
    // opening the old repo after the reader switched projects, and nothing on screen would say so.
    __setRepoSlugForTest(ROOT, "drodio/sparkle");
    __setRepoSlugForTest("/other/repo", "acme/widgets");
    const { rerender } = render(<PrPill number={5} slug={null} />);
    expect(screen.getByTestId("concierge-pr-pill").getAttribute("data-pr-slug")).toBe(
      "drodio/sparkle",
    );

    selectProject("/other/repo");
    rerender(<PrPill number={5} slug={null} />);
    expect(screen.getByTestId("concierge-pr-pill").getAttribute("data-pr-slug")).toBe(
      "acme/widgets",
    );
  });
});

describe("PrPill — nothing to open", () => {
  // Rule 2, and the rule `AgentPill.deadEnd.test.tsx` exists to enforce: a reference that cannot do
  // anything is PROSE. Asserting the button's ABSENCE is only meaningful because the cases above
  // prove the same component DOES render one when the repo resolves.

  it("is plain text when the project has no GitHub remote", () => {
    __setRepoSlugForTest(ROOT, null); // resolved, and the answer is "not a GitHub repo"
    render(<PrPill number={2164} slug={null} />);
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toBe("#2164");
  });

  it("is plain text when no project is selected at all", () => {
    selectProject(null);
    render(<PrPill number={2164} slug={null} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toBe("#2164");
  });

  it("recovers when the slug cache fills after the first paint", () => {
    vi.useFakeTimers();
    try {
      render(<PrPill number={2164} slug={null} />);
      // Cold cache: prose, because there is nothing to open YET.
      expect(screen.queryByRole("button")).toBeNull();

      __setRepoSlugForTest(ROOT, "drodio/sparkle");
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(screen.getByTestId("concierge-pr-pill").getAttribute("data-pr-slug")).toBe(
        "drodio/sparkle",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PrPill — the box", () => {
  // The founder asked for this styled "exactly like the PR chiclet in the concierge column header".
  // `pillStyle` IS that chiclet's box — `OpenPrMenu` spreads the same helper — so comparing against
  // the helper is comparing against the header. This is NOT vacuous: it reads the rendered DOM, so a
  // PrPill that re-typed its own geometry (or reverted to a capsule) fails it.
  it("takes the shared chiclet box rather than re-typing the geometry", () => {
    // DOM to DOM. A PROBE element is given `pillStyle(C.violet)` directly and both sides are read
    // back through the same engine, so jsdom's own normalisation ("0 6px" -> "0px 6px") cannot make
    // an identical box look different — and a PrPill that re-typed its geometry still fails.
    render(
      <>
        <span data-testid="probe" style={pillStyle(C.violet)} />
        <PrPill number={2164} slug="drodio/sparkle" />
      </>,
    );
    const probe = screen.getByTestId("probe");
    const el = screen.getByTestId("concierge-pr-pill");

    for (const prop of [
      "height",
      "padding",
      "borderRadius",
      "borderWidth",
      "borderStyle",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "display",
    ] as const) {
      expect(el.style[prop], prop).toBe(probe.style[prop]);
    }
    // …and the box is not empty, so the loop above cannot pass by comparing nothing to nothing.
    expect(probe.style.height).not.toBe("");
  });

  it("overrides the INK only — colour says state, geometry does not", () => {
    render(<PrPill number={2164} slug="drodio/sparkle" />);
    expect(screen.getByTestId("concierge-pr-pill").style.color).toBe(C.violetInk);
  });
});
