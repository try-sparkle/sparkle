// @vitest-environment jsdom
//
// The project-tab staleness badge (bead sparkle-cuv2h).
//
// WHAT THIS GUARDS. A checkout at a canonical-looking path is the one most likely to be READ and
// least likely to be PULLED — the founder's sat 1,694 commits behind on a six-day-old `main` while
// every agent worktree was current, and answers drawn from it were reported as current code. The
// badge is the visible half of the fix, so the assertions below are about what a person can
// actually SEE and a screen reader can actually HEAR: the count, the base it is behind, and the
// instruction to read from that base instead.
//
// The fail-closed property is the one worth stating twice: a project we could not MEASURE and a
// project that is FRESH are both simply absent from `stalenessByProject`. There is no third
// rendering, so an `unknown` reading from `repo_freshness` can never surface as a reassuring badge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StatusBand } from "../engine/buildSections";
import type { StaleDiagnosis } from "../services/staleness";

const diagnoseStale = vi.fn<(root: string) => Promise<StaleDiagnosis>>();
const remedyStale = vi.fn();

// The badge's panel diagnoses on open, so the service is stubbed here — this file is about the
// BADGE (its tooltip, its click, its keyboard), not about what the panel does with the answer.
vi.mock("../services/staleness", () => ({
  diagnoseStale: (root: string) => diagnoseStale(root),
  // FORWARD EVERY ARGUMENT — naming only `root` drops the options object a caller may pass.
  remedyStale: (...a: unknown[]) => remedyStale(...a),
  autoFastForwardEnabled: () => Promise.resolve(false),
}));

import { ProjectTabs, staleTitle, type ProjectTabStaleness } from "./ProjectTabs";

function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, questions: 0, running: 0, done: 0, ...over };
}

// `rootPath` is what the badge's panel diagnoses. A project without one renders NO badge — see the
// dedicated test below — so every fixture that expects a badge has to carry it.
const projects = [
  { id: "sparkle", name: "sparkle", rootPath: "/repos/sparkle" },
  { id: "website", name: "drodio-website", rootPath: "/repos/website" },
];

function diag(over: Partial<StaleDiagnosis> = {}): StaleDiagnosis {
  return {
    behind: 1696,
    base: "origin/main",
    headBranch: "main",
    defaultBranch: "main",
    detached: false,
    linkedWorktree: false,
    heldBy: "",
    dirtyCount: 0,
    dirtySample: [],
    blockingPaths: [],
    blockersKnown: true,
    canFastForward: true,
    remedy: "fast-forward",
    cause: "This checkout is clean and on main, so it can be fast-forwarded.",
    autoSafe: true,
    unknown: false,
    ...over,
  };
}

beforeEach(() => {
  diagnoseStale.mockReset();
  diagnoseStale.mockResolvedValue(diag());
  remedyStale.mockReset();
});

afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderTabs(
  staleness?: Record<string, ProjectTabStaleness>,
  selected: string | null = "sparkle",
  onSelect: (id: string) => void = () => {},
  items: { id: string; name: string; rootPath?: string }[] = projects,
) {
  return render(
    <ProjectTabs
      projects={items}
      selectedProjectId={selected}
      pinnedProjectId={null}
      countsByProject={{ sparkle: counts(), website: counts() }}
      onSelect={onSelect}
      onTogglePin={() => {}}
      stalenessByProject={staleness}
    />,
  );
}

const STALE: ProjectTabStaleness = { behind: 1696, base: "origin/main" };

