// @vitest-environment jsdom
//
// The guidelines editor. The contract that matters here is the ERROR discipline: Rust is the
// validator, and a rejected save must leave the user looking at their own text with the reason
// visible — never a silent success, and never a box that has quietly reverted.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readConciergeGuidelines = vi.fn();
const writeConciergeGuidelines = vi.fn();
const conciergeGuidelinesPath = vi.fn();
const revealItemInDir = vi.fn();

vi.mock("../services/conciergeGuidelines", () => ({
  readConciergeGuidelines: () => readConciergeGuidelines(),
  writeConciergeGuidelines: (t: string) => writeConciergeGuidelines(t),
  conciergeGuidelinesPath: () => conciergeGuidelinesPath(),
  appendConciergeGuideline: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (p: string) => revealItemInDir(p),
}));

import { ConciergeGuidelinesPane } from "./ConciergeGuidelinesPane";

const SEED = "# How Sparkle's concierge talks to me\n\n- Lead with what needs me.";

beforeEach(() => {
  vi.clearAllMocks();
  readConciergeGuidelines.mockResolvedValue(SEED);
  writeConciergeGuidelines.mockResolvedValue(undefined);
  conciergeGuidelinesPath.mockResolvedValue("/tmp/app/concierge-guidelines.md");
  // The component chains `.catch()` onto this, as it must — a reveal failure is not worth an
  // unhandled rejection. The mock has to be thenable or the test harness, not the product, throws.
  revealItemInDir.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

const box = () =>
  screen.getByLabelText("Concierge communication guidelines (Markdown)") as HTMLTextAreaElement;

describe("ConciergeGuidelinesPane", () => {
  it("opens showing the file — never a blank box", async () => {
    // The read returns the SEED when the file does not exist yet. A blank box would read as
    // "there are no rules" when the truth is "here are the five you already have".
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
  });

  it("is read-only until the file has actually loaded", () => {
    render(<ConciergeGuidelinesPane />);
    expect(box().readOnly).toBe(true);
  });

  it("saves the edited text and says the change lands on the NEXT reply", async () => {
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse.` } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeConciergeGuidelines).toHaveBeenCalledWith(`${SEED}\n- Be terse.`));
    // Not "applied": Rust re-reads the file per turn, so a reply already on screen predates it.
    expect(screen.getByTestId("concierge-guidelines-status").textContent).toMatch(/next reply/i);
  });

  it("SHOWS a rejected save and keeps the user's text", async () => {
    // The only rejection is the size cap, and it is real: this text is concatenated onto a process
    // argument on every concierge turn. Swallowing it would leave the user believing a rule applies
    // when the file on disk never changed.
    writeConciergeGuidelines.mockRejectedValue(new Error("guidelines file is too large"));
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: "way too much" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByTestId("concierge-guidelines-error").textContent).toMatch(/too large/i),
    );
    expect(box().value).toBe("way too much");
    expect(screen.queryByTestId("concierge-guidelines-status")).toBeNull();
  });

  it("reloads from disk, which is how a rule Sparkle appended shows up in an open pane", async () => {
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    readConciergeGuidelines.mockResolvedValue(`${SEED}\n- Added by Sparkle.`);
    fireEvent.click(screen.getByText("Reload from disk"));
    await waitFor(() => expect(box().value).toBe(`${SEED}\n- Added by Sparkle.`));
  });

  it("REFUSES a save that would erase rules Sparkle appended while the pane was open", async () => {
    // Save is a whole-file overwrite of what was loaded at mount. The concierge appends on its own
    // initiative mid-turn — the case the Reload button exists for — so without a staleness check a
    // user who edits and presses Save destroys every rule appended since, and is told "Saved."
    // Same silent amputation the Rust side was hardened against, re-entering through the UI
    // (roborev 54895).
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse.` } });
    // Sparkle appended while the pane sat open.
    readConciergeGuidelines.mockResolvedValue(`${SEED}\n- Added by Sparkle.`);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByTestId("concierge-guidelines-error").textContent).toMatch(/while you had it open/i),
    );
    expect(writeConciergeGuidelines).not.toHaveBeenCalled();
    // The user's edits are still on screen — the refusal must not cost them their work.
    expect(box().value).toBe(`${SEED}\n- Be terse.`);
  });

  it("keeps refusing on a SECOND press — the gate does not disarm itself", async () => {
    // The first version advanced the baseline on the refusal, so press two found the file "unchanged"
    // and overwrote it — two clicks to the exact data loss the check exists to prevent (roborev
    // 55029). Reachable by accident: typing clears the error, so a user following the advice to copy
    // their changes out loses the warning before pressing Save again.
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse.` } });
    readConciergeGuidelines.mockResolvedValue(`${SEED}\n- Added by Sparkle.`);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("concierge-guidelines-error")).toBeTruthy());
    // The keystroke that clears the warning, then a second press.
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse!` } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("concierge-guidelines-error")).toBeTruthy());
    expect(writeConciergeGuidelines).not.toHaveBeenCalled();
  });

  it("saves again once the user has actually Reloaded", async () => {
    // The gate must not be a dead end: Reload puts the screen back in step with the file, and only
    // then does the baseline move.
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse.` } });
    readConciergeGuidelines.mockResolvedValue(`${SEED}\n- Added by Sparkle.`);
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("concierge-guidelines-error")).toBeTruthy());

    // Two clicks: the buffer is dirty, so Reload arms its confirm first.
    fireEvent.click(screen.getByText("Reload from disk"));
    fireEvent.click(screen.getByText(/click again to discard/i));
    await waitFor(() => expect(box().value).toBe(`${SEED}\n- Added by Sparkle.`));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Added by Sparkle.\n- Be terse.` } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeConciergeGuidelines).toHaveBeenCalled());
  });

  it("saves normally when the file has not changed underneath", async () => {
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: `${SEED}\n- Be terse.` } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writeConciergeGuidelines).toHaveBeenCalled());
  });

  it("un-bricks itself: Reload after a FAILED initial load restores editing", async () => {
    // Reload is reachable after a failed load, which leaves `loaded` false. Without setting it, the
    // file appears in the box while the textarea stays read-only and Save stays disabled forever,
    // with nothing on screen saying why — in exactly the transient failure Reload exists to recover
    // from (roborev 54895).
    readConciergeGuidelines.mockRejectedValueOnce(new Error("transient IO"));
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(screen.getByTestId("concierge-guidelines-error")).toBeTruthy());
    expect(box().readOnly).toBe(true);

    readConciergeGuidelines.mockResolvedValue(SEED);
    fireEvent.click(screen.getByText("Reload from disk"));
    await waitFor(() => expect(box().value).toBe(SEED));
    expect(box().readOnly).toBe(false);
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("makes Reload confirm before discarding unsaved edits", async () => {
    // The sibling config editor gates its destructive action behind a two-click confirm, and this
    // pane's own reason for dropping "Reset to defaults" was that discarding user text has no
    // honest undo — which applies verbatim here (roborev 54895).
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    fireEvent.change(box(), { target: { value: "my unsaved work" } });
    readConciergeGuidelines.mockResolvedValue(SEED);

    fireEvent.click(screen.getByText("Reload from disk"));
    expect(box().value).toBe("my unsaved work");
    fireEvent.click(screen.getByText(/click again to discard/i));
    await waitFor(() => expect(box().value).toBe(SEED));
  });

  it("reloads without confirming when there is nothing to lose", async () => {
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(box().value).toBe(SEED));
    readConciergeGuidelines.mockResolvedValue(`${SEED}\n- Added by Sparkle.`);
    fireEvent.click(screen.getByText("Reload from disk"));
    await waitFor(() => expect(box().value).toBe(`${SEED}\n- Added by Sparkle.`));
  });

  it("offers no destructive reset — these rules are the user's, not the app's", () => {
    // The config editor has "Reset to defaults" because its defaults belong to the app. A one-click
    // button that discards preferences accumulated over months has no honest undo.
    render(<ConciergeGuidelinesPane />);
    expect(screen.queryByText(/reset to defaults/i)).toBeNull();
  });

  it("reveals the real file, because the point is that the user owns it", async () => {
    render(<ConciergeGuidelinesPane />);
    await waitFor(() => expect(conciergeGuidelinesPath).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Reveal in Finder"));
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/app/concierge-guidelines.md");
  });

  it("surfaces a failed LOAD instead of pretending the file is empty", async () => {
    readConciergeGuidelines.mockRejectedValue(new Error("no app data dir"));
    render(<ConciergeGuidelinesPane />);
    await waitFor(() =>
      expect(screen.getByTestId("concierge-guidelines-error").textContent).toMatch(/no app data dir/i),
    );
  });
});
