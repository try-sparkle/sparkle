// @vitest-environment jsdom
//
// The redesigned settings dialog (the ⋯ menu): a left rail of categories driving a single
// right pane. We assert the default pane, that clicking a category swaps the pane, and that
// the close affordance fires onClose. The individual controls have their own tests; here we
// only care about the rail/pane shell.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_MONO, TYPE, WEIGHT } from "../theme/scale";
import {
  noteConciergeAuditCall,
  useConciergeAudit,
  _resetConciergeAuditForTests,
} from "../services/conciergeAudit";
import {
  clearConciergeApprovals,
  requestApproval,
  useConciergeApprovals,
} from "../stores/conciergeApprovals";

// Controls inside the panes persist to config.toml via these actions; mock so no IPC fires
// when a pane mounts or a control is touched. PARTIAL (spreads the real module) because this
// dialog renders whole panes: an exhaustive factory silently makes every export it forgot
// `undefined`, and the Tools pane calls one of them in a mount effect — so a forgotten name is a
// crash on render in a file that is not even about that pane.
vi.mock("../services/configActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/configActions")>()),
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  // Every OTHER writer the rendered panes can reach, too. The spread protects against a name this
  // file forgot; these protect against the real writer RUNNING — setPluginEnabled and
  // setRoborevEnabled kick installers, not just a config write, so a future test that clicks one
  // of those switches would shell out for real and fail as a swallowed rejection.
  setPluginEnabled: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
  setBuilderIndexEnabled: vi.fn().mockResolvedValue(undefined),
  refreshPluginInstallState: vi.fn().mockResolvedValue(undefined),
}));
// (The notification and auto-update toggles are settingsStore actions, not configActions exports —
// store-only, no IPC — so there is nothing to stub for them.)

// The Tools pane's Learn-more links open the system browser via plugin-opener; mock so no IPC
// fires when that pane mounts or a link is clicked.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

// The Accounts pane's Sparkle-account block calls these (Tauri IPC / system browser); mock
// the two it fires so no IPC or browser launch happens under jsdom.
vi.mock("../services/sparkleApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sparkleApi")>();
  return {
    ...actual,
    openSignIn: vi.fn().mockResolvedValue(true),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
});

// The Credits pane has its own component tests (CreditsPanel.test.tsx); the shell test only
// cares that deep-open lands on the right category, so keep the pane body inert here.
vi.mock("./CreditsPanel", () => ({ CreditsPanel: () => null }));

// The Accounts pane's Install ID row calls the Rust trial meter over IPC. Mock it so no IPC
// fires under jsdom; each test drives the resolved/rejected value it needs.
vi.mock("../services/trialApi", () => ({ fetchTrial: vi.fn() }));

// The 1Password pane probes the `op` CLI and lists vaults over IPC on mount. It has its own
// component tests; the shell test only cares that the category routes to it, so keep it inert.
vi.mock("./OnePasswordPane", () => ({
  OnePasswordPane: () => <div data-testid="onepassword-pane" />,
}));

import { openSignIn, signOut } from "../services/sparkleApi";
import { fetchTrial } from "../services/trialApi";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ me: null, tokenPresent: false, loading: true });
  useSettingsStore.setState({ onepasswordEnabled: false });
});

const heading = (name: string) => screen.queryByRole("heading", { name });