describe("project tab staleness badge", () => {
  it("shows the behind-count on a stale project", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    // The NUMBER is on screen, thousands-separated — 1696 bare is hard to size at a glance.
    expect(badge.textContent).toContain("1,696");
    expect(badge.getAttribute("data-behind")).toBe("1696");
  });

  // The whole point of the badge is the sentence, not the number: "1,696" alone does not tell you
  // what it is behind or what to do instead. The accessible name carries it unconditionally; the
  // VISIBLE half is the hover card asserted in its own describe block below.
  it("names the base and says what to do instead in its accessible name", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    const label = badge.getAttribute("aria-label") ?? "";
    expect(label).toBe(staleTitle("sparkle", STALE));
    expect(label).toContain("origin/main");
    expect(label).toContain("STALE");
    expect(label).toMatch(/read from origin\/main instead/i);
  });

  // FAIL-CLOSED. Absence must render nothing at all — never a "0 behind"/"fresh" affordance. A
  // project we could not measure is absent for the same reason a fresh one is, so a badge can only
  // ever mean "measured, and behind".
  it("renders nothing for a project that is absent from the map", () => {
    renderTabs({ sparkle: STALE });
    expect(screen.queryByTestId("stale-website")).toBeNull();
  });

  it("renders nothing at all when no staleness is supplied", () => {
    renderTabs(undefined);
    expect(screen.queryByTestId("stale-sparkle")).toBeNull();
    expect(screen.queryByTestId("stale-website")).toBeNull();
  });

  // The divergence from TabCountBadge that is easiest to regress by "consistency" refactor: the
  // alarm badge hides on the tab you are looking at, this one must NOT. A stale checkout matters
  // most while you are working in it.
  it("stays visible on the ACTIVE tab, unlike the needs-you count badge", () => {
    renderTabs({ sparkle: STALE, website: { behind: 40, base: "origin/main" } }, "sparkle");
    expect(screen.getByTestId("stale-sparkle")).toBeTruthy(); // active
    expect(screen.getByTestId("stale-website")).toBeTruthy(); // inactive
  });

  it("badges each project with its own count and name", () => {
    renderTabs({
      sparkle: STALE,
      website: { behind: 7, base: "origin/trunk" },
    });
    expect(screen.getByTestId("stale-sparkle").textContent).toContain("1,696");
    const web = screen.getByTestId("stale-website");
    expect(web.textContent).toContain("7");
    // The base is per-project, not hardcoded to origin/main.
    expect(web.getAttribute("aria-label")).toContain("origin/trunk");
    expect(web.getAttribute("aria-label")).toContain("drodio-website");
  });

  // A badge with no directory behind it would be a button that can only ever fail, so it is not
  // rendered at all — the same fail-closed reading `stalenessByProject` itself follows.
  it("renders no badge for a project with no rootPath", () => {
    renderTabs({ sparkle: STALE }, "sparkle", () => {}, [{ id: "sparkle", name: "sparkle" }]);
    expect(screen.queryByTestId("stale-sparkle")).toBeNull();
  });

  // No emoji-as-icon anywhere in this repo — the warning mark is a react-icons SVG.
  it("uses an icon, not an emoji", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    expect(badge.querySelector("svg")).toBeTruthy();
    expect(badge.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

// ── THE HOVER EXPLANATION IS A RENDERED ELEMENT, NOT A `title` (bead sparkle-7h01z) ─────────────
//
// This is the test that must go RED if anyone puts `title={label}` back. It deliberately does NOT
// import `disableNativeTooltips` — mocking or invoking the kill-switch would make the assertion
// about the switch rather than about the badge. It asserts the thing that SURVIVES the switch: an
// element in the document carrying the sentence. A `title` attribute produces no such element, so a
// revert cannot pass this however the attribute is spelled.
describe("the stale badge's hover explanation", () => {
  it("renders no explanation element until the badge is hovered", () => {
    renderTabs({ sparkle: STALE });
    expect(screen.queryByTestId("stale-tip-sparkle")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders a VISIBLE element carrying the whole sentence on hover", () => {
    renderTabs({ sparkle: STALE });
    fireEvent.mouseEnter(screen.getByTestId("stale-sparkle"));

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe(staleTitle("sparkle", STALE));
    expect(tip.getAttribute("data-testid")).toBe("stale-tip-sparkle");
    // A native `title` would show nothing at all here — `disableNativeTooltips()` strips it on the
    // very `mouseover` that would have shown it, and it never replaces one on a named element.
    expect(screen.getByTestId("stale-sparkle").hasAttribute("title")).toBe(false);
  });

  it("takes the explanation away again when the pointer leaves", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    fireEvent.mouseEnter(badge);
    expect(screen.queryByRole("tooltip")).toBeTruthy();
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  // The card is the ONLY place the sentence is visible, so reaching the badge by Tab has to show it.
  it("shows the explanation on keyboard focus too", () => {
    renderTabs({ sparkle: STALE });
    fireEvent.focus(screen.getByTestId("stale-sparkle"));
    expect(screen.getByRole("tooltip").textContent).toBe(staleTitle("sparkle", STALE));
  });
});

describe("the stale badge opens the remedy panel", () => {
  it("is a real button, not a decorative image", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    expect(badge.tagName).toBe("BUTTON");
    // `onTabPointerDown` bails on `e.target.closest("button")`, so being a button is also what stops
    // a press on the badge dragging the tab out from under it.
    expect(badge.closest("button")).toBe(badge);
  });

  // ── THE SIDE EFFECT THAT WOULD REGRESS ────────────────────────────────────────────────────────
  // The badge sits inside the tab's own onClick. Before this change, clicking it selected the
  // project and did nothing else — so asserting only that the panel opened would pass against a
  // badge that ALSO switches projects under the user. The absence of the onSelect call is the half
  // that pins the fix.
  it("opens the panel and does NOT select the tab", async () => {
    const onSelect = vi.fn();
    renderTabs({ sparkle: STALE }, "website", onSelect);

    fireEvent.click(screen.getByTestId("stale-sparkle"));

    expect(await screen.findByTestId("stale-panel")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the panel from the keyboard without selecting the tab", async () => {
    const onSelect = vi.fn();
    renderTabs({ sparkle: STALE }, "website", onSelect);

    // A <button> turns Enter into a click; the badge stops that click reaching the tab.
    const badge = screen.getByTestId("stale-sparkle");
    fireEvent.keyDown(badge, { key: "Enter" });
    fireEvent.click(badge);

    expect(await screen.findByTestId("stale-panel")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("diagnoses the clicked project's own root", async () => {
    renderTabs({ sparkle: STALE });
    fireEvent.click(screen.getByTestId("stale-sparkle"));
    await waitFor(() => expect(diagnoseStale).toHaveBeenCalledWith("/repos/sparkle"));
  });

  // Every OTHER stale project gets a row too — that is the founder's ask, and it is why the panel
  // lives at the strip rather than inside the badge.
  it("lists every other stale project alongside the clicked one", async () => {
    renderTabs({ sparkle: STALE, website: { behind: 7, base: "origin/trunk" } });
    fireEvent.click(screen.getByTestId("stale-sparkle"));

    await screen.findByTestId("stale-row-sparkle");
    expect(await screen.findByTestId("stale-row-website")).toBeTruthy();
    await waitFor(() => expect(diagnoseStale).toHaveBeenCalledWith("/repos/website"));
  });

  // OpenPrMenu has no Escape handler; this panel's buttons move a git checkout, so it gets one —
  // and focus has to come BACK, because the panel is portaled away from the strip and a keyboard
  // user who escapes to nowhere has lost their place entirely.
  it("closes on Escape and returns focus to the badge", async () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    badge.focus();
    fireEvent.click(badge);
    await screen.findByTestId("stale-panel");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("stale-panel")).toBeNull());
    expect(document.activeElement).toBe(badge);
  });

  // THE FALLBACK BRANCH — the one that regressed silently (roborev 72737, bead sparkle-2mwl2m.1).
  //
  // The test above covers the badge-PRESENT branch, where focus goes back to the badge. This is the
  // other half: after a successful fast-forward the project leaves `stalenessByProject` and its
  // badge UNMOUNTS, so `closeStalePanel` falls back to the tab. That fallback used to read the slot
  // `<div>` from `tabEls` — and when the a11y restructure moved the tab stop off the slot and onto
  // the label, `.focus()` on the slot became a SILENT no-op: no error, no exception, focus just
  // lands on `document.body` and a keyboard user closing the panel is dumped to the top of the
  // document. Asserting "the panel closed" cannot see that; only asserting WHERE FOCUS WENT can.
  //
  // So this asserts the side effect (`document.activeElement` is the label) and explicitly rejects
  // `document.body`, which is precisely the value the defect produced.
  it("returns focus to the tab LABEL when the badge has gone (the successful-remedy case)", async () => {
    const { rerender } = renderTabs({ sparkle: STALE });
    fireEvent.click(screen.getByTestId("stale-sparkle"));
    await screen.findByTestId("stale-panel");

    // The remedy landed: the project drops out of `stalenessByProject`, so the badge unmounts and
    // the fallback is the ONLY way out for a keyboard user.
    rerender(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{ sparkle: counts(), website: counts() }}
        onSelect={() => {}}
        onTogglePin={() => {}}
        stalenessByProject={{}}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("stale-sparkle")).toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("stale-panel")).toBeNull());

    const label = screen.getByTestId("tab-label-sparkle");
    // The tab stop is the label, and it is what must hold focus.
    expect(document.activeElement, "focus must land on the tab label, not be dropped to <body>").toBe(label);
    expect(document.activeElement).not.toBe(document.body);
  });

  // THE ROW LIST IS FROZEN AT OPEN, and this is the case that decides it.
  //
  // `stalenessByProject` omits THREE different things — unknown, not-stale, and a read that FAILED
  // (the poll swallows a failed `repo_root_staleness` on purpose, since it runs on a timer). So an
  // entry disappearing does NOT mean "the remedy landed". An earlier version closed the panel on
  // that absence, which meant a transient index.lock on the 60s poll destroyed a refusal the user
  // was still reading (roborev 59454). The panel must survive it and keep its rows.
  it("keeps its rows when the project's staleness entry disappears mid-read", async () => {
    const { rerender } = renderTabs({ sparkle: STALE });
    fireEvent.click(screen.getByTestId("stale-sparkle"));
    await screen.findByTestId("stale-panel");
    await screen.findByTestId("stale-row-sparkle");

    // Could be a landed remedy — or could be a failed git read. Indistinguishable from here, which
    // is exactly why the panel must not act on it.
    rerender(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{ sparkle: counts(), website: counts() }}
        onSelect={() => {}}
        onTogglePin={() => {}}
        stalenessByProject={{}}
      />,
    );

    // The badge goes (it is driven by the live map) — but the panel and its row stay, so whatever
    // the user was reading is still on screen.
    await waitFor(() => expect(screen.queryByTestId("stale-sparkle")).toBeNull());
    expect(screen.getByTestId("stale-panel")).toBeTruthy();
    expect(screen.getByTestId("stale-row-sparkle")).toBeTruthy();
  });
});

describe("staleTitle", () => {
  it("thousands-separates the count and names both ends", () => {
    expect(staleTitle("proj", { behind: 1696, base: "origin/main" })).toBe(
      "proj is 1,696 commits behind origin/main — this checkout is STALE. Reading files from it returns old code; read from origin/main instead.",
    );
  });
});
