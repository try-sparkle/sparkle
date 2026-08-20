// @vitest-environment jsdom
//
// THE PER-PROJECT HALF of the ⋯ Settings → "Concierge tools" pane (bead `sparkle-gylxbo`, contract
// requirement 3). What these pin is the one thing the founder asked for in words: the pane must say
// WHICH TIER IS IN FORCE AND WHERE IT CAME FROM. A policy he cannot see is one he cannot trust.
//
// TWO SHAPES OF VACUITY ARE DELIBERATELY DESIGNED OUT OF THIS FILE.
//
// (1) ABSENCE IN AN UNMOUNTED COMPONENT PROVES NOTHING. "Allow is not offered for `merge_pr` in a
//     merge-protected repo" is trivially true of a pane that renders no options at all, and equally
//     true of one keyed to the wrong repo entirely. So every such assertion is made with BOTH scopes
//     reachable in one test body: the global scope is rendered first and asserted to offer all three
//     tiers for the same tool, the scope is switched, the project scope is asserted to offer fewer,
//     and — for the switcher itself — the scope is switched BACK and the global answer asserted
//     intact. One direction alone is half the evidence.
//
// (2) A ROW'S ORIGIN TEXT IS ASSERTED AGAINST A SIBLING ROW IN THE SAME RENDER. "This row says
//     inherited" is satisfied by a component that says inherited on every row, which is exactly what
//     a per-project pane wired to nothing would do. The test that has power is the one that finds
//     two rows in ONE rendered project scope whose origins DIFFER, and pins which is which.
//
// The config writer is NOT mocked out at the `configActions` layer here (as the sibling suite does
// for the global rows) — `@tauri-apps/api/core`'s `invoke` is, so the assertion runs through the
// REAL `services/config` and the REAL `conciergeToolConfigPath`. The quoted-slug TOML path is the
// half of this feature Rust has to parse, and a mock of our own writer would have asserted our own
// argument rather than the path that reaches the file.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

const allowAllConciergeTools = vi.fn();
const resetAllConciergeTools = vi.fn();
const setConciergeToolPolicy = vi.fn();
vi.mock("../services/configActions", () => ({
  setConciergeToolPolicy: (...a: unknown[]) => setConciergeToolPolicy(...a),
  allowAllConciergeTools: () => allowAllConciergeTools(),
  resetAllConciergeTools: () => resetAllConciergeTools(),
}));

vi.mock("../services/conciergeAiAccess", () => ({
  useConciergeAiAccess: () => ({ enabled: true, remedy: null }),
  turnOnConciergeAi: () => undefined,
}));

import { ConciergeToolsPane } from "./ConciergeToolsPane";
import {
  TIGHTEN_ONLY_NOTE,
  narrowOwnOrgs,
  narrowProjectPolicy,
  normalizeScopeSlug,
  offerableDecisions,
  policyOriginLabel,
  policyScopeSlugs,
  resolveProjectRowPolicy,
} from "./ConciergeProjectPolicy";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import {
  MERGE_PROTECTED_SLUGS,
  NO_TOOL_POLICY_OVERRIDES,
  POLICY_DECISIONS,
  POLICY_STRICTNESS,
  conciergeToolConfigPath,
  type PolicyDecision,
} from "../services/conciergeTools/policy";

/** A repo the owner DOES own, once `own_orgs` names his org. */
const OWN = "drodio/sparkle";
/** A repo shipped merge-protected. Read from the module rather than typed, so a change to the
 *  shipped pin retargets this suite instead of silently leaving it testing a repo nobody pins. */
const PINNED = MERGE_PROTECTED_SLUGS[0] ?? "";

/** Seed the two settings-store fields the per-project pane probes for. They are hydrated by another
 *  seam; the pane reads them defensively, and this is what the hydrated state looks like. */
function seedPolicy(patch: {
  conciergeToolPolicy?: Record<string, string>;
  conciergeOwnOrgs?: string[];
  conciergeProjectPolicy?: Record<string, Record<string, string>>;
}) {
  useSettingsStore.setState(patch as never);
}

/** Switch the pane's scope. `null` is the global screen.
 *
 *  Drives whichever of the two real routes the repo is reachable by: the `<select>` when it is
 *  pinned or already configured, and the "Another repo…" entry when it is neither. A
 *  `fireEvent.change` to a value the select has no option for does NOT set that value — the element
 *  reports `""` — so taking the shortcut would have tested a scope with no name. */
