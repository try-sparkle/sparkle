// @vitest-environment jsdom
//
// Regression guard for the blank-on-launch bug: useRosterPublisher calls useCurrentWindowLabel,
// which throws "must be used within CurrentProjectProvider" if the hook runs outside the provider.
// It was briefly mounted in App's BODY (outside the provider App renders as a child), so App threw
// on every launch and the window painted blank. It must be rendered as a component INSIDE the
// provider (App's <RosterPublisher/>). These tests pin that dependency so a future move back into
// App's body — or any other out-of-provider mount — fails loudly here instead of in a packaged DMG.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentProjectProvider } from "./windowContext";
import { useRosterPublisher } from "./useRosterPublisher";

function Harness() {
  useRosterPublisher();
  return null;
}

afterEach(cleanup);

describe("useRosterPublisher provider dependency", () => {
  it("throws when mounted OUTSIDE CurrentProjectProvider (the App-body regression)", () => {
    // React logs the error to console.error on the way to throwing — silence it for a clean run.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/CurrentProjectProvider/);
    spy.mockRestore();
  });

  it("renders without throwing INSIDE CurrentProjectProvider", () => {
    expect(() =>
      render(
        <CurrentProjectProvider>
          <Harness />
        </CurrentProjectProvider>,
      ),
    ).not.toThrow();
  });
});
