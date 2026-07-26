// @vitest-environment jsdom
//
// RefillLink is the app's single refill affordance — the composer mic notice, the sidebar caption,
// and the "$0" workspace banner all route through it. It gained an optional `color` so the banner
// can place it on an amber fill (brand blue on amber is unreadable). These pin the DEFAULT, because
// the three pre-existing callers rely on it and a changed default would silently restyle all of
// them; the behavior (deep-open Credits) is asserted alongside so the prop can't drift into a
// second, divergent refill path.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RefillLink } from "./OutOfCreditsNotice";
import { useUiStore } from "../stores/uiStore";
import { C } from "../theme/colors";

beforeEach(() => useUiStore.setState({ settingsRequest: null }));
afterEach(cleanup);

describe("RefillLink", () => {
  it("defaults to the brand blue the existing mic surfaces expect", () => {
    // jsdom normalizes an inline hex to rgb(), so compare through the same normalization rather
    // than asserting the literal token — otherwise this fails on formatting, not on the color.
    const normalize = (hex: string) => {
      const probe = document.createElement("span");
      probe.style.color = hex;
      return probe.style.color;
    };
    render(<RefillLink />);
    expect(screen.getByRole("button", { name: "Refill" }).style.color).toBe(normalize(C.teal));
  });

  it("honors an explicit color for callers placing it on a colored fill", () => {
    render(<RefillLink color="rgb(1, 2, 3)" />);
    expect(screen.getByRole("button", { name: "Refill" }).style.color).toBe("rgb(1, 2, 3)");
  });

  it("deep-opens the Credits pane regardless of color — one refill seam, not two", () => {
    render(<RefillLink color="rgb(1, 2, 3)" />);
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });
});
