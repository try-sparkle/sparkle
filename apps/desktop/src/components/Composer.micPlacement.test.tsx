// @vitest-environment jsdom
//
// The composer mic must sit beside the INPUT BOX, always — never beside a pasted
// attachment tile. The mic is `alignSelf: flex-start` inside a flex row, so it aligns
// to the top of whatever column it shares that row with. When the attachment tiles
// lived above the textarea *inside* that column, a paste pushed the column's top edge
// up to the tile row and the mic followed it, landing next to the thumbnail instead of
// the box the user types in. The fix hoists the tiles out of the row entirely; these
// tests pin the resulting DOM relationship so the two can't be re-nested.
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => ({ submitPrompt: vi.fn(() => Promise.resolve()) }));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Composer } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";

beforeEach(() => {
  // enabled === true is what makes ComposerMic render at all (it returns null when off).
  useDictationStore.setState({
    insertTarget: null,
    enabled: true,
    status: "idle",
    interim: "",
    phase: "passive",
  });
  useUiStore.getState().setComposerMinimized(false);
});
afterEach(() => cleanup());

function renderComposer() {
  const inputRef = createRef<HTMLTextAreaElement>();
  const { container } = render(
    <Composer
      agentId="a1"
      active
      disabled={false}
      inputRef={inputRef}
      onSubmitPrompt={vi.fn()}
    />,
  );
  return { container };
}

/** The flex row the mic shares with the input box — the element whose top edge the mic's
 *  `alignSelf: flex-start` resolves against. */
function micRow(container: HTMLElement): HTMLElement {
  const mic = container.querySelector('[data-hint="composer-mic"]');
  expect(mic).not.toBeNull();
  // button → wrapping <span> (menu anchor) → the flex row.
  const row = mic!.parentElement!.parentElement;
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

/** Paste enough lines to collapse into an attachment-row pill (threshold: >5 lines). */
function pasteAsPill(textarea: HTMLTextAreaElement) {
  fireEvent.paste(textarea, {
    clipboardData: { getData: () => "l1\nl2\nl3\nl4\nl5\nl6\nl7" },
  });
}

describe("Composer — mic placement", () => {
  it("puts the mic in the same row as the textarea", () => {
    const { container } = renderComposer();
    const textarea = screen.getByRole("textbox");
    expect(micRow(container).contains(textarea)).toBe(true);
  });

  it("keeps the mic beside the textarea — not the tiles — after a pasted attachment", () => {
    const { container } = renderComposer();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    pasteAsPill(textarea);

    // The pill is really there (otherwise this test would pass vacuously).
    const pill = screen.getByTitle("Click to view the full pasted text");
    const row = micRow(container);
    expect(row.contains(textarea)).toBe(true);
    expect(row.contains(pill)).toBe(false);
  });

  it("renders the attachment tiles above the mic/input row, not inside it", () => {
    const { container } = renderComposer();
    pasteAsPill(screen.getByRole("textbox") as HTMLTextAreaElement);

    const pill = screen.getByTitle("Click to view the full pasted text");
    const row = micRow(container);
    const tileRow = pill.closest("div")!.parentElement!;
    // Siblings under the composer body: tiles first, then the mic/input/send row.
    expect(tileRow.parentElement).toBe(row.parentElement);
    expect(tileRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