function switchScope(to: string | null) {
  const select = screen.getByTestId("concierge-policy-scope") as HTMLSelectElement;
  if (to === null) {
    fireEvent.change(select, { target: { value: "__all__" } });
    return;
  }
  const listed = within(select)
    .getAllByRole("option")
    .some((o) => (o as HTMLOptionElement).value === to);
  if (listed) {
    fireEvent.change(select, { target: { value: to } });
    return;
  }
  fireEvent.change(select, { target: { value: "__other__" } });
  fireEvent.change(screen.getByTestId("concierge-policy-scope-input"), { target: { value: to } });
  fireEvent.click(screen.getByRole("button", { name: "Use" }));
}

/** The GLOBAL row for a tool — the pane's original rows, which only exist in the "All projects"
 *  scope. Throws rather than returning null so a mis-scoped test fails loudly. */
function globalRow(tool: string): HTMLElement {
  const row = screen
    .getAllByTestId("concierge-tool-row")
    .find((r) => within(r).queryByText(tool));
  if (!row) throw new Error(`no GLOBAL row for ${tool}`);
  return row;
}

/** The PROJECT row for a tool — only exists inside a project scope. */
function projectRow(tool: string): HTMLElement {
  const row = screen
    .getAllByTestId("concierge-project-tool-row")
    .find((r) => within(r).queryByText(tool));
  if (!row) throw new Error(`no PROJECT row for ${tool}`);
  return row;
}

/** The labels the row's segmented control actually renders, in order. This is the query the
 *  "a looser tier is never OFFERED" assertions turn on: a tier that is merely disabled would still
 *  appear here, which is why the pane omits it rather than greying it. */
