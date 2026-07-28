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
vi.mock("../services/configActions", () => ({
  setConciergeToolPolicy: (...a: unknown[]) => setConciergeToolPolicy(...a),
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
import {
  CONCIERGE_TOOL_CATALOG,
  CONCIERGE_TOOL_GROUPS,
} from "../services/conciergeTools/policy";

/** What the gate reports for the next render. Enhancements are ON unless a test says otherwise. */
let aiAccess: ConciergeAiAccess = { enabled: true, remedy: null };

beforeEach(() => {
  setConciergeToolPolicy.mockClear();
  turnOnConciergeAi.mockClear();
  aiAccess = { enabled: true, remedy: null };
  useSettingsStore.setState({ conciergeToolPolicy: {} });
  useUiStore.setState({ settingsRequest: null });
});
afterEach(cleanup);

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