describe("SettingsDialog", () => {
  it("opens on the AI features pane by default", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    expect(heading("Notifications")).toBeNull();
  });

  it("opens on the requested pane when initialCategory is given (deep-open)", () => {
    render(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("follows an initialCategory change while already open (deep-open into an open dialog)", () => {
    const { rerender } = render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    rerender(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
  });

  it("swaps the pane when a rail category is clicked", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(heading("Notifications")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("the Voice controls pane LEADS with the microphone-input picker", () => {
    // The other end of the move that took the picker out of the mic hover menu (roborev 56208).
    // MicButton.test.tsx proves it is no longer mounted THERE; without this, both halves are
    // satisfied by the picker being mounted nowhere at all — it renders beautifully in its own test
    // file either way, because that file mounts it directly.
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="voice" />);
    const picker = screen.getByRole("group", { name: "Microphone input device" });
    // LEADS is the load-bearing word: "which microphone am I on, and can it hear my calls" is the
    // question people open this pane with, so it precedes the explanation of the send tray. The
    // wake/stop-word controls this used to be measured against are gone (VoiceControlsMenu), so the
    // anchor is now the copy that replaced them — still a real element, still positional.
    const trayCopy = screen.getByText("How Sparkle listens");
    expect(picker.compareDocumentPosition(trayCopy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks the selected rail item with aria-current", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  // The search box was excluded from the repaint's border sweep as "already zero-contrast", which
  // was only true of its border against its OWN fill. The field was a `deepForest` well sunk into a
  // `forest` rail, and that pair fell from 1.50:1 to 1.11:1 — so post-repaint the box had no
  // boundary at all, inner or outer.
  //
  // THE TOKENS CHANGED AND THE CLAIM DID NOT. Three shell tokens had been borrowed for a dialog
  // control because the spec's own pair — `inputSurface` and `inputEdge` — was mirrored into
  // index.css but never exposed on `C`, so no component could reach it. The invariant asserted here
  // is the same one, and it is still the interesting one: the field has a fill, it has a border, and
  // the border is NOT the fill. What is new is that both now come from the tokens the design has for
  // a field, so retuning the shell's column seam can no longer restyle every input in the app.
  it("the search field keeps a visible boundary: an input edge over the input surface", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    const search = screen.getByLabelText("Search settings") as HTMLInputElement;
    expect(search.style.background).toBe("var(--c-input-surface)");
    expect(search.style.border).toContain("var(--c-input-edge)");
    expect(search.style.border).not.toContain("var(--c-input-surface)");
    // and it is no longer wearing the shell's seam
    expect(search.style.border).not.toContain("var(--c-hairline)");
  });

  // ── THE RAIL WAS PAINTED IN THE TERMINAL PLANE ────────────────────────────────────────────────
  // `C.forest` is the terminal's colour — the darkest surface in the app — and the settings rail had
  // it because no dialog token was wired for a component to reach. Against the dialog body that is a
  // step far over the fill ceiling the direction sets for adjacent registers, which is the
  // "separated by fill" defect in reverse: not a panel someone darkened, but one that started that
  // way. `dialogNav` is a hair off the body and the rule between them does the dividing.
  it("the category rail takes the dialog's nav surface, not the terminal plane", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    const rail = screen.getByRole("navigation", { name: "Settings categories" });
    expect(rail.style.background).toBe("var(--c-dialog-nav)");
    expect(rail.style.background).not.toContain("forest");
  });

  it("the dialog floats on the modal plane with the spec's edge, scrim and shadow", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    const box = screen.getByRole("dialog", { name: "Settings" });
    expect(box.style.background).toBe("var(--c-dialog-surface)");
    expect(box.style.border).toBe("1px solid var(--c-dialog-edge)");
    // The two constants every dialog used to hand-type, unthemed.
    expect(box.style.boxShadow).toBe("var(--k-shadow)");
    expect(screen.getByTestId("settings-backdrop").style.background).toBe("var(--k-scrim)");
  });

  // ── THE SELECTION CARRIES THREE SIGNALS, NOT TWO ──────────────────────────────────────────────
  // The spec's `.dlg .nav .item.on` sets `background` + `color` + `font-weight`, and the first cut
  // of this reskin shipped only the first two. That left the FILL doing the most visible work, and
  // measured on this palette the fill is under the edge floor in light mode — the selected category
  // was a weaker signal than a hairline (roborev 54686). The ink and the weight are what actually
  // read; this pins all three so a future tidy-up cannot quietly drop one again.
  it("the selected rail item is marked by fill, ink AND weight", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    const selected = screen.getByRole("button", { name: "AI features" });
    const other = screen.getByRole("button", { name: "Appearance" });
    expect(selected.style.background).toBe("var(--c-chat-bubble-active)");
    expect(selected.style.color).toBe("var(--c-cream)");
    expect(selected.style.fontWeight).toBe(String(WEIGHT.med));
    // …and an unselected row carries none of the three, or the contrast is not a contrast.
    expect(other.style.background).toBe("transparent");
    expect(other.style.color).toBe("var(--c-muted)");
    expect(other.style.fontWeight).toBe("");
  });

  // The LABEL treatment — mono, uppercase, tracked — is the direction's most characteristic mark and
  // the app carried none of it. These were 12px semibold SANS headings, which is a different
  // typographic idea: a small heading rather than an instrument's engraved legend.
  it("a pane's sub-labels use the mono LABEL treatment, not a sans heading", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const label = screen.getByText("Theme");
    expect(label.style.fontFamily).toBe(FONT_MONO);
    expect(label.style.textTransform).toBe("uppercase");
    expect(label.style.letterSpacing).toBe("0.1em");
    expect(label.style.fontSize).toBe(`${TYPE.micro}px`);
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("fires onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes the Accounts pane button to onManageAccounts", () => {
    const onManageAccounts = vi.fn();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={onManageAccounts} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(screen.getByRole("button", { name: /Manage accounts/ }));
    expect(onManageAccounts).toHaveBeenCalledTimes(1);
  });

  it("has a Tools category that opens the Tools pane", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(heading("Tools")).toBeTruthy();
    // The pane renders both groups.
    expect(screen.getByText("Your tools")).toBeTruthy();
    expect(screen.getByText("Built into Sparkle")).toBeTruthy();
  });
});

// The 1Password category follows its Tools switch. Without this pane the feature is unreachable:
// the vault picker, the per-file backup table and the worktree-seeding consent all live here, so
// "the switch is on but the pane never mounts" is the shipping failure these pin.
describe("SettingsDialog — 1Password category (follows the Tools switch)", () => {
  const OP_LABEL = "1Password";
  const enableOp = () => useSettingsStore.setState({ onepasswordEnabled: true });

  it("is absent from the rail, from search, and from deep-linking while the tool is off", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="onepassword" />);
    expect(screen.queryByRole("button", { name: OP_LABEL })).toBeNull();
    // A deep link to a category this install doesn't have falls back to the first pane.
    expect(heading("AI features")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "vault" } });
    expect(screen.queryByRole("button", { name: OP_LABEL })).toBeNull();
  });

  it("appears and renders the 1Password pane once the tool is switched on", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: OP_LABEL }));
    expect(heading(OP_LABEL)).toBeTruthy();
    expect(screen.getByTestId("onepassword-pane")).toBeTruthy();
  });

  it("resolves a onepassword DEEP LINK straight to the pane", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="onepassword" />);
    expect(heading(OP_LABEL)).toBeTruthy();
    expect(screen.getByTestId("onepassword-pane")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("is reachable by searching for what it does ('dotenv', 'secrets') when enabled", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "dotenv" } });
    expect(screen.getByRole("button", { name: OP_LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
  });
});