function offeredIn(row: HTMLElement, testid: string): string[] {
  return within(within(row).getByTestId(testid))
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

beforeEach(() => {
  invoke.mockClear();
  setConciergeToolPolicy.mockClear();
  useSettingsStore.setState({ conciergeToolPolicy: {} });
  seedPolicy({ conciergeOwnOrgs: [], conciergeProjectPolicy: {} });
  useUiStore.setState({ settingsRequest: null, conciergeCopyOnSelection: true });
});
afterEach(cleanup);

describe("the scope switcher", () => {
  it("defaults to All projects and leaves that screen exactly as it was", () => {
    render(<ConciergeToolsPane />);
    const select = screen.getByTestId("concierge-policy-scope") as HTMLSelectElement;
    expect(select.value).toBe("__all__");
    // The global rows are present and the per-project ones are not — the default screen did not
    // gain a second set of controls.
    expect(screen.getAllByTestId("concierge-tool-row").length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("concierge-project-tool-row").length).toBe(0);
    expect(screen.queryByTestId("concierge-tighten-note")).toBeNull();
  });

  it("offers every merge-protected repo BEFORE anyone has configured one", () => {
    render(<ConciergeToolsPane />);
    const values = within(screen.getByTestId("concierge-policy-scope"))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    for (const slug of MERGE_PROTECTED_SLUGS) expect(values, slug).toContain(slug);
  });

  it("offers a repo that has a rule but ships no pin", () => {
    seedPolicy({ conciergeProjectPolicy: { [OWN]: { merge_pr: "deny" } } });
    render(<ConciergeToolsPane />);
    const values = within(screen.getByTestId("concierge-policy-scope"))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain(OWN);
  });

  it("reaches a repo that is neither pinned nor configured, through Another repo…", () => {
    render(<ConciergeToolsPane />);
    switchScope("__other__");
    fireEvent.change(screen.getByTestId("concierge-policy-scope-input"), {
      target: { value: "  Acme/Widgets  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    // Normalized on the way in — the scope the pane holds is the KEY a write lands under, so a
    // repo typed with capitals must not create a second, shadow entry in config.toml.
    expect(screen.getAllByTestId("concierge-project-tool-row").length).toBeGreaterThan(0);
    expect((screen.getByTestId("concierge-policy-scope") as HTMLSelectElement).value).toBe(
      "acme/widgets",
    );
  });
});

// THE HEADLINE TEST. Both scopes are reachable in one body and both are asserted, in both
// directions: this is what stops "the project scope shows a project tier" from being satisfied by a
// pane that shows the project tier everywhere, or by one that shows nothing anywhere.
describe("switching scope changes which tier is shown — in BOTH directions", () => {
  it("shows the global tier globally and the repo's tier for the repo, and restores it on the way back", () => {
    // The contract's acceptance criterion, staged as UI: one global `merge_pr = allow`, one org
    // claimed as ours. The owner's repo may merge; the merge-protected one may not.
    seedPolicy({
      conciergeToolPolicy: { merge_pr: "allow" },
      conciergeOwnOrgs: ["drodio"],
    });
    render(<ConciergeToolsPane />);

    // GLOBAL: allowed, and every tier is on offer.
    const globalMerge = globalRow("merge_pr");
    expect(
      within(globalMerge).getByRole("button", { name: "Allow" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(offeredIn(globalMerge, "concierge-tool-segment")).toEqual([
      "Allow",
      "Ask first",
      "Never",
    ]);

    // THE OWNER'S OWN REPO: still allowed. Same tool, different scope, unchanged answer — this is
    // the half that proves the project scope is not simply refusing everything.
    switchScope(OWN);
    const ownMerge = projectRow("merge_pr");
    expect(within(ownMerge).getByTestId("concierge-project-effective").textContent).toContain(
      "Allow",
    );
    expect(
      within(ownMerge).getByRole("button", { name: "Allow" }).getAttribute("aria-pressed"),
    ).toBe("true");

    // THE MERGE-PROTECTED REPO: denied, while the inherited global answer is still shown as Allow.
    switchScope(PINNED);
    const pinnedMerge = projectRow("merge_pr");
    expect(within(pinnedMerge).getByTestId("concierge-project-effective").textContent).toContain(
      "Never",
    );
    expect(within(pinnedMerge).getByTestId("concierge-project-inherited").textContent).toContain(
      "Allow",
    );
    expect(within(pinnedMerge).getByTestId("concierge-project-origin").textContent).toBe(
      "Merge-protected repo",
    );

    // AND BACK. The global screen still says what it said — switching scope inspected the policy,
    // it did not edit it.
    switchScope(null);
    expect(
      within(globalRow("merge_pr")).getByRole("button", { name: "Allow" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryAllByTestId("concierge-project-tool-row").length).toBe(0);
  });
});

describe("a tier the lattice would ignore is never OFFERED", () => {
  it("drops Allow for merge_pr once the inherited baseline is Ask — while the global scope still offers it", () => {
    seedPolicy({ conciergeOwnOrgs: ["drodio"] }); // no global rule: merge_pr derives to `ask`
    render(<ConciergeToolsPane />);

    // The control that CAN loosen, so the absence below is a statement about the rule and not
    // about a pane that renders no options.
    expect(offeredIn(globalRow("merge_pr"), "concierge-tool-segment")).toContain("Allow");

    switchScope(OWN);
    const offered = offeredIn(projectRow("merge_pr"), "concierge-project-segment");
    expect(offered).not.toContain("Allow");
    expect(offered).toEqual(["Ask first", "Never"]);
  });

  it("leaves a merge-protected repo exactly ONE tier for merge_pr, however permissive the config", () => {
    // The most permissive configuration anyone could write, including claiming the org as ours.
    seedPolicy({
      conciergeToolPolicy: { merge_pr: "allow" },
      conciergeOwnOrgs: ["drodio", (PINNED.split("/")[0] ?? "")],
      conciergeProjectPolicy: { [PINNED]: { merge_pr: "allow" } },
    });
    render(<ConciergeToolsPane />);
    expect(offeredIn(globalRow("merge_pr"), "concierge-tool-segment")).toEqual([
      "Allow",
      "Ask first",
      "Never",
    ]);

    switchScope(PINNED);
    expect(offeredIn(projectRow("merge_pr"), "concierge-project-segment")).toEqual(["Never"]);
  });

  it("still offers all three for a tool no floor reaches, in the SAME project scope", () => {
    // The control for the two tests above: `get_state` is read-only, so neither floor touches it and
    // its baseline stays `allow`. Without this row, "the project pane offers fewer tiers" would be
    // satisfied by a pane that offers fewer tiers for everything.
    seedPolicy({ conciergeOwnOrgs: ["drodio"] });
    render(<ConciergeToolsPane />);
    switchScope(PINNED);
    expect(offeredIn(projectRow("get_state"), "concierge-project-segment")).toEqual([
      "Allow",
      "Ask first",
      "Never",
    ]);
    expect(offeredIn(projectRow("merge_pr"), "concierge-project-segment")).toEqual(["Never"]);
  });

  it("says the tightening rule out loud", () => {
    render(<ConciergeToolsPane />);
    switchScope(OWN);
    expect(screen.getByTestId("concierge-tighten-note").textContent).toContain(TIGHTEN_ONLY_NOTE);
  });
});

describe("where the answer came from, row by row", () => {
  it("distinguishes an OVERRIDDEN row from an INHERITED one in the same rendered scope", () => {
    seedPolicy({
      conciergeOwnOrgs: ["drodio"],
      conciergeProjectPolicy: { [OWN]: { get_config: "deny" } },
    });
    render(<ConciergeToolsPane />);
    switchScope(OWN);

    const overridden = within(projectRow("get_config"));
    const inherited = within(projectRow("get_state"));

    // The two rows differ — the assertion that has power, because a pane wired to nothing renders
    // the SAME origin on every row and would pass either single-row check on its own.
    const a = overridden.getByTestId("concierge-project-origin").textContent;
    const b = inherited.getByTestId("concierge-project-origin").textContent;
    expect(a).not.toBe(b);
    expect(a).toBe("This project’s rule");
    expect(b).toBe("Inherited from All projects");

    // And the tiers behind the difference: the overridden row is denied while the whole-fleet
    // answer beside it is still Allow.
    expect(overridden.getByTestId("concierge-project-effective").textContent).toContain("Never");
    expect(overridden.getByTestId("concierge-project-inherited").textContent).toContain("Allow");
    expect(inherited.getByTestId("concierge-project-effective").textContent).toContain("Allow");

    // The sentence differs too, and it is the POLICY LAYER'S sentence — it names the repo.
    expect(overridden.getByTestId("concierge-project-reason").textContent).toContain(OWN);
    expect(inherited.getByTestId("concierge-project-reason").textContent).not.toContain(OWN);
  });

  it("attributes a foreign repo's floor to the org list, not to a rule the user wrote", () => {
    seedPolicy({ conciergeToolPolicy: { merge_pr: "allow" }, conciergeOwnOrgs: [] });
    render(<ConciergeToolsPane />);
    switchScope(OWN); // own_orgs is empty, so even this repo reads foreign
    const row = within(projectRow("merge_pr"));
    expect(row.getByTestId("concierge-project-origin").textContent).toBe("Not one of your orgs");
    expect(row.getByTestId("concierge-project-effective").textContent).toContain("Ask first");
    expect(row.getByTestId("concierge-project-inherited").textContent).toContain("Allow");
  });
});

describe("the merge-protected badges", () => {
  it("tells a PINNED repo to hand the merge to a human, and names no config lever", () => {
    seedPolicy({ conciergeOwnOrgs: ["drodio"] });
    render(<ConciergeToolsPane />);
    switchScope(PINNED);
    const badge = screen.getByTestId("concierge-merge-protected-badge").textContent ?? "";
    expect(badge).toContain(PINNED);
    expect(badge).toMatch(/never merge/i);
    expect(badge).toMatch(/hand the merge to a human/i);
    // THE SIDE EFFECT THAT MATTERS: it must not point the reader at a setting they cannot change.
    // A remedy string is an instruction people follow, and this one would fail for them.
    expect(badge).not.toContain("own_orgs");
  });

  it("tells a FOREIGN repo which lever to pull, and it is own_orgs", () => {
    seedPolicy({ conciergeOwnOrgs: ["someone-else"] });
    render(<ConciergeToolsPane />);
    switchScope(OWN);
    const badge = screen.getByTestId("concierge-merge-protected-badge").textContent ?? "";
    expect(badge).toContain(OWN);
    expect(badge).toContain("own_orgs");
  });

  it("shows NO badge for a repo the user owns and nothing pins", () => {
    // The paired negative. Both other cases render a badge, so without this the badge could be
    // unconditional and every assertion above would still pass.
    seedPolicy({ conciergeOwnOrgs: ["drodio"] });
    render(<ConciergeToolsPane />);
    switchScope(OWN);
    expect(screen.getAllByTestId("concierge-project-tool-row").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("concierge-merge-protected-badge")).toBeNull();
  });
});

describe("the override control writes the project's own key", () => {
  it("sets concierge.projects.\"<slug>\".tools.<tool> — through the real config path builder", async () => {
    seedPolicy({ conciergeOwnOrgs: ["drodio"] });
    render(<ConciergeToolsPane />);
    switchScope(OWN);
    fireEvent.click(within(projectRow("get_state")).getByRole("button", { name: "Never" }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_config_value", {
        path: conciergeToolConfigPath("get_state", OWN),
        value: "deny",
      }),
    );
    // The GLOBAL writer was not touched — a project row must never edit `[concierge.tools]`.
    expect(setConciergeToolPolicy).not.toHaveBeenCalled();
  });

  it("clears that same key on Reset, and only offers Reset where a rule exists", async () => {
    seedPolicy({
      conciergeOwnOrgs: ["drodio"],
      conciergeProjectPolicy: { [OWN]: { get_config: "deny" } },
    });
    render(<ConciergeToolsPane />);
    switchScope(OWN);
    // Present on the row that has a rule, absent on the one that does not — the pair, not just the
    // presence, which would pass on a Reset rendered unconditionally.
    expect(within(projectRow("get_state")).queryByRole("button", { name: /^Clear the/ })).toBeNull();
    fireEvent.click(
      within(projectRow("get_config")).getByRole("button", { name: /^Clear the/ }),
    );
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("unset_config_value", {
        path: conciergeToolConfigPath("get_config", OWN),
      }),
    );
  });
});

// The pure helpers, exercised directly. These are the parts the rendered assertions above lean on,
// and a table here costs nothing while making a regression's cause obvious.
describe("the helpers behind the rendering", () => {
  it("offerableDecisions is ordered by the render order and filtered by the STRICTNESS rank", () => {
    expect(offerableDecisions("allow")).toEqual(["allow", "ask", "deny"]);
    expect(offerableDecisions("ask")).toEqual(["ask", "deny"]);
    expect(offerableDecisions("deny")).toEqual(["deny"]);
    // Derived rather than transcribed: every decision offered must rank at or above the baseline,
    // for every baseline in the vocabulary. A tier added to POLICY_DECISIONS is covered by this
    // without anyone remembering to extend the three lines above.
    for (const baseline of POLICY_DECISIONS) {
      for (const d of offerableDecisions(baseline)) {
        expect(POLICY_STRICTNESS[d as PolicyDecision]).toBeGreaterThanOrEqual(
          POLICY_STRICTNESS[baseline],
        );
      }
    }
  });

  it("resolveProjectRowPolicy reports the floor a project rule cannot go below", () => {
    // In a pinned repo the INHERITED answer is `allow` while the reachable floor is `deny`. A pane
    // that built its dropdown from `inheritedDecision` would offer three tiers, two of which write
    // to config and change nothing — this is the exact arithmetic that must not be used.
    const r = resolveProjectRowPolicy("merge_pr", { merge_pr: "allow" }, PINNED, ["drodio"], {});
    expect(r.evaluation.project?.inheritedDecision).toBe("allow");
    expect(r.baseline).toBe("deny");
    expect(r.offerable).toEqual(["deny"]);
    expect(r.evaluation.decision).toBe("deny");
  });

  it("policyOriginLabel treats anything that is not a project contributor as inherited", () => {
    const inherited = resolveProjectRowPolicy(
      "get_state",
      NO_TOOL_POLICY_OVERRIDES,
      OWN,
      ["drodio"],
      {},
    );
    expect(policyOriginLabel(inherited.evaluation)).toBe("Inherited from All projects");
    const overridden = resolveProjectRowPolicy("get_state", NO_TOOL_POLICY_OVERRIDES, OWN, ["drodio"], {
      [OWN]: { get_state: "deny" },
    });
    expect(policyOriginLabel(overridden.evaluation)).toBe("This project’s rule");
  });

  it("narrows the two probed store fields, and fails safe on junk", () => {
    expect(narrowOwnOrgs(["  DROdio ", 7, "", null])).toEqual(["drodio"]);
    expect(narrowOwnOrgs(undefined)).toEqual([]);
    expect(narrowOwnOrgs("drodio")).toEqual([]);
    // Both wire shapes: the bare tool table and the `{ tools }` wrapper.
    expect(narrowProjectPolicy({ "A/B": { merge_pr: "deny" } })).toEqual({
      "a/b": { merge_pr: "deny" },
    });
    expect(narrowProjectPolicy({ "A/B": { tools: { merge_pr: "deny" } } })).toEqual({
      "a/b": { merge_pr: "deny" },
    });
    expect(narrowProjectPolicy(null)).toEqual({});
  });

  it("normalizes a scope slug through the policy module's own parser", () => {
    expect(normalizeScopeSlug("  Acme/Widgets ")).toBe("acme/widgets");
    expect(normalizeScopeSlug("acme")).toBeNull();
    expect(normalizeScopeSlug("a/b/c")).toBeNull();
    expect(normalizeScopeSlug(null)).toBeNull();
  });

  it("policyScopeSlugs dedupes, sorts, and always carries the shipped pins", () => {
    expect(policyScopeSlugs(["Z/z", "a/a", "a/a"], ["m/m"])).toEqual(["a/a", "m/m", "z/z"]);
    expect(policyScopeSlugs([])).toEqual([...MERGE_PROTECTED_SLUGS].sort());
  });
});
