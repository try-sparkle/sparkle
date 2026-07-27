// @vitest-environment jsdom
//
// The Builder Index consent + settings modal. The behavior under test is the CONSENT CONTRACT,
// because this is the one Sparkle feature that publishes something about the user:
//   • dismissing without confirming publishes nothing and leaves the toggle alone;
//   • Confirm is blocked until there's a username AND a key (or a stored one);
//   • Confirm records identity + consent, THEN turns the flag on, THEN reports once;
//   • an already-on install gets Report now / Turn off and forget instead of a second consent.
// The Rust commands and configActions are mocked (no IPC); the settingsStore is the real one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/configActions", () => ({
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/builderIndex", () => ({
  BUILDER_INDEX_URL: "https://www.watchmepivot.com/builder-index",
  builderIndexStatus: vi.fn(),
  setBuilderIndexIdentity: vi.fn().mockResolvedValue(undefined),
  forgetBuilderIndex: vi.fn().mockResolvedValue(undefined),
  builderIndexReportNow: vi.fn(),
}));

import { setToolEnabled } from "../services/configActions";
import {
  builderIndexReportNow,
  builderIndexStatus,
  forgetBuilderIndex,
  setBuilderIndexIdentity,
  type BuilderIndexStatus,
} from "../services/builderIndex";
import { useSettingsStore } from "../stores/settingsStore";
import { BuilderIndexConsentModal } from "./BuilderIndexConsentModal";

const EMPTY_STATUS: BuilderIndexStatus = {
  enabled: false,
  username: "",
  hasApiKey: false,
  consented: false,
  clientId: "",
  reportDays: 7,
  lastReportAt: null,
  lastStatus: null,
  blockedBy: "Builder Index is off",
  serverUrl: "https://tokenmaxxing.odio.dev",
};

const CONFIGURED_STATUS: BuilderIndexStatus = {
  ...EMPTY_STATUS,
  enabled: true,
  username: "sam",
  hasApiKey: true,
  consented: true,
  clientId: "deadbeef",
  lastStatus: "Reported 9 row(s) across 7 day(s).",
  blockedBy: null,
};