// The cloudauth pane is ALWAYS present now. It used to be filtered on the same capability the cloud
// gate read, which hid it exactly when it was needed: the gate's `no_auth` block deep-links HERE, so
// a filtered-out destination meant the one button offered to a blocked user silently resolved to
// `categories[0]` — the AI pane. Saving a Claude credential ahead of time is reasonable anyway.
describe("SettingsDialog — cloudauth category", () => {
  const CLOUD_LABEL = "Claude auth for cloud agents";
  const enableCloud = () =>
    useAuthStore.setState({
      tokenPresent: true,
      loading: false,
      me: {
        clerkUserId: "user_1",
        entitled: true,
        balanceCents: 5000,
        tokenVersion: 1,
        cloudAgentsEnabled: true,
      },
    });

  // THE BUG THIS PINS: an account with no advertised capability is precisely the one whose gate
  // says "Add your Claude authentication" and deep-links to cloudauth. If the pane is missing, that
  // button lands on the wrong screen and the block is unfixable.
  it("resolves a cloudauth deep link even when /me carries no cloud capability", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="cloudauth" />);
    expect(screen.getByRole("button", { name: CLOUD_LABEL })).toBeTruthy();
    expect(heading(CLOUD_LABEL)).toBeTruthy();
    expect(screen.getByTestId("cloudauth-current")).toBeTruthy();
    // It must NOT have fallen back to the first pane, which is what used to happen.
    expect(heading("AI features")).toBeNull();
  });

  it("is findable by search without the capability", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "cloud" } });
    expect(screen.getByRole("button", { name: CLOUD_LABEL })).toBeTruthy();
  });

  it("appears and renders the Claude-auth pane once the server advertises the capability", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: CLOUD_LABEL }));
    expect(heading(CLOUD_LABEL)).toBeTruthy();
    expect(screen.getByTestId("cloudauth-current")).toBeTruthy();
  });

  it("resolves a cloudauth DEEP LINK straight to the pane (gating.ts's deepLink target)", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="cloudauth" />);
    expect(heading(CLOUD_LABEL)).toBeTruthy();
    expect(screen.getByTestId("cloudauth-current")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("is reachable by searching for 'byok' / 'sandbox' when enabled", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "byok" } });
    expect(screen.getByRole("button", { name: CLOUD_LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
  });

  // Signed out too. There is nothing account-specific behind this pane — it is a place to save a
  // credential — and hiding it would only re-create the dead end for the user who has just been
  // told to come here.
  it("is present for a signed-OUT user", () => {
    useAuthStore.setState({ tokenPresent: false, loading: false, me: null });
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(screen.getByRole("button", { name: CLOUD_LABEL })).toBeTruthy();
  });
});

