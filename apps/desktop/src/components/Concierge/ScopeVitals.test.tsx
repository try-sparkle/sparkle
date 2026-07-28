// @vitest-environment jsdom
//
// The ONE header line the founder reads all day, pinned exactly: "All projects" / "Pinned to X",
// the undivided count ("All projects · 2"), the cross-project split ("All projects · 2 here · 1 in
// mobile"), and "all calm".
//
// Two properties are load-bearing beyond the literals:
//   • the singular/plural agreement comes from the SHARED bandCountLabel, so the header and the tab
//     badges cannot drift. Asserted by composing the expectation from that helper AND by spelling
//     the resulting string out, so a change to either end fails here.
//   • a segment naming another project switches to it. Which is why it is a BUTTON.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bandCountLabel } from "../../engine/statusBandLabels";
import type { StatusBand } from "../../engine/buildSections";
import {
  ScopeVitals,
  needsYouLabel,
  needsYouSegments,
  scopeText,
  shortProjectName,
  switchLabel,
  vitalsLineText,
  type ProjectNeedsYou,
} from "./ScopeVitals";

afterEach(() => cleanup());

/** Counts with only the named bands set — every surface takes the full Record. */
function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, running: 0, done: 0, ...over };
}

function project(
  projectId: string,
  needsYou: number,
  isActive = false,
  projectName = projectId,
): ProjectNeedsYou {
  return { projectId, projectName, needsYou, isActive };
}

describe("scopeText (pure)", () => {
  it('says "All projects" unless pinned — never the word "Following"', () => {
    // The wordmark above already says whose scope this is; "Following" was width the thread wanted.
    expect(scopeText()).toBe("All projects");
    expect(scopeText("drodio-website")).toBe("Pinned to drodio-website");
  });

  it("truncates a long PINNED name too — the pin shares the one line (roborev 54176)", () => {
    // The width budget applied to segment names but not to the scope, which is the OTHER half of the
    // same line: "Pinned to sparkle-desktop-experiments · 2" is ~41 characters in a ~320px column
    // and wraps — reintroducing the exact height the one-line header exists to remove. The pinned
    // path is also the one that SKIPS the split, so no segment rule ever reached it.
    expect(scopeText("sparkle-desktop-experiments")).toBe("Pinned to sparkle-desktop…");
    // The same character budget the segments spend, not a second one that could drift.
    expect(scopeText("sparkle-desktop-experiments")).toBe(
      `Pinned to ${shortProjectName("sparkle-desktop-experiments")}`,
    );
  });
});

describe("needsYouLabel (pure)", () => {
  it("agrees in number at the n=1 boundary, from the shared band helper", () => {
    expect(needsYouLabel(1)).toBe("1 Needs you");
    expect(needsYouLabel(3)).toBe("3 Need you");
    // The SAME rule the tab badges inflect by — not a second copy of it that happens to match.
    expect(needsYouLabel(1)).toBe(bandCountLabel("needs_you", 1));
    expect(needsYouLabel(3)).toBe(bandCountLabel("needs_you", 3));
  });
});

