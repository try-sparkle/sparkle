// @vitest-environment jsdom
//
// The ⋯ Settings → "Concierge tools" pane. What these pin is the pane's HONESTY, because a
// permission control that misreports itself is worse than no control: the row must show the value
// the policy layer would actually act on, mark whether that value is the derived default or the
// user's own, and write through configActions rather than inventing its own persistence.
//
// The config writer is mocked (the real one invokes Tauri); the settings store is real, so the
// pane and the store agree the way they do in the app.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setConciergeToolPolicy = vi.fn();
const allowAllConciergeTools = vi.fn();
const resetAllConciergeTools = vi.fn();
vi.mock("../services/configActions", () => ({
  setConciergeToolPolicy: (...a: unknown[]) => setConciergeToolPolicy(...a),
  allowAllConciergeTools: () => allowAllConciergeTools(),
  resetAllConciergeTools: () => resetAllConciergeTools(),
}));

// The AI-enhancements gate is its own seam with its own rule tests (services/conciergeAiAccess);
// here it is a dial, so the pane's two states can be rendered without staging an auth store.
const turnOnConciergeAi = vi.fn();
vi.mock("../services/conciergeAiAccess", () => ({
  useConciergeAiAccess: () => aiAccess,
  turnOnConciergeAi: () => turnOnConciergeAi(),
}));

import { ConciergeToolsPane, CONCIERGE_TOOLS_SEARCH_TERMS } from "./ConciergeToolsPane";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import type { ConciergeAiAccess } from "../services/conciergeAiAccess";
import { matchesAny } from "../engine/settingsSearch";
import {
  CONCIERGE_TOOL_CATALOG,
  CONCIERGE_TOOL_GROUPS,
} from "../services/conciergeTools/policy";

/** What the gate reports for the next render. Enhancements are ON unless a test says otherwise. */
let aiAccess: ConciergeAiAccess = { enabled: true, remedy: null };

beforeEach(() => {
  setConciergeToolPolicy.mockClear();
  allowAllConciergeTools.mockClear();
  resetAllConciergeTools.mockClear();
  turnOnConciergeAi.mockClear();
  aiAccess = { enabled: true, remedy: null };
  useSettingsStore.setState({ conciergeToolPolicy: {} });
  useUiStore.setState({ settingsRequest: null, conciergeCopyOnSelection: true });
});
afterEach(cleanup);

/** Any `border…: <n>px …` declaration on the element's inline style, or null if it draws no box.
 *
 *  Reads the serialized attribute rather than `style.border` on purpose: jsdom's CSSOM drops
 *  `border: none` to an empty string, so `style.border === ""` is true both for a link and for a
 *  button that simply never set the shorthand. The width is the tell that survives. */
function borderRule(el: Element): string | null {
  return (el.getAttribute("style") ?? "").match(/border[\w-]*:\s*[^;]*\d+px[^;]*/)?.[0] ?? null;
}

/** The row block for one tool, found by its (monospace) tool name. */
function rowFor(tool: string): HTMLElement {
  const rows = screen.getAllByTestId("concierge-tool-row");
  const row = rows.find((r) => within(r).queryByText(tool));
  if (!row) throw new Error(`no row for ${tool}`);
  return row;
}

describe("the pane lists every tool, grouped by domain", () => {
  it("renders one row per tool in the catalog", () => {
    render(<ConciergeToolsPane />);
    expect(screen.getAllByTestId("concierge-tool-row").length).toBe(CONCIERGE_TOOL_CATALOG.length);
    for (const tool of CONCIERGE_TOOL_CATALOG) {
      expect(screen.getByText(tool.name), tool.name).toBeTruthy();
    }
  });

  it("shows each domain's heading", () => {
    render(<ConciergeToolsPane />);
    for (const group of CONCIERGE_TOOL_GROUPS) {
      expect(screen.getByText(group.label), group.label).toBeTruthy();
    }
  });

  it("shows the risk summary the risk map published, not prose invented here", () => {
    render(<ConciergeToolsPane />);
    const row = rowFor("merge_pr");
    // WORKFLOW_RISK's own summary line.
    expect(within(row).getByText(/Merge an open pull request/)).toBeTruthy();
    expect(within(row).getByText("mutates-main")).toBeTruthy();
  });

  it("advertises its rows in the search terms the rail consumes", () => {
    // The rail can only surface this pane for words the pane actually contains; deriving the terms
    // from the catalog is what keeps that true without anyone maintaining a second list.
    const blob = CONCIERGE_TOOLS_SEARCH_TERMS.join(" ");
    for (const tool of CONCIERGE_TOOL_CATALOG) {
      expect(blob, tool.name).toContain(tool.name);
    }
  });
});