// The rail search: filters the CATEGORIES by label OR their keyword set. A category with no
// visible name match still surfaces via a contained tool's keyword (e.g. "github" → Tools).
describe("SettingsDialog — rail search", () => {
  const search = () => screen.getByLabelText("Search settings") as HTMLInputElement;
  const railButton = (name: string) => screen.queryByRole("button", { name });

  it("filters the rail to categories whose LABEL matches", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "notif" } });
    expect(railButton("Notifications")).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
    expect(railButton("Workers")).toBeNull();
  });

  it("surfaces a category via a CONTAINED item keyword, not just its label", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // "github" isn't any category's label — it's a tool inside Tools. It must still surface Tools.
    fireEvent.change(search(), { target: { value: "github" } });
    expect(railButton("Tools")).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
  });

  it("surfaces BOTH Voice controls and Tools for 'voice' (label + keyword)", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "voice" } });
    expect(railButton("Voice controls")).toBeTruthy(); // label match
    expect(railButton("Tools")).toBeTruthy(); // Deepgram keyword match
    expect(railButton("Workers")).toBeNull();
  });

  it("matches a MULTI-WORD query per term, not as one adjacent phrase", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // "talk" and "microphone" both live in Voice controls' keywords but not next to each other, so
    // the old raw-substring match found nothing and the user got "No settings match" for a query
    // that describes exactly one category. (This used to be spelled with "wake", a term the pane no
    // longer carries now that the wake word is retired — the SEARCH behaviour under test is
    // unchanged; only the words that reach it are.)
    fireEvent.change(search(), { target: { value: "talk microphone" } });
    expect(railButton("Voice controls")).toBeTruthy();
    expect(railButton("Workers")).toBeNull();
    // Every term is still REQUIRED — this is a filter, not a fuzzy any-of.
    fireEvent.change(search(), { target: { value: "talk keyboard" } });
    expect(railButton("Voice controls")).toBeNull();
  });

  it("matches a query that mixes a category's LABEL with one of its keywords", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // The natural way to search: name the thing, then the detail. These span label and keywords,
    // which a strictly per-entry match would split apart — and did, for a while, on every category
    // whose pane doesn't filter rows.
    for (const [q, label] of [
      ["mobile pair", "Mobile"],
      ["voice dictation", "Voice controls"],
      ["shortcuts hotkeys", "Shortcuts"],
    ] as const) {
      fireEvent.change(search(), { target: { value: q } });
      expect(railButton(label), `searching "${q}" must still find ${label}`).toBeTruthy();
    }
  });

  it("does NOT surface Tools for terms that live in different rows", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // Tools is the one category whose pane filters its own rows, so the rail has to ask the pane's
    // question: is there ONE row with all these terms? "deepgram" and "beads" are different rows —
    // surfacing Tools here would open a pane that immediately renders "No tools match".
    fireEvent.change(search(), { target: { value: "deepgram beads" } });
    expect(railButton("Tools")).toBeNull();
    // …while a query inside a single row still surfaces it.
    fireEvent.change(search(), { target: { value: "deepgram dictation" } });
    expect(railButton("Tools")).toBeTruthy();
  });

  /** Rows currently rendered by the Tools pane, counted from the DOM. */
  const toolRows = () => screen.queryAllByTestId("tool-row").length;

  it("searching a category's NAME opens its pane with EVERY row, not an empty one", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();
    expect(unfiltered).toBeGreaterThan(0);

    // No Tools row contains the word "tools" — it is the category's LABEL, not row text. The rail
    // surfaces Tools (right), and the pane must then show its rows rather than filtering them all
    // away, which is what forwarding the query verbatim did.
    fireEvent.change(search(), { target: { value: "tools" } });
    expect(railButton("Tools")).toBeTruthy();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    // EVERY row, counted — "some switch exists" would also pass for a partial-clear regression.
    expect(toolRows()).toBe(unfiltered);
  });

  it("narrows inside a category when the query names it AND a row", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    // "tools github" is how people actually search: name the category, then narrow inside it. The
    // rail has to keep the category (dropping it is worse than an empty pane — the user loses the
    // route entirely) and the pane has to filter by the part that isn't the label.
    fireEvent.change(search(), { target: { value: "tools github" } });
    expect(railButton("Tools"), 'the rail must still offer Tools for "tools github"').toBeTruthy();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    expect(toolRows()).toBeGreaterThan(0);
    expect(toolRows(), "the row filter must still apply to the non-label terms").toBeLessThan(unfiltered);
  });

  it("keeps narrowing when the query matches NOTHING, instead of swinging back to every row", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    fireEvent.change(search(), { target: { value: "deepgram" } });
    const narrowed = toolRows();
    expect(narrowed).toBeLessThan(unfiltered);

    // One more character and the query matches nothing anywhere. That is still a query about THIS
    // pane — the user narrowed past the last row — so it must show its empty state, not swing back
    // to every row. Standing down on "the filter came back empty" did exactly that.
    fireEvent.change(search(), { target: { value: "deepgramx" } });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
    expect(toolRows(), "the pane must not expand when a query stops matching").toBeLessThanOrEqual(narrowed);
    expect(screen.queryByText(/No tools match/)).toBeTruthy();

    // Same in the label form, where the label terms are stripped before filtering.
    fireEvent.change(search(), { target: { value: "tools deepgramx" } });
    expect(toolRows()).toBeLessThanOrEqual(narrowed);
  });

  it("leaves the pane you're standing in alone when the query is about a different category", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    // Typing "credits" while on Tools narrows the rail to Credits — correct — but the Tools pane is
    // still mounted. The query was never about its rows, so filtering them to nothing and rendering
    // "No tools match" would be a dead end in the pane the user is actually looking at.
    fireEvent.change(search(), { target: { value: "credits" } });
    expect(railButton("Credits")).toBeTruthy();
    expect(railButton("Tools")).toBeNull();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    expect(toolRows()).toBe(unfiltered);
  });

  it("shows an empty state when nothing matches", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "zzzzznope" } });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
  });

  it("restores the full rail when the query is cleared", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "notif" } });
    expect(railButton("AI features")).toBeNull();
    fireEvent.change(search(), { target: { value: "" } });
    expect(railButton("AI features")).toBeTruthy();
    expect(railButton("Tools")).toBeTruthy();
  });
});