describe("needsYouSegments (pure)", () => {
  it("nothing needing you → no segments at all", () => {
    expect(needsYouSegments(0)).toEqual([]);
    expect(needsYouSegments(0, [project("p1", 0, true)])).toEqual([]);
  });

  it("no breakdown supplied → the undivided total, not clickable", () => {
    expect(needsYouSegments(2)).toEqual([
      { projectId: null, text: "2", count: 2, switchable: false },
    ]);
  });

  it('all of it in the project you are already in → the bare number, no "here"', () => {
    // The founder's target reading: `All projects · 2`. "here" is noise when there is no "there".
    expect(needsYouSegments(2, [project("p1", 2, true)])).toEqual([
      { projectId: null, text: "2", count: 2, switchable: false },
    ]);
  });

  it("splits per project, WORST FIRST, and names the current one 'here'", () => {
    const segs = needsYouSegments(3, [project("p2", 1, false, "mobile"), project("p1", 2, true)]);
    expect(segs.map((s) => s.text)).toEqual(["2 here", "1 in mobile"]);
    expect(segs.map((s) => s.switchable)).toEqual([false, true]);
    expect(segs[1]!.projectId).toBe("p2");
  });

  it("a single OTHER project still names itself — you are not there", () => {
    expect(needsYouSegments(1, [project("p2", 1, false, "mobile")])).toEqual([
      { projectId: "p2", text: "1 in mobile", count: 1, switchable: true },
    ]);
  });

  it("ties break to the active project, then by name — a total order, stable across ticks", () => {
    const segs = needsYouSegments(3, [
      project("p3", 1, false, "zeta"),
      project("p2", 1, false, "alpha"),
      project("p1", 1, true, "here-project"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["1 here", "1 in alpha", "1 in zeta"]);
  });

  it("caps the split at three segments, summing the tail into 'N elsewhere'", () => {
    // Past the cap the line WRAPS, which makes the header taller than the two-line one this whole
    // change removed. The tail carries the rest of the COUNT (not a project tally), so the segments
    // still add up to the number the line states.
    const segs = needsYouSegments(10, [
      project("p1", 4, true),
      project("p2", 3, false, "mobile"),
      project("p3", 2, false, "api"),
      project("p4", 1, false, "docs"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["4 here", "3 in mobile", "3 elsewhere"]);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(10);
    expect(segs[2]!.switchable).toBe(false); // "elsewhere" names no single project to switch to
    expect(segs[2]!.projectId).toBeNull();
  });

  it("keeps 'here' on the line even when the active project is the SMALLEST (roborev 54176)", () => {
    // The cap used to keep the top MAX-1 BY COUNT alone, so the project you are standing in fell
    // into the tail whenever three others outranked it: `4 in mobile · 3 in api · 3 elsewhere`,
    // where 1 of that "elsewhere" is right here, in the column you are looking at. "elsewhere" then
    // misinforms about the ONE project you can act on without switching. A slot is reserved for the
    // active project instead, paid for out of the weakest kept segment — which goes to the tail,
    // where it is at least honestly described.
    const segs = needsYouSegments(10, [
      project("p2", 4, false, "mobile"),
      project("p3", 3, false, "api"),
      project("p4", 2, false, "docs"),
      project("p1", 1, true),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["4 in mobile", "1 here", "5 elsewhere"]);
    // Still WORST FIRST among the named segments, and the arithmetic still adds up.
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(10);
    expect(segs[2]!.projectId).toBeNull();
  });

  it("the reserved slot costs nothing when the active project already ranks", () => {
    // The trade only fires when "here" would otherwise be dropped — at four projects with the
    // active one on top, the cap behaves exactly as before.
    const segs = needsYouSegments(10, [
      project("p1", 4, true),
      project("p2", 3, false, "mobile"),
      project("p3", 2, false, "api"),
      project("p4", 1, false, "docs"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["4 here", "3 in mobile", "3 elsewhere"]);
  });

  it("no active project in the breakdown at all → the plain worst-first cap", () => {
    // Reachable: the selected project can have nothing needing you, in which case it is filtered
    // out before ranking and there is no "here" to reserve for.
    const segs = needsYouSegments(10, [
      project("p2", 4, false, "mobile"),
      project("p3", 3, false, "api"),
      project("p4", 3, false, "docs"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["4 in mobile", "3 in api", "3 in docs"]);
  });

  it("names every project when there are exactly three — the cap is a ceiling, not a quota", () => {
    const segs = needsYouSegments(6, [
      project("p1", 3, true),
      project("p2", 2, false, "mobile"),
      project("p3", 1, false, "api"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 here", "2 in mobile", "1 in api"]);
  });

  it("truncates a long project name rather than letting it wrap the line", () => {
    expect(shortProjectName("mobile")).toBe("mobile");
    expect(shortProjectName("sparkle-desktop-experiments")).toBe("sparkle-desktop…");
    expect(shortProjectName("sparkle-desktop-")).toBe("sparkle-desktop-"); // exactly at the cap
    expect(
      needsYouSegments(1, [project("p2", 1, false, "sparkle-desktop-experiments")])[0]!.text,
    ).toBe("1 in sparkle-desktop…");
  });

  it("folds a segment into the tail rather than let the clip swallow a BUTTON (roborev 54233)", () => {
    // The CSS backstop clips whatever runs past the column — and the things furthest right on this
    // line are BUTTONS. A clipped button is unclickable by mouse while still in the tab order, which
    // is an affordance that lies in the other direction from the one already fixed here. So the
    // segment count is trimmed to a CHARACTER budget for the whole line first: a segment that would
    // not fit folds into "N elsewhere", which is a span, so the clip can only ever bite on text.
    const segs = needsYouSegments(6, [
      project("p1", 3, true),
      project("p2", 2, false, "sparkle-desktop-experiments"),
      project("p3", 1, false, "another-project-here"),
    ]);
    // Abbreviating both names is not enough here (45 > 43), so the weakest switchable folds — but
    // only after that cheaper lever was tried, so the OTHER long name keeps its button.
    expect(segs.map((s) => s.text)).toEqual(["3 here", "2 in sparkle-d…", "1 elsewhere"]);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(6);
    // The LAST thing on the line is the non-interactive tail, not a control.
    expect(segs[segs.length - 1]!.switchable).toBe(false);
  });

  it("EDGE_MARGIN, isolated: a line INSIDE the width budget still may not end on a button", () => {
    // The case that pins the margin CLAUSE rather than the width one (roborev 54254 — the test that
    // used to live here folded on width alone, so deleting EDGE_MARGIN would not have failed it).
    // At full names this costs "3 in sparkle-desktop…"(24) + "2 in mobile-app"(18) = 42, which is
    // inside MAX_SEGMENT_CHARS (43) — so the width rule is satisfied and only the margin objects,
    // the line ending on a switchable segment at 42 > 43 − 5. The fitter answers by abbreviating.
    // Without the margin clause this would read ["3 in sparkle-desktop…", "2 in mobile-app"].
    const segs = needsYouSegments(5, [
      project("a", 3, false, "sparkle-desktop-experiments"),
      project("b", 2, false, "mobile-app"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 in sparkle-d…", "2 in mobile-app"]);
    // …and the result is now comfortably inside the margin, which is what makes ending on a control
    // legal again: 18 + 18 = 36 ≤ 38.
    expect(segs[segs.length - 1]!.switchable).toBe(true);
  });

  it("abbreviates a name before it will give up the whole segment (roborev 54254)", () => {
    // Folding used to be the only lever, so ONE long folder name cost the line its entire
    // cross-project switch affordance — the answer to PRD §2a, gone in exactly the case it exists
    // for. A name you can click but must read abbreviated beats a name you cannot see at all, and
    // the full name is on the button's title and accessible name regardless.
    const segs = needsYouSegments(5, [
      project("a", 3, false, "sparkle-desktop-experiments"),
      project("b", 2, false, "another-project-here"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 in sparkle-d…", "2 in another-p…"]);
    // BOTH projects still switchable — nothing was folded away.
    expect(segs.every((s) => s.switchable)).toBe(true);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(5);
  });

  it("prices MULTI-DIGIT counts, which are characters the budget has to pay for too", () => {
    // "12 in …" is a character wider than "1 in …", twice over. A budget that only ever saw
    // single-digit fixtures would let a two- or three-digit fleet slip past it.
    const segs = needsYouSegments(300, [
      project("a", 120, false, "sparkle-desktop-experiments"),
      project("b", 110, false, "another-project-here"),
      project("c", 70, false, "docs"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["120 in sparkle-desktop…", "180 elsewhere"]);
    expect(segs[segs.length - 1]!.switchable).toBe(false);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(300);
  });

  it("never strips the line bare — the LAST named segment always survives", () => {
    // The trimming has a floor, and it is structural rather than a special case: a single segment
    // plus its tail is ~44 characters at the very worst, which the abbreviating pass always brings
    // inside the budget, so there is always something left to drop TO.
    const segs = needsYouSegments(2, [
      project("a", 1, false, "a-really-long-folder-name-one"),
      project("b", 1, false, "a-really-long-folder-name-two"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["1 in a-really-long-f…", "1 elsewhere"]);
    expect(segs[0]!.switchable).toBe(true);
  });

  it("never abbreviates two projects to the SAME name (roborev 54262)", () => {
    // Folder basenames in this repo share prefixes as a matter of course — sparkle-desktop,
    // sparkle-desktop-experiments, sparkle-desktop-web all collapse to the same stem. Two segments
    // reading `sparkle-d…` are two BUTTONS that switch to different projects with nothing visible
    // to tell them apart, so a wrong click moves the founder to the wrong project. Abbreviating is
    // only allowed to buy width when it does not buy ambiguity: a colliding pass is rejected and
    // the ladder falls through to the drop lever, where the loser becomes the unambiguous tail.
    const segs = needsYouSegments(5, [
      project("a", 3, false, "sparkle-desktop-experiments"),
      project("b", 2, false, "sparkle-desktop-web"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 in sparkle-desktop…", "2 elsewhere"]);
    expect(segs[segs.length - 1]!.switchable).toBe(false);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(5);
  });

  it("a collision costs one of the COLLIDING pair, never an innocent third (roborev 54267)", () => {
    // The drop lever used to take the globally weakest switchable segment, which need not be a
    // member of the colliding pair — so a collision between two projects first cost an unrelated,
    // perfectly unambiguous segment, and THEN still cost one of the pair on the next pass. Two
    // segments' worth of switch affordance spent to resolve one ambiguity.
    //
    // Worked example (none active, total 10). Full names do not fit (24 + 22 + 11 = 57 > 43) and
    // the tight budget collides ("my-desktop-experiments" and "my-desktop-web" both read
    // `my-deskto…`), so the ladder falls through to the drop lever. Dropping the colliding LOSER
    // leaves [A, C] at the tight budget: 18 + 11 + 14 = 43, inside the budget and ending on the
    // tail. Dropping the globally weakest ("api") instead ends at ["5 in my-desktop-expe…",
    // "5 elsewhere"] — one named project where two were affordable.
    const segs = needsYouSegments(10, [
      project("a", 5, false, "my-desktop-experiments"),
      project("b", 4, false, "my-desktop-web"),
      project("c", 1, false, "api"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["5 in my-deskto…", "1 in api", "4 elsewhere"]);
    // The unrelated segment kept its button; the ambiguity is gone because one of the PAIR went.
    expect(segs.map((s) => s.switchable)).toEqual([true, true, false]);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(10);
  });

  it("a shared prefix that still DIFFERS inside the budget keeps both segments", () => {
    // The check is for collisions, not for prefixes: these two are distinguishable at the tight
    // budget, so both keep their button.
    const segs = needsYouSegments(5, [
      project("a", 3, false, ""),
      project("b", 2, false, ""),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 in ", "2 in "]);
  });

  it("trims as far as it must — two long names both fold away", () => {
    const segs = needsYouSegments(6, [
      project("p2", 3, false, "sparkle-desktop-experiments"),
      project("p3", 2, false, "another-project-here"),
      project("p4", 1, false, "third-long-project-name"),
    ]);
    expect(segs.map((s) => s.text)).toEqual(["3 in sparkle-desktop…", "3 elsewhere"]);
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(6);
  });

  it("never trims away the project you are standing in", () => {
    // The budget must not undo the reserved slot: "here" is the one segment you can act on without
    // switching, and it is also the SHORTEST, so it is never what pushed the line over.
    const segs = needsYouSegments(20, [
      project("p2", 9, false, "sparkle-desktop-experiments"),
      project("p3", 8, false, "another-project-here"),
      project("p4", 2, false, "docs"),
      project("p1", 1, true),
    ]);
    expect(segs.map((s) => s.text)).toContain("1 here");
    expect(segs.reduce((n, s) => n + s.count, 0)).toBe(20);
  });

  it("short names are left alone — the budget is a ceiling, not a squeeze", () => {
    // The ordinary case must be untouched by the trimming, or the split stops being useful.
    expect(
      needsYouSegments(6, [
        project("p1", 3, true),
        project("p2", 2, false, "mobile"),
        project("p3", 1, false, "api"),
      ]).map((s) => s.text),
    ).toEqual(["3 here", "2 in mobile", "1 in api"]);
  });

  it("a breakdown that does not add up to the total is not rendered as a split", () => {
    // The number column one STATES is a promise about what the thread accounts for
    // (ConciergeHost.surfacing.test). Segments that sum to less would quietly understate the fleet,
    // so the guard falls back to the undivided total rather than printing a smaller truth.
    expect(needsYouSegments(5, [project("p1", 2, true)])).toEqual([
      { projectId: null, text: "5", count: 5, switchable: false },
    ]);
  });
});

describe("vitalsLineText (pure) — the whole line, as read", () => {
  it("calm", () => {
    expect(vitalsLineText(undefined, 0)).toBe("All projects · all calm");
    expect(vitalsLineText("mobile", 0)).toBe("Pinned to mobile · all calm");
  });

  it("the founder's target reading", () => {
    expect(vitalsLineText(undefined, 2, [project("p1", 2, true)])).toBe("All projects · 2");
  });

  it("cross-project, worst first", () => {
    expect(
      vitalsLineText(undefined, 3, [project("p1", 2, true), project("p2", 1, false, "mobile")]),
    ).toBe("All projects · 2 here · 1 in mobile");
  });

  it("pinned still leads with the pin", () => {
    expect(vitalsLineText("web", 1, [project("p1", 1, true)])).toBe("Pinned to web · 1");
  });

  it("a long pin does not wrap the line either", () => {
    expect(vitalsLineText("sparkle-desktop-experiments", 2)).toBe("Pinned to sparkle-desktop… · 2");
  });

  it("a PIN drops the split entirely — the pin is already the grouping key", () => {
    // A pin scopes every count to one project, so the split can only ever name the project the line
    // opens with: "Pinned to web · 2 in web" says it twice and offers to switch you to where you
    // already are. Whether or not that project is the SELECTED one, which is the shape that made it
    // read as a switch to somewhere else.
    expect(vitalsLineText("web", 2, [project("p1", 2, false, "web")])).toBe("Pinned to web · 2");
    expect(vitalsLineText("web", 2, [project("p1", 2, true, "web")])).toBe("Pinned to web · 2");
  });
});

describe("ScopeVitals — rendered", () => {
  it("renders ONE line, and it is the string the pure function derives", () => {
    const byProject = [project("p1", 2, true), project("p2", 1, false, "mobile")];
    const { container } = render(<ScopeVitals counts={counts({ needs_you: 3 })} byProject={byProject} />);
    const line = screen.getByTestId("concierge-vitals-line");
    expect(line.textContent).toBe(vitalsLineText(undefined, 3, byProject));
    expect(line.textContent).toBe("All projects · 2 here · 1 in mobile");
    // ONE line — the scope and the counts are no longer two stacked blocks (founder, 2026-07-27:
    // "it's taking up too much space").
    expect(container.querySelectorAll("[data-testid='concierge-vitals-line']")).toHaveLength(1);
  });

  it("the RUNNING count is not printed, however many are running", () => {
    // Still carried in the view-model (and still badged elsewhere); it just no longer spends a row
    // of the column's scarcest space on something you don't act on.
    const { container } = render(
      <ScopeVitals counts={counts({ needs_you: 2, running: 5, done: 40 })} />,
    );
    expect(container.textContent).toBe("All projects · 2");
    expect(container.textContent).not.toContain("Running");
    expect(container.textContent).not.toContain("Done");
  });

  it("the count is a red status DOT plus a number — the words go to the screen reader", () => {
    render(<ScopeVitals counts={counts({ needs_you: 3 })} />);
    const dot = screen.getByTestId("concierge-needs-dot");
    // The band's own paint, from the shared helper — the same red the tab badges glow in.
    expect(dot.style.background).toBeTruthy();
    expect(dot.style.borderRadius).toBe("50%");
    // Nothing is lost: the inflected sentence survives verbatim as the accessible name.
    expect(screen.getByLabelText("3 Need you")).toBe(dot);
    expect(dot.getAttribute("role")).toBe("img");
  });

  it("says 1 Needs you at the boundary, in the accessible name too", () => {
    render(<ScopeVitals counts={counts({ needs_you: 1 })} />);
    expect(screen.getByLabelText("1 Needs you")).toBeTruthy();
  });

  it('calm renders "all calm" and no dot', () => {
    render(<ScopeVitals counts={counts({ done: 40 })} />);
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe("All projects · all calm");
    expect(screen.queryByTestId("concierge-needs-dot")).toBeNull();
  });

  it("pinned scope names the project", () => {
    render(<ScopeVitals pinnedProjectName="sparkle-mobile" counts={counts()} />);
    expect(screen.getByText("Pinned to sparkle-mobile")).toBeTruthy();
  });

  it("clicking an OTHER-project segment switches to that project, and only that", () => {
    const onProjectClick = vi.fn();
    render(
      <ScopeVitals
        counts={counts({ needs_you: 3 })}
        byProject={[project("p1", 2, true), project("p2", 1, false, "mobile")]}
        onProjectClick={onProjectClick}
      />,
    );
    // A BUTTON, named so a screen-reader user knows where it goes and what is waiting there.
    const seg = screen.getByRole("button", { name: switchLabel("mobile", 1) });
    expect(seg.getAttribute("aria-label")).toBe("Switch to mobile — 1 Needs you");
    fireEvent.click(seg);
    expect(onProjectClick).toHaveBeenCalledWith("p2");
    expect(onProjectClick).toHaveBeenCalledTimes(1);
  });

  it("the 'here' segment is NOT a button — there is nowhere to switch to", () => {
    render(
      <ScopeVitals
        counts={counts({ needs_you: 3 })}
        byProject={[project("p1", 2, true), project("p2", 1, false, "mobile")]}
        onProjectClick={vi.fn()}
      />,
    );
    // Exactly one control on the line: the other project's.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("2 here").tagName).toBe("SPAN");
  });

  it("renders NO button at all when no handler was given — an inert control is a lie", () => {
    // Both `onProjectClick` and the controller field behind it are optional, so this state is
    // reachable: a column mounted without the handler would otherwise paint a focusable,
    // underlined, "Switch to mobile"-named control that does nothing when clicked.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 3 })}
        byProject={[project("p1", 2, true), project("p2", 1, false, "mobile")]}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // …and the reading is unchanged — only the affordance is.
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 2 here · 1 in mobile",
    );
  });

  it("is held to ONE line by CSS as well as by the character budget", () => {
    // The caps bound the line in CHARACTERS, which is the thing that actually decides whether it
    // wraps — but a character is not a fixed width (theme, zoom, a narrower column), so the promise
    // this header makes cannot rest on arithmetic alone. `nowrap` + `hidden` + `ellipsis` is the
    // backstop: past the budget the line ELIDES rather than growing a second row, because a second
    // row is the very complaint the collapse answered (founder, 2026-07-27).
    const { container } = render(<ScopeVitals counts={counts({ needs_you: 2 })} />);
    const line = container.querySelector<HTMLElement>("[data-testid='concierge-vitals-line']")!;
    expect(line.style.whiteSpace).toBe("nowrap");
    expect(line.style.textOverflow).toBe("ellipsis");
    // `clip`, NOT `hidden` (roborev 54233). `hidden` makes the line a SCROLL CONTAINER, and this one
    // holds focusable buttons: focusing one that sits past the edge scrolls the box programmatically,
    // and with no scrollbar there is no way for the user to scroll back — the line stays offset for
    // good. `clip` creates no scroll container at all, so that cannot happen.
    expect(line.style.overflow).toBe("clip");
  });

  it("the clip can only ever bite on TEXT — the last thing on the line is never a control", () => {
    // The shape most likely to overflow, rendered: the rightmost element is the non-interactive
    // tail, so nothing clickable can be clipped out of reach of the mouse while staying in the tab
    // order — which matters more under `overflow: clip` than it would under `hidden`, since there is
    // no scroll container left to bring a clipped control back into view.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 6 })}
        byProject={[
          project("p1", 3, true),
          project("p2", 2, false, "sparkle-desktop-experiments"),
          project("p3", 1, false, "another-project-here"),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    const line = screen.getByTestId("concierge-vitals-line");
    expect(line.textContent).toBe("All projects · 3 here · 2 in sparkle-d… · 1 elsewhere");
    expect(screen.getByText("1 elsewhere").tagName).toBe("SPAN");
    // The switch affordance survived the squeeze — abbreviated, not deleted.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // The property that actually carries the invariant, asserted as a property rather than as a
    // literal: whatever this line renders, its LAST element is never a button.
    const kids = [...line.children];
    expect(kids[kids.length - 1]!.querySelector("button")).toBeNull();
  });

  it("two same-prefix projects never render two look-alike buttons", () => {
    render(
      <ScopeVitals
        counts={counts({ needs_you: 5 })}
        byProject={[
          project("a", 3, false, "sparkle-desktop-experiments"),
          project("b", 2, false, "sparkle-desktop-web"),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    // No two controls on this line may look the same — that is the whole property.
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["3 in sparkle-desktop…"]);
  });

  it("keeps the switch button when the line is comfortably short", () => {
    // The margin is a ceiling, not a ban: an ordinary two-project split still ends on its control,
    // because it is nowhere near the width where clipping could reach it.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 3 })}
        byProject={[project("p1", 2, true), project("p2", 1, false, "mobile")]}
        onProjectClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 2 here · 1 in mobile",
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("four projects with SHORT names keep all three segments", () => {
    // The cap's ordinary shape, rendered end to end: four projects with needs-you work, three named
    // and the fourth folded into the tail. Nothing here is near the width budget.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 10 })}
        byProject={[
          project("p1", 4, true),
          project("p2", 3, false, "mobile"),
          project("p3", 2, false, "api"),
          project("p4", 1, false, "docs"),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 4 here · 3 in mobile · 3 elsewhere",
    );
    // THREE segments, never four — and only the one naming another project is a control.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText(/docs/)).toBeNull();
  });

  it("four projects AND a long name: the name shrinks, the BUTTON stays (roborev 54254)", () => {
    // The same four projects with a REAL Sparkle folder name in them. `3 in sparkle-desktop…` costs
    // 24 of the 43-character budget, which `4 here` plus a tail cannot fit beside — so the name
    // abbreviates to `sparkle-d…` and the whole line lands at 41, one row, ending on the tail, with
    // the switch button intact. Dropping the segment instead (which is what this did before) took
    // the cross-project switch — the whole PRD §2a answer — out of the header in exactly the case it
    // was built for, on this repo's own canonical folder name.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 10 })}
        byProject={[
          project("p1", 4, true),
          project("p2", 3, false, "sparkle-desktop-experiments"),
          project("p3", 2, false, "api"),
          project("p4", 1, false, "docs"),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 4 here · 3 in sparkle-d… · 3 elsewhere",
    );
    // The affordance the earlier commits added is still reachable…
    const seg = screen.getByRole("button", {
      name: "Switch to sparkle-desktop-experiments — 3 Need you",
    });
    expect(seg.getAttribute("title")).toBe("sparkle-desktop-experiments");
    // …and the line still ends on the non-interactive tail, so the clip can only bite on text.
    expect(screen.getByText("3 elsewhere").tagName).toBe("SPAN");
  });

  it("the tail never swallows the project you are standing in", () => {
    // Rendered counterpart of the pure cap test: with three bigger projects the active one still
    // gets its segment, so "elsewhere" only ever names places you would have to switch to.
    render(
      <ScopeVitals
        counts={counts({ needs_you: 10 })}
        byProject={[
          project("p2", 4, false, "mobile"),
          project("p3", 3, false, "api"),
          project("p4", 2, false, "docs"),
          project("p1", 1, true),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 4 in mobile · 1 here · 5 elsewhere",
    );
    expect(screen.getByText("1 here").tagName).toBe("SPAN");
  });

  it("keeps the FULL pinned name on hover when the visible one is truncated", () => {
    render(
      <ScopeVitals pinnedProjectName="sparkle-desktop-experiments" counts={counts({ needs_you: 2 })} />,
    );
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "Pinned to sparkle-desktop… · 2",
    );
    // The truncation is a width budget, not a rename: hover recovers the folder you are pinned to.
    expect(screen.getByText("Pinned to sparkle-desktop…").getAttribute("title")).toBe(
      "sparkle-desktop-experiments",
    );
  });

  it("ANNOUNCES the full pinned name — a screen reader has no width problem (roborev 54233)", () => {
    // `title` on a role-less span is not part of the accessible name computation, so AT would read
    // the elided name. The segment buttons already carry the full name via aria-label for exactly
    // this reason; the scope half of the same line must not be the inconsistent one.
    render(
      <ScopeVitals pinnedProjectName="sparkle-desktop-experiments" counts={counts({ needs_you: 2 })} />,
    );
    const scope = screen.getByLabelText("Pinned to sparkle-desktop-experiments");
    // …while the VISIBLE text stays inside the width budget.
    expect(scope.textContent).toBe("Pinned to sparkle-desktop…");
  });

  it("leaves the unpinned scope unlabelled — nothing is hidden, so nothing needs announcing", () => {
    render(<ScopeVitals counts={counts({ needs_you: 2 })} />);
    const scope = screen.getByText("All projects");
    expect(scope.getAttribute("aria-label")).toBeNull();
    expect(scope.getAttribute("role")).toBeNull();
  });

  it("adds no title to the unpinned scope — there is nothing hidden to recover", () => {
    render(<ScopeVitals counts={counts({ needs_you: 2 })} />);
    expect(screen.getByText("All projects").getAttribute("title")).toBeNull();
  });

  it("keeps the FULL project name in the accessible name when the visible text is truncated", () => {
    render(
      <ScopeVitals
        counts={counts({ needs_you: 2 })}
        byProject={[
          project("p1", 1, true),
          project("p2", 1, false, "sparkle-desktop-experiments"),
        ]}
        onProjectClick={vi.fn()}
      />,
    );
    const seg = screen.getByRole("button", {
      name: "Switch to sparkle-desktop-experiments — 1 Needs you",
    });
    expect(seg.textContent).toBe("1 in sparkle-desktop…"); // the width budget
    expect(seg.getAttribute("title")).toBe("sparkle-desktop-experiments"); // …and hover recovers it
  });
});