describe("defaulted vs overridden is visible", () => {
  it("marks an untouched row as a default and offers no reset", () => {
    render(<ConciergeToolsPane />);
    const row = rowFor("list_projects");
    expect(within(row).getByText("default")).toBeTruthy();
    expect(within(row).queryByText("set by you")).toBeNull();
    expect(within(row).queryByRole("button", { name: /Reset/ })).toBeNull();
    // read-only → allowed by default, and the row says so in words.
    expect(within(row).getByText(/Runs without asking/)).toBeTruthy();
  });

  it("shows a dangerous tool as asking first, by default", () => {
    render(<ConciergeToolsPane />);
    const row = rowFor("discard_agent");
    expect(within(row).getByText("irreversible")).toBeTruthy();
    expect(within(row).getByText(/Asks you first/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Ask first" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("marks a row the user set, and states the default it departed from", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { push_agent_branch: "allow" } });
    render(<ConciergeToolsPane />);
    const row = rowFor("push_agent_branch");
    expect(within(row).getByText("set by you")).toBeTruthy();
    expect(within(row).queryByText("default")).toBeNull();
    expect(within(row).getByText(/Default: Ask first/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Allow" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("one row's rule does not mark any other row as overridden", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { merge_pr: "deny" } });
    render(<ConciergeToolsPane />);
    expect(screen.getAllByText("set by you").length).toBe(1);
  });
});

describe("writing a rule", () => {
  it("writes the chosen decision through configActions", () => {
    render(<ConciergeToolsPane />);
    fireEvent.click(within(rowFor("merge_pr")).getByRole("button", { name: "Never" }));
    expect(setConciergeToolPolicy).toHaveBeenCalledWith("merge_pr", "deny");
  });

  it("offers all three values on every row", () => {
    render(<ConciergeToolsPane />);
    for (const label of ["Allow", "Ask first", "Never"]) {
      expect(within(rowFor("quit_app")).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("resets by CLEARING the rule, not by writing the default value", () => {
    // The default is derived from the risk class, so writing today's value would freeze it and stop
    // tracking a future reclassification. Clearing is the only honest "use the default".
    useSettingsStore.setState({ conciergeToolPolicy: { quit_app: "allow" } });
    render(<ConciergeToolsPane />);
    fireEvent.click(within(rowFor("quit_app")).getByRole("button", { name: /Reset/ }));
    expect(setConciergeToolPolicy).toHaveBeenCalledWith("quit_app", null);
  });
});

describe("the pane when AI enhancements are off", () => {
  /** The pane, gated on one of the three reasons. */
  function renderGated(remedy: ConciergeAiAccess["remedy"]) {
    aiAccess = { enabled: false, remedy };
    return render(<ConciergeToolsPane />);
  }

  it("says it ONCE, not once per row", () => {
    // Fifty rows are one fact with one remedy — the policy layer reports a single shared cause for
    // exactly this reason. A per-row error would bury the argument for turning it on.
    renderGated("enable-setting");
    expect(screen.getAllByTestId("concierge-ai-gate").length).toBe(1);
    expect(screen.getAllByText(/Requires AI enhancements/).length).toBe(1);
    for (const row of screen.getAllByTestId("concierge-tool-row")) {
      expect(within(row).queryByText(/AI enhancements/)).toBeNull();
    }
  });

  it("still shows every tool, with its real name, risk and effective value", () => {
    // The visible rows ARE the argument for turning enhancements on: this is what you would tune.
    renderGated("enable-setting");
    expect(screen.getAllByTestId("concierge-tool-row").length).toBe(CONCIERGE_TOOL_CATALOG.length);
    const row = rowFor("merge_pr");
    expect(within(row).getByText("mutates-main")).toBeTruthy();
    expect(within(row).getByText(/Merge an open pull request/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Ask first" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("renders the rows read-only", () => {
    renderGated("enable-setting");
    const row = rowFor("merge_pr");
    for (const label of ["Allow", "Ask first", "Never"]) {
      expect(
        (within(row).getByRole("button", { name: label }) as HTMLButtonElement).disabled,
        label,
      ).toBe(true);
    }
    expect(within(row).getByTestId("concierge-tool-readonly")).toBeTruthy();
  });

  it("refuses to write a rule even if a click gets through", () => {
    renderGated("enable-setting");
    fireEvent.click(within(rowFor("merge_pr")).getByRole("button", { name: "Never" }));
    expect(setConciergeToolPolicy).not.toHaveBeenCalled();
  });

  it("KEEPS the user's saved rules — shown as theirs, and restored when enhancements come back", () => {
    // A settings pane that quietly discards someone's configuration is unforgivable. Gating is a
    // presentation state; it must never touch what they saved.
    useSettingsStore.setState({ conciergeToolPolicy: { push_agent_branch: "allow" } });
    const view = renderGated("buy-app");

    const gatedRow = rowFor("push_agent_branch");
    expect(within(gatedRow).getByText("set by you")).toBeTruthy();
    expect(
      within(gatedRow).getByRole("button", { name: "Allow" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(gatedRow).getByText(/Default: Ask first/)).toBeTruthy();
    // Nothing was cleared behind their back.
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ push_agent_branch: "allow" });
    expect(setConciergeToolPolicy).not.toHaveBeenCalled();

    // Enhancements come back on: the same rule, still theirs, now editable again.
    aiAccess = { enabled: true, remedy: null };
    view.rerender(<ConciergeToolsPane />);
    const liveRow = rowFor("push_agent_branch");
    expect(within(liveRow).getByText("set by you")).toBeTruthy();
    const allow = within(liveRow).getByRole("button", { name: "Allow" }) as HTMLButtonElement;
    expect(allow.getAttribute("aria-pressed")).toBe("true");
    expect(allow.disabled).toBe(false);
    expect(screen.queryByTestId("concierge-ai-gate")).toBeNull();
  });

  it("keeps a hand-edited row's warning legible while gated", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { list_projects: "allwo" } });
    renderGated("top-up");
    expect(within(rowFor("list_projects")).getByText(/unreadable/)).toBeTruthy();
  });
});

describe("the [Turn on] action routes to the right remedy", () => {
  it("feature flag off: turns the setting on", () => {
    aiAccess = { enabled: false, remedy: "enable-setting" };
    render(<ConciergeToolsPane />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(turnOnConciergeAi).toHaveBeenCalledTimes(1);
    // Not a purchase — the switch is theirs and free.
    expect(screen.queryByRole("button", { name: /Unlock Sparkle/ })).toBeNull();
  });

  it("not entitled: offers the existing $99 paywall", () => {
    aiAccess = { enabled: false, remedy: "buy-app" };
    render(<ConciergeToolsPane />);
    expect(screen.getByRole("button", { name: /Unlock Sparkle/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("entitled but out of credits: offers top-up and NEVER the buy-the-app upsell", () => {
    // Selling the $99 app to somebody who already owns it is the wrong-copy failure this guards.
    aiAccess = { enabled: false, remedy: "top-up" };
    render(<ConciergeToolsPane />);
    expect(screen.queryByRole("button", { name: /Unlock Sparkle/ })).toBeNull();
    expect(screen.queryByText(/\$99/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add credits/ }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  it("shows no banner at all once enhancements are live", () => {
    render(<ConciergeToolsPane />);
    expect(screen.queryByTestId("concierge-ai-gate")).toBeNull();
    expect(screen.queryByTestId("concierge-tool-readonly")).toBeNull();
  });
});

describe("a hand-edited config value the policy layer can't read", () => {
  it("highlights nothing, warns, and reports that it will ask first", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { list_projects: "allwo" } });
    render(<ConciergeToolsPane />);
    const row = rowFor("list_projects");
    expect(within(row).getByText(/unreadable/)).toBeTruthy();
    // No button claims to be the current value — the file holds something none of them mean.
    for (const label of ["Allow", "Ask first", "Never"]) {
      expect(
        within(row).getByRole("button", { name: label }).getAttribute("aria-pressed"),
        label,
      ).toBe("false");
    }
    expect(within(row).getByText(/asking first until it's fixed/)).toBeTruthy();
    // Still recoverable in one click.
    expect(within(row).getByRole("button", { name: /Reset/ })).toBeTruthy();
  });
});

describe("the 'Copy on selection' preference (PRD 1 §1)", () => {
  const checkbox = () => screen.getByRole("checkbox", { name: "Copy on selection" });

  it("is ON by default and toggles the uiStore preference", () => {
    render(<ConciergeToolsPane />);
    // Default ON: an affordance nobody switches on is one nobody has.
    expect(checkbox().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(checkbox());
    expect(useUiStore.getState().conciergeCopyOnSelection).toBe(false);
    expect(checkbox().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox());
    expect(useUiStore.getState().conciergeCopyOnSelection).toBe(true);
  });

  it("does NOT round-trip through configActions — it is a presentation preference", () => {
    // The codebase's split: behavioral / billable / agent-facing flags go to config.toml via
    // configActions; presentation flags live in the `sparkle-ui` blob. This one changes what a
    // gesture in one column does and nothing else.
    render(<ConciergeToolsPane />);
    fireEvent.click(checkbox());
    expect(setConciergeToolPolicy).not.toHaveBeenCalled();
  });

  it("stays usable when AI enhancements are off", () => {
    // Every tool row below is read-only while the concierge can't act. This control isn't about
    // what the concierge may do, so the gate has no business over it.
    aiAccess = { enabled: false, remedy: "enable-setting" };
    render(<ConciergeToolsPane />);
    fireEvent.click(checkbox());
    expect(useUiStore.getState().conciergeCopyOnSelection).toBe(false);
  });

  it("is findable from the ⋯ settings search", () => {
    // The rail matches a query against these entries (engine/settingsSearch); a setting nobody can
    // search for is a setting nobody finds.
    for (const query of ["copy on selection", "clipboard", "copy answer markdown"]) {
      expect(matchesAny(CONCIERGE_TOOLS_SEARCH_TERMS, query), query).toBe(true);
    }
  });
});

describe("the auto-send tuner has a real switch", () => {
  it("renders a toggle, so the default-off flag is opt-in rather than unreachable", () => {
    // Without this row the flag has no setter call anywhere in the app: it ships false and nothing
    // can flip it, which retires the entire §4e path into code that can never run. A gate with no
    // switch is not consent, it is deletion.
    useUiStore.setState({ conciergeAutoSendTuner: false });
    render(<ConciergeToolsPane />);
    const sw = screen.getByRole("checkbox", { name: /Help tune auto-send/i });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(sw);
    expect(useUiStore.getState().conciergeAutoSendTuner).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LAYOUT. jsdom has no layout engine, so nothing here can measure a pixel — what it CAN pin is the
// structure that makes the pixels come out right, and every assertion below fails against the
// pane as it was: the options used to sit in a `flexWrap: "wrap"` bag with no reserved width, which
// dropped "Never" onto a second line on 38 of 62 rows in the running app and left "Allow" starting
// at three different x-positions down the page. The measurement itself is a browser job
// (scripts/visual) — this is the contract that measurement verifies.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the three options are ONE segmented control, on one line", () => {
  const segmentIn = (tool: string) =>
    within(rowFor(tool)).getByTestId("concierge-tool-segment") as HTMLElement;

  it("puts all three options inside a single control that cannot wrap", () => {
    render(<ConciergeToolsPane />);
    const seg = segmentIn("merge_pr");
    expect(seg.style.flexWrap).toBe("nowrap");
    // Every option is INSIDE it — an option outside the segment is an option that can wrap away.
    const labels = [...seg.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Allow", "Ask first", "Never"]);
  });

  it("reserves a FIXED width for the segment, so it can't be squeezed by a long summary", () => {
    render(<ConciergeToolsPane />);
    const seg = segmentIn("delete_agent_branch_if_merged");
    // A fixed px basis, not `auto` — auto is what let the description column win the argument.
    expect(seg.style.flex).toMatch(/^0 0 \d+px$/);
    expect(seg.style.width).toMatch(/^\d+px$/);
  });

  it("keeps the row itself from wrapping the controls onto their own line", () => {
    render(<ConciergeToolsPane />);
    expect((rowFor("merge_pr").style as CSSStyleDeclaration).flexWrap).toBe("nowrap");
  });

  it("gives every row the SAME control width — with a Reset and without one", () => {
    // This is the vertical-alignment requirement stated structurally: a row that carries a Reset
    // must not push its segment left. The slot is reserved either way.
    useSettingsStore.setState({ conciergeToolPolicy: { merge_pr: "deny" } });
    render(<ConciergeToolsPane />);
    const withReset = within(rowFor("merge_pr")).getByTestId("concierge-tool-control");
    const without = within(rowFor("quit_app")).getByTestId("concierge-tool-control");
    expect(within(withReset).queryByRole("button", { name: /^Reset merge_pr/ })).toBeTruthy();
    expect(within(without).queryByRole("button", { name: /Reset/ })).toBeNull();
    expect(withReset.style.flex).toMatch(/^0 0 \d+px$/);
    expect(without.style.flex).toBe(withReset.style.flex);
  });

  it("keeps the gated read-only glyph OUT of the reserved control column", () => {
    // Inside it, the glyph would eat the Reset slot on every gated row and shift the segment —
    // the same alignment bug in a smaller costume.
    aiAccess = { enabled: false, remedy: "enable-setting" };
    render(<ConciergeToolsPane />);
    const row = rowFor("merge_pr");
    const control = within(row).getByTestId("concierge-tool-control");
    expect(within(row).getByTestId("concierge-tool-readonly")).toBeTruthy();
    expect(within(control).queryByTestId("concierge-tool-readonly")).toBeNull();
  });
});

describe("Reset is a link, not a fourth button", () => {
  it("carries no border and no fill, and sits inline with the segment", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { quit_app: "allow" } });
    render(<ConciergeToolsPane />);
    const row = rowFor("quit_app");
    const reset = within(row).getByRole("button", { name: /^Reset quit_app/ }) as HTMLButtonElement;
    // It used to be drawn with the very same bordered box as Allow / Ask first / Never — i.e. with
    // a `1px solid …` rule around it. Asserted on the serialized declaration rather than
    // `style.border`, which jsdom normalizes `none` away to "" and so cannot distinguish "no
    // border" from "no border property".
    expect(borderRule(reset)).toBeNull();
    expect(reset.style.background).toBe("transparent");
    expect(reset.style.padding).toBe("0px");
    // Muted-until-hover can't be an inline style; the class is where that lives (index.css).
    expect(reset.className).toContain("settings-link-btn");
    // Inline with the segment: same control cell, but not one of the three options.
    const control = within(row).getByTestId("concierge-tool-control");
    expect(control.contains(reset)).toBe(true);
    expect(within(row).getByTestId("concierge-tool-segment").contains(reset)).toBe(false);
  });

  it("still resets by CLEARING the rule", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { quit_app: "allow" } });
    render(<ConciergeToolsPane />);
    fireEvent.click(within(rowFor("quit_app")).getByRole("button", { name: /^Reset quit_app/ }));
    expect(setConciergeToolPolicy).toHaveBeenCalledWith("quit_app", null);
  });
});

describe("the one bulk control at the top", () => {
  const allowBtn = () =>
    within(screen.getByTestId("concierge-bulk-bar")).getByRole("button", {
      name: "Allow everything",
    }) as HTMLButtonElement;
  const resetAllBtn = () =>
    within(screen.getByTestId("concierge-bulk-bar")).getByRole("button", {
      name: "Reset all to defaults",
    }) as HTMLButtonElement;
  const confirm = () => screen.getByTestId("concierge-bulk-confirm");

  it("offers exactly one allow-everything control — no routine/everything variants", () => {
    // A second variant hands back the decision the button exists to skip.
    render(<ConciergeToolsPane />);
    const bar = screen.getByTestId("concierge-bulk-bar");
    const labels = [...bar.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Reset all to defaults", "Allow everything"]);
  });

  it("does NOT apply until the confirmation is accepted", () => {
    render(<ConciergeToolsPane />);
    fireEvent.click(allowBtn());
    expect(allowAllConciergeTools).not.toHaveBeenCalled();
    expect(confirm()).toBeTruthy();
  });

  it("names the real count of IRREVERSIBLE tools, derived from the catalog", () => {
    // The count is what the taxonomy is FOR: telling someone what they are about to hand over
    // silently. A number typed into the copy would go stale the first time a tool is reclassified.
    render(<ConciergeToolsPane />);
    fireEvent.click(allowBtn());
    const irreversible = CONCIERGE_TOOL_CATALOG.filter((t) => t.riskClass === "irreversible");
    const text = confirm().textContent ?? "";
    expect(text).toContain(`${irreversible.length} irreversible tools`);
    expect(text).toContain(`All ${CONCIERGE_TOOL_CATALOG.length} tools`);
    // And it names some of them: a bare statistic is easy to click past.
    expect(irreversible.some((t) => text.includes(t.name))).toBe(true);
  });

  it("cancelling changes nothing", () => {
    render(<ConciergeToolsPane />);
    fireEvent.click(allowBtn());
    fireEvent.click(within(confirm()).getByRole("button", { name: "Cancel" }));
    expect(allowAllConciergeTools).not.toHaveBeenCalled();
    expect(screen.queryByTestId("concierge-bulk-confirm")).toBeNull();
  });

  it("confirming applies it once and closes", () => {
    render(<ConciergeToolsPane />);
    fireEvent.click(allowBtn());
    fireEvent.click(within(confirm()).getByRole("button", { name: "Allow everything" }));
    expect(allowAllConciergeTools).toHaveBeenCalledTimes(1);
    expect(resetAllConciergeTools).not.toHaveBeenCalled();
    expect(screen.queryByTestId("concierge-bulk-confirm")).toBeNull();
  });

  it("offers Reset all to defaults as a link, disabled when there is nothing to reset", () => {
    render(<ConciergeToolsPane />);
    expect(resetAllBtn().disabled).toBe(true);
    expect(resetAllBtn().className).toContain("settings-link-btn");
    expect(borderRule(resetAllBtn())).toBeNull();
  });

  it("enables Reset all once rules exist, and says how many it would clear", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { merge_pr: "deny", quit_app: "allow" } });
    render(<ConciergeToolsPane />);
    expect(resetAllBtn().disabled).toBe(false);
    fireEvent.click(resetAllBtn());
    expect(confirm().textContent).toContain("all 2 rules");
    fireEvent.click(within(confirm()).getByRole("button", { name: "Reset all" }));
    expect(resetAllConciergeTools).toHaveBeenCalledTimes(1);
    expect(allowAllConciergeTools).not.toHaveBeenCalled();
  });

  it("is gated with the rows — the concierge that can't act can't be granted everything", () => {
    aiAccess = { enabled: false, remedy: "enable-setting" };
    useSettingsStore.setState({ conciergeToolPolicy: { merge_pr: "deny" } });
    render(<ConciergeToolsPane />);
    expect(allowBtn().disabled).toBe(true);
    expect(resetAllBtn().disabled).toBe(true);
    fireEvent.click(allowBtn());
    expect(screen.queryByTestId("concierge-bulk-confirm")).toBeNull();
    expect(allowAllConciergeTools).not.toHaveBeenCalled();
  });

  it("leaves EVERY row legible and undoable after a bulk grant", () => {
    // The PRD's requirement, read off the rendered pane: a bulk apply writes an explicit rule per
    // tool, so no row is left saying "default" with no way back.
    useSettingsStore.setState({
      conciergeToolPolicy: Object.fromEntries(
        CONCIERGE_TOOL_CATALOG.map((t) => [t.name, "allow" as const]),
      ),
    });
    render(<ConciergeToolsPane />);
    expect(screen.getAllByText("set by you").length).toBe(CONCIERGE_TOOL_CATALOG.length);
    expect(screen.queryAllByText("default").length).toBe(0);
    const resets = screen
      .getAllByTestId("concierge-tool-row")
      .filter((r) => within(r).queryByRole("button", { name: /^Reset \w+ to its default$/ }));
    expect(resets.length).toBe(CONCIERGE_TOOL_CATALOG.length);
  });
});

describe("the gate closing CANCELS a pending bulk confirmation", () => {
  // `gated` is a live read — the AI-features flag, entitlement, and a credit balance a background
  // `me` refresh can move — so it flips on its own while a dialog is up.
  it("takes the confirmation down, and does NOT bring it back when credit returns", () => {
    const view = render(<ConciergeToolsPane />);
    fireEvent.click(
      within(screen.getByTestId("concierge-bulk-bar")).getByRole("button", {
        name: "Allow everything",
      }),
    );
    expect(screen.getByTestId("concierge-bulk-confirm")).toBeTruthy();

    // A balance poll drops them under the credit floor. The scrim vanishes, which the human reads
    // as "cancelled".
    aiAccess = { enabled: false, remedy: "top-up" };
    view.rerender(<ConciergeToolsPane />);
    expect(screen.queryByTestId("concierge-bulk-confirm")).toBeNull();
    expect(screen.getByTestId("concierge-ai-gate")).toBeTruthy();

    // The next poll restores it. THE INTENT MUST BE GONE TOO: hiding the dialog without clearing
    // `pending` resurrects a destructive 62-rule confirmation over the pane, primary button live,
    // from a gesture nobody re-initiated — one stray Enter from granting every irreversible tool.
    aiAccess = { enabled: true, remedy: null };
    view.rerender(<ConciergeToolsPane />);
    expect(screen.queryByTestId("concierge-bulk-confirm")).toBeNull();
    // And the pane really is live again — otherwise the line above would pass for the wrong reason.
    expect(
      (
        within(screen.getByTestId("concierge-bulk-bar")).getByRole("button", {
          name: "Allow everything",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
