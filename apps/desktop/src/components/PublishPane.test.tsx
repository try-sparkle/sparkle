// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const getConfig = vi.fn();
const probeDestination = vi.fn();

vi.mock("../services/config", () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock("../services/publishCapabilities", async (importActual) => {
  // Keep the real PUBLISH_AFFORDANCES: the card renders from it, and a stubbed copy would let the
  // pane's test pass against an affordance list production does not have.
  const actual = await importActual<typeof import("../services/publishCapabilities")>();
  return { ...actual, probeDestination: (...a: unknown[]) => probeDestination(...a) };
});

import { PublishPane } from "./PublishPane";

// The pane's one non-obvious job is a DISTINCTION, and it is the thing worth pinning: a probe that
// could not RUN (bad URL, no credential, dead host) is not the same as a probe that ran and said
// the destination is unusable. They look identical if you only render "something is wrong", and
// their remedies have nothing in common — fix your config versus this destination is missing tools.

const VALID = {
  valid: true,
  missingRequired: [],
  presentOptional: [],
  missingOptional: ["upload_image"],
  argShapeProblems: [],
  affordances: ["project-picker" as const],
};

const ONE_DESTINATION = {
  config: {
    publish: {
      active: "drodio",
      destinations: {
        drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
      },
    },
  },
};

beforeEach(() => {
  getConfig.mockReset();
  probeDestination.mockReset();
});

describe("PublishPane", () => {
  it("probes each configured destination by id and renders its card", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);

    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    expect(probeDestination).toHaveBeenCalledWith("drodio");
    expect(screen.getByTestId("publish-destination-verdict").textContent).toContain(
      "Ready to publish",
    );
    // The card is really wired to the probe's answer, not to a placeholder: the one affordance this
    // destination earned is painted, and the one it did not is absent.
    expect(screen.getByTestId("publish-affordance-project-picker")).toBeTruthy();
    expect(screen.queryByTestId("publish-affordance-image-attach")).toBeNull();
  });

  /** THE DISTINCTION. A rejected probe must not render as an invalid destination — there is no
   *  capability answer at all, and the message names the rule that failed. */
  it("shows the host's message when the probe could not run, and paints no capability card", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockRejectedValue("that destination's configured URL is not usable: a publish destination must use https");

    render(<PublishPane />);

    await waitFor(() =>
      expect(screen.getByText(/configured URL is not usable/)).toBeTruthy(),
    );
    // No card, and — the half that matters — no verdict either. Rendering "Sparkle can't publish
    // here" would state a conclusion about the destination that nothing established.
    expect(screen.queryByTestId("publish-destination-card")).toBeNull();
    expect(screen.queryByTestId("publish-destination-verdict")).toBeNull();
  });

  /** The converse, in the same file: a probe that DID run and said no renders the capability card
   *  with its verdict. One test alone cannot show the two are distinguished. */
  it("renders the invalid verdict when the probe ran and rejected the destination", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue({
      valid: false,
      missingRequired: ["list_projects"],
      presentOptional: [],
      missingOptional: [],
      argShapeProblems: [],
      affordances: [],
    });

    render(<PublishPane />);

    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    expect(screen.getByTestId("publish-destination-verdict").textContent).toContain("can’t publish");
    expect(screen.getByTestId("publish-missing-tool-list_projects").textContent).toBe("list_projects");
  });

  it("says nothing is configured — and issues no probe — when [publish] is absent", async () => {
    // An older backend omits the section entirely. It must read as "no destination", never as one
    // being available, and must not send the pane looking for something to probe.
    getConfig.mockResolvedValue({ config: {} });

    render(<PublishPane />);

    await waitFor(() => expect(screen.getByText(/No publish destination is configured/)).toBeTruthy());
    expect(probeDestination).not.toHaveBeenCalled();
  });

  // THE PATH THAT WAS BOTH UNFIXED AND UNMOCKED (roborev 66504/66535/66540, Medium ×3).
  //
  // Every other case here mocks `getConfig` as RESOLVING, so the pane's only unhandled failure
  // stayed invisible: `load()` wrapped it in try/finally with no catch, a rejection left `rows`
  // null forever, and the early return meant no retry button either. "Sparkle could not read your
  // config" rendered identically to "still working" — the very could-not-run vs. ran-and-said-no
  // confusion this pane exists to prevent, one level up. This test fails against that version.
  it("says the check never ran when the CONFIG itself cannot be read, and stays recoverable", async () => {
    getConfig.mockRejectedValue(new Error("config unreadable"));

    render(<PublishPane />);

    // It must LEAVE the loading state — the defect was that it never did.
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    // It must say the check did not run, rather than making a claim about any destination.
    expect(screen.getByText(/never ran/i)).toBeTruthy();
    expect(screen.getByText(/config unreadable/)).toBeTruthy();

    // And it must stay recoverable: the early return used to swallow the retry affordance.
    expect(screen.getByRole("button", { name: /check again/i })).toBeTruthy();

    // It must NOT have invented a verdict about a destination it never probed.
    expect(probeDestination).not.toHaveBeenCalled();
    expect(screen.queryByTestId("publish-destination-card")).toBeNull();
  });

  // THE RETRY PATH ITSELF (roborev 66549, Medium). The test above asserts the button EXISTS; it
  // never pressed it, and pressing it was broken: `load()` cleared the pane error at the START of
  // the re-check while `rows` was still [] from the failed attempt, so the render fell through to
  // the empty state and claimed "No publish destination is configured" about a config it had just
  // failed to read — with no retry button in that branch to escape with.
  it("pressing Check again never claims a config it still cannot read", async () => {
    getConfig.mockRejectedValue(new Error("config unreadable"));
    render(<PublishPane />);
    await waitFor(() => expect(screen.getByText(/never ran/i)).toBeTruthy());

    // A retry that stays pending — the window in which the false claim used to render.
    let release: (v: unknown) => void = () => {};
    getConfig.mockReturnValue(new Promise((r) => { release = r; }));
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));

    // MID-FLIGHT: it must not assert anything about destinations it has not read.
    await waitFor(() => expect(screen.getByRole("button", { name: /checking/i })).toBeTruthy());
    expect(screen.queryByText(/No publish destination is configured/i)).toBeNull();
    expect(screen.getByText(/never ran/i)).toBeTruthy();

    // …and once the read SUCCEEDS with nothing configured, the empty state is now the truth.
    release({ config: {} });
    await waitFor(() => expect(screen.getByText(/No publish destination is configured/i)).toBeTruthy());
    expect(screen.queryByText(/never ran/i)).toBeNull();
  });
});