// The Sparkle-account block in the Accounts pane. State is driven by the real zustand auth
// store (set directly per test); the sparkleApi calls it fires are mocked above.
describe("SettingsDialog — Sparkle account", () => {
  const openAccountsPane = () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  };
  const me = {
    clerkUserId: "user_123",
    entitled: true,
    balanceCents: 500,
    tokenVersion: 1,
    email: "ada@example.com",
    name: "Ada Lovelace",
  };

  it("shows the signed-in identity (name, via the shared authIdentity) and signs out via sparkleApi + store reset", async () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    // Uses the SAME authIdentity source as the TopBar avatar/label (name → email), so the pane and
    // the top bar can't disagree; with a name present it shows the name, not the email.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(useAuthStore.getState().tokenPresent).toBe(false));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().me).toBeNull();
    // The pane flips to the signed-out state after the reset.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  // THE AUDIT LOG IS PER-HUMAN AND SURVIVED SIGN-OUT (roborev 55406). It is in-memory,
  // process-lifetime state pruned only by its 200-entry cap, and its rows carry redacted-but-real
  // detail — absolute paths, PR numbers, agent names, refusal sentences. `clearConciergeAudit` had
  // documented itself as "the identity reset" since it was written and had ZERO callers; that was
  // latent only while the record had no reader, and the audit pane — which lives in THIS dialog, one
  // section over from this button — made it readable. Asserting the ENTRIES are gone, not that the
  // function was called: a spy would pass against a `clearConciergeAudit` that did nothing.
  it("clears the concierge audit log on sign-out — the next human must not inherit this one's record", async () => {
    // Reset FIRST: the audit store is module state that outlives a test, and this suite retries, so
    // without it a second attempt starts with the previous attempt's row and the arithmetic below
    // stops meaning anything.
    _resetConciergeAuditForTests();
    noteConciergeAuditCall("call-1", "workspace", "add_project_from_folder", {
      path: "/Users/ada/Projects/secret-thing",
    })({ ok: true });
    expect(useConciergeAudit.getState().entries).toHaveLength(1);

    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(useAuthStore.getState().tokenPresent).toBe(false));
    expect(useConciergeAudit.getState().entries).toHaveLength(0);
  });

  // THE SIBLING LEDGER, and the worse half of the same leak (roborev 55559). `clearConciergeApprovals`
  // carried the identical self-documented "identity reset" contract and likewise had no production
  // caller. Two things make it worse than the audit log: it retains `rawArgs` — the model's arguments
  // VERBATIM, not the display-safe redaction — and a PENDING card is actionable rather than merely
  // readable, so the next human could answer the previous one's queued question, and an
  // approved-but-unspent grant would survive the identity change.
  it("clears the concierge approvals ledger too, including a still-pending card", async () => {
    clearConciergeApprovals();
    requestApproval({
      id: "call-1",
      domain: "workflow",
      op: "merge_pr",
      summary: "Merge a pull request.",
      riskClass: "mutates-main",
      riskNote: "Changes the branch everything else is measured against.",
      args: [],
      rawArgs: { number: 753, token: "verbatim-not-redacted" },
      configPath: "concierge.tools.merge_pr",
      fingerprint: "fp-1",
    });
    // Still pending: nobody has answered it. This is the entry that is actionable, not just residue.
    const staged = useConciergeApprovals.getState().entries;
    expect(staged).toHaveLength(1);
    expect(staged[0]!.outcome).toBe("pending");
    // And the residue really is verbatim — this is what makes it worse than the audit log's rows,
    // which are redacted by construction. If the ledger ever starts redacting `rawArgs`, this line
    // fails and the reasoning above needs revisiting rather than quietly becoming false.
    expect(JSON.stringify(staged[0]!.rawArgs)).toContain("verbatim-not-redacted");

    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(useAuthStore.getState().tokenPresent).toBe(false));
    expect(useConciergeApprovals.getState().entries).toHaveLength(0);
  });

  it("disables the button and shows progress while sign-out is in flight", async () => {
    let resolveSignOut!: () => void;
    vi.mocked(signOut).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const inFlight = screen.getByRole("button", { name: "Signing out…" }) as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    resolveSignOut();
    // The pane flips to the signed-out UI, not just the store.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
    expect(useAuthStore.getState().tokenPresent).toBe(false);
  });

  it("re-enables Sign out (still signed in) when signOut rejects — no wedge, no reset", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(signOut).mockRejectedValueOnce(new Error("keychain locked"));
      useAuthStore.setState({ loading: false, tokenPresent: true, me });
      openAccountsPane();
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      const btn = await screen.findByRole("button", { name: "Sign out" });
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
      // The failed sign-out must not pretend to have signed out.
      expect(useAuthStore.getState().tokenPresent).toBe(true);
      // Pin the catch block specifically — React also routes noise through console.error.
      expect(consoleError).toHaveBeenCalledWith("Sign out failed:", expect.any(Error));
    } finally {
      consoleError.mockRestore(); // even on assertion failure, don't mask later tests' errors
    }
  });

  it("falls back to email when name missing; shows plain 'Signed in' (never the raw clerkUserId) when neither resolves", () => {
    // name blank → email is the next candidate.
    useAuthStore.setState({
      loading: false,
      tokenPresent: true,
      me: { ...me, name: null },
    });
    openAccountsPane();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    cleanup();
    // Neither name nor email (a degraded /me profile lookup) → NEVER surface the opaque `user_…`
    // clerkUserId; the pane reads a clean "Signed in".
    useAuthStore.setState({
      loading: false,
      tokenPresent: true,
      me: { ...me, email: null, name: null },
    });
    openAccountsPane();
    expect(screen.queryByText("user_123")).toBeNull();
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("still offers Sign out when the token is present but /me failed (offline)", () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me: null });
    openAccountsPane();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("shows the trial line and launches the browser sign-in when signed out", () => {
    useAuthStore.setState({ loading: false, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText(/limited free-trial mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(openSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a loading line while the auth store is still resolving", () => {
    useAuthStore.setState({ loading: true, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText("Checking sign-in status…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

// The Install ID row in the Accounts pane. It is the identifier on every crash report and usage
// event, so "does it render, and does Copy put the exact value on the clipboard" is the contract.
describe("SettingsDialog — Install ID", () => {
  const INSTALL_ID = "6dacbaa360a5f6f294118408c598f1c8";
  const openAccountsPane = () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  };
  /** A full TrialMeter (main widened fetchTrial's return type); only installId matters here. */
  const meter = (installId: string) => ({
    installId,
    started: true,
    promptsUsed: 0,
    remaining: null,
    cap: null,
    blocked: false,
    serverConfirmed: false,
  });
  /** Pretend we're inside the real Tauri webview — the row's guard keys on this exact global. */
  const inTauri = () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  };

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(fetchTrial).mockReset();
  });

  it("renders the install id and copies the EXACT value to the clipboard", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(INSTALL_ID));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    openAccountsPane();
    await waitFor(() => expect(screen.getByTestId("install-id").textContent).toBe(INSTALL_ID));

    fireEvent.click(screen.getByRole("button", { name: "Copy install ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTALL_ID));
    // The button confirms rather than silently succeeding.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("says UNAVAILABLE (not 'preview') when the trial command throws inside the real app", async () => {
    // Inside the app the browser-preview wording would be factually wrong, and it would mislead
    // exactly the user who has been asked to read their install ID out to support.
    inTauri();
    vi.mocked(fetchTrial).mockRejectedValue(new Error("no IPC"));
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Install ID unavailable/)).toBeTruthy());
    expect(screen.queryByText(/in this preview/)).toBeNull();
    expect(screen.queryByTestId("install-id")).toBeNull();
  });

  it("degrades when the command resolves an EMPTY id rather than rendering a blank box", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(""));
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Install ID unavailable/)).toBeTruthy());
    expect(screen.queryByTestId("install-id")).toBeNull();
  });

  it("survives a clipboard rejection without throwing or falsely confirming", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(INSTALL_ID));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    openAccountsPane();
    await waitFor(() => expect(screen.getByTestId("install-id")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Copy install ID" }));

    await waitFor(() => expect(err).toHaveBeenCalled());
    // It must NOT claim success — the id is still on screen and selectable for a manual copy.
    expect(screen.getByRole("button", { name: "Copy install ID" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    err.mockRestore();
  });

  it("does not touch IPC at all outside the Tauri webview (plain-browser dev preview)", async () => {
    // No __TAURI_INTERNALS__ on window.
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Not available in this preview/)).toBeTruthy());
    expect(fetchTrial).not.toHaveBeenCalled();
  });
});