beforeEach(() => {
  useSettingsStore.setState({ builderIndexModalOpen: true, builderIndexEnabled: false });
  vi.mocked(builderIndexStatus).mockResolvedValue(EMPTY_STATUS);
  vi.mocked(builderIndexReportNow).mockResolvedValue({ status: "posted", rows: 9, days: 7, truncated: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const title = "Publish your token totals to the Builder Index?";

describe("BuilderIndexConsentModal", () => {
  it("renders nothing when closed", () => {
    useSettingsStore.setState({ builderIndexModalOpen: false });
    render(<BuilderIndexConsentModal />);
    expect(screen.queryByText(title)).toBeNull();
  });

  it("itemizes exactly what is published, and what never is", () => {
    render(<BuilderIndexConsentModal />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(/input \/ output \/ cache tokens/)).toBeTruthy();
    expect(
      screen.getByText(/Never your code, prompts, file paths, project names, or API keys\./),
    ).toBeTruthy();
  });

  it("blocks Confirm until a username and a key are supplied", async () => {
    render(<BuilderIndexConsentModal />);
    const confirm = screen.getByRole("button", { name: "Publish my totals" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("tokenmaxxing username"), {
      target: { value: "sam" },
    });
    // Username alone is not enough — an unauthenticated POST would just be rejected.
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k-123" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });

  it("Confirm records identity + consent, enables the tool, and reports once", async () => {
    render(<BuilderIndexConsentModal />);
    fireEvent.change(screen.getByLabelText("tokenmaxxing username"), {
      target: { value: "  sam  " },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: " k-123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));

    // Username/key are trimmed, and consent rides along in the SAME call so the two can't
    // land out of step (a stored key with no consent would be a silent opt-in).
    await waitFor(() =>
      expect(setBuilderIndexIdentity).toHaveBeenCalledWith("sam", "k-123", true),
    );
    await waitFor(() => expect(setToolEnabled).toHaveBeenCalledWith("builderIndex", true));
    await waitFor(() => expect(builderIndexReportNow).toHaveBeenCalledTimes(1));
    // The user is told the result rather than left trusting a background timer.
    await waitFor(() => expect(screen.getByText(/Reported 9 row\(s\) across 7 day\(s\)\./)).toBeTruthy());
  });

  it("keeps the modal open and explains when the first report fails", async () => {
    vi.mocked(builderIndexReportNow).mockRejectedValue("server returned 401");
    render(<BuilderIndexConsentModal />);
    fireEvent.change(screen.getByLabelText("tokenmaxxing username"), { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));

    await waitFor(() => expect(screen.getByText(/Couldn't report: server returned 401/)).toBeTruthy());
    // Still open — closing here would leave the toggle on with nothing ever appearing.
    expect(useSettingsStore.getState().builderIndexModalOpen).toBe(true);
  });

  it("'Not now' publishes nothing and never touches the toggle", async () => {
    render(<BuilderIndexConsentModal />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false));
    expect(setBuilderIndexIdentity).not.toHaveBeenCalled();
    expect(setToolEnabled).not.toHaveBeenCalled();
    expect(builderIndexReportNow).not.toHaveBeenCalled();
  });

  it("an already-enabled install gets manage controls, not a second consent prompt", async () => {
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    render(<BuilderIndexConsentModal />);

    // The stored username is prefilled, and the last cycle's outcome is shown.
    await waitFor(() =>
      expect((screen.getByLabelText("tokenmaxxing username") as HTMLInputElement).value).toBe("sam"),
    );
    expect(screen.getByText("Reported 9 row(s) across 7 day(s).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish my totals" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off and forget" })).toBeTruthy();
  });

  it("manage mode can actually SAVE an edited username", async () => {
    // Regression: the save action used to be gated on `!enabled`, so an already-on install could
    // type into both fields with no control that persisted them — edits were silently discarded on
    // close, contradicting the row's "change username" affordance. (roborev 47458)
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    render(<BuilderIndexConsentModal />);

    fireEvent.change(await screen.findByLabelText("tokenmaxxing username"), {
      target: { value: "sam-two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setBuilderIndexIdentity).toHaveBeenCalledWith("sam-two", "", true),
    );
  });

  it("an enabled-but-unconsented install can still record consent", async () => {
    // Reachable by hand-editing `builder_index = true` in config.toml. Keying the consent button
    // off `enabled` made this a dead end: manage controls rendered, the gate said "waiting for
    // consent", and no UI could resolve it. (roborev 47458)
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue({
      ...EMPTY_STATUS,
      enabled: true,
      consented: false,
      blockedBy: "waiting for consent",
    });
    render(<BuilderIndexConsentModal />);

    fireEvent.change(await screen.findByLabelText("tokenmaxxing username"), {
      target: { value: "sam" },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));
    await waitFor(() => expect(setBuilderIndexIdentity).toHaveBeenCalledWith("sam", "k", true));
  });

  it("re-opens usable after a successful 'Turn off and forget'", async () => {
    // Regression: the success path never cleared `busy`, and this component never unmounts — so
    // the NEXT open rendered every control (and Escape, and the backdrop) dead until an app
    // restart. (roborev 47458)
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    const { rerender } = render(<BuilderIndexConsentModal />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off and forget" }));
    await waitFor(() => expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false));

    // Re-open the way the Tools switch would.
    vi.mocked(builderIndexStatus).mockResolvedValue(EMPTY_STATUS);
    useSettingsStore.setState({ builderIndexEnabled: false, builderIndexModalOpen: true });
    rerender(<BuilderIndexConsentModal />);

    const user = (await screen.findByLabelText("tokenmaxxing username")) as HTMLInputElement;
    expect(user.disabled).toBe(false);
    fireEvent.change(user, { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    const save = screen.getByRole("button", { name: "Publish my totals" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("'Report now' runs a one-shot report and shows its outcome", async () => {
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    vi.mocked(builderIndexReportNow).mockResolvedValue({ status: "posted", rows: 4, days: 2, truncated: false });
    render(<BuilderIndexConsentModal />);

    fireEvent.click(await screen.findByRole("button", { name: "Report now" }));
    await waitFor(() => expect(screen.getByText(/Reported 4 row\(s\) across 2 day\(s\)\./)).toBeTruthy());
  });

  it("surfaces a skipped report rather than pretending it posted", async () => {
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    vi.mocked(builderIndexReportNow).mockResolvedValue({
      status: "skipped",
      reason: "no API key set",
    });
    render(<BuilderIndexConsentModal />);

    fireEvent.click(await screen.findByRole("button", { name: "Report now" }));
    await waitFor(() => expect(screen.getByText(/Not reported — no API key set\./)).toBeTruthy());
  });

  it("'Turn off and forget' disables the tool AND clears the stored credentials", async () => {
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockResolvedValue(CONFIGURED_STATUS);
    render(<BuilderIndexConsentModal />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off and forget" }));
    await waitFor(() => expect(setToolEnabled).toHaveBeenCalledWith("builderIndex", false));
    await waitFor(() => expect(forgetBuilderIndex).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false));
  });

  it("says PARTIAL when the scan was capped, on the surface the user is looking at", async () => {
    // The stored lastStatus carries the marker too, but the modal hides lastStatus whenever a
    // fresh message is present — so without it on the outcome the warning existed only in the log.
    // (roborev 47899)
    vi.mocked(builderIndexReportNow).mockResolvedValue({
      status: "posted",
      rows: 3,
      days: 2,
      truncated: true,
    });
    render(<BuilderIndexConsentModal />);
    fireEvent.change(screen.getByLabelText("tokenmaxxing username"), { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));
    await waitFor(() => expect(screen.getByText(/PARTIAL — the transcript scan hit its file cap/)).toBeTruthy());
  });

  it("dismissing mid-request can't start a second concurrent report", async () => {
    // Clearing `busy` on close (needed so a dismissal can never wedge the dialog) also cleared the
    // only re-entrancy guard: close → re-open → click fired a SECOND identity write and POST
    // alongside the first, racing ensure_client_id and the state file. An in-flight ref survives
    // the close. (roborev 47904/47899)
    let release!: () => void;
    vi.mocked(builderIndexReportNow).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ status: "posted", rows: 1, days: 1, truncated: false });
      }),
    );
    const { rerender } = render(<BuilderIndexConsentModal />);
    fireEvent.change(screen.getByLabelText("tokenmaxxing username"), { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));
    await waitFor(() => expect(builderIndexReportNow).toHaveBeenCalledTimes(1));

    // Escape out mid-flight, then re-open and try to submit again.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false));
    useSettingsStore.setState({ builderIndexModalOpen: true });
    rerender(<BuilderIndexConsentModal />);
    fireEvent.change(await screen.findByLabelText("tokenmaxxing username"), {
      target: { value: "sam" },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));

    expect(builderIndexReportNow).toHaveBeenCalledTimes(1);
    expect(setBuilderIndexIdentity).toHaveBeenCalledTimes(1);
    release();
  });

  it("a failed status fetch says so and still offers Report now to an enabled install", async () => {
    // Keying manage mode off `status.consented` made the UI depend on a fetch that can fail;
    // status === null then reads as "not consented" and would hide Report now from a user whose
    // toggle is demonstrably on. (roborev 47904)
    useSettingsStore.setState({ builderIndexEnabled: true });
    vi.mocked(builderIndexStatus).mockRejectedValue(new Error("no ipc"));
    render(<BuilderIndexConsentModal />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't read your Builder Index settings/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Report now" })).toBeTruthy();
  });

  it("admits that saving from an off-but-consented state turns reporting back on", async () => {
    // confirm() writes tools.builder_index = true either way, so a bare "Save" would silently
    // re-enable publishing for someone who had switched it off. (roborev 47904)
    useSettingsStore.setState({ builderIndexEnabled: false });
    vi.mocked(builderIndexStatus).mockResolvedValue({ ...CONFIGURED_STATUS, enabled: false });
    render(<BuilderIndexConsentModal />);
    expect(await screen.findByRole("button", { name: "Save and turn on" })).toBeTruthy();
  });

  it("lets a configured user change their username without re-typing the key", async () => {
    vi.mocked(builderIndexStatus).mockResolvedValue({ ...EMPTY_STATUS, hasApiKey: true });
    render(<BuilderIndexConsentModal />);
    fireEvent.change(await screen.findByLabelText("tokenmaxxing username"), {
      target: { value: "sam" },
    });
    const confirm = screen.getByRole("button", { name: "Publish my totals" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    // Empty key = "keep the stored one"; Rust treats a blank api_key as no-change.
    await waitFor(() => expect(setBuilderIndexIdentity).toHaveBeenCalledWith("sam", "", true));
  });
});
