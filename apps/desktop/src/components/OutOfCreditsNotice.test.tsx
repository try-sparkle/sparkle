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
  it("defaults to the THEMED blue-as-text ink, not the constant brand fill", () => {
    // It used to default to `C.teal` — the constant CTA/fill blue — under a comment calling that
    // "the brand blue the existing mic surfaces expect". As INK that value is 4.50:1 on light's
    // white and 4.30:1 on the composer bar, i.e. below AA on one of the two surfaces this word
    // actually renders on. `tealInk` is the themed counterpart; theme/linkContrast.test.ts holds
    // the ratio. Asserting the token (a CSS var, which jsdom passes through verbatim) rather than
    // a resolved rgb() is what keeps this a statement about the SPLIT and not about a hex.
    render(<RefillLink />);
    expect(screen.getByRole("button", { name: "Refill" }).style.color).toBe(C.tealInk);
    expect(C.tealInk).not.toBe(C.teal);
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
