// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const getConfig = vi.fn();
const setConfigValue = vi.fn();
const setConfigValues = vi.fn();
const unsetConfigValue = vi.fn();
const probeDestination = vi.fn();

vi.mock("../services/config", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  setConfigValue: (...a: unknown[]) => setConfigValue(...a),
  setConfigValues: (...a: unknown[]) => setConfigValues(...a),
  unsetConfigValue: (...a: unknown[]) => unsetConfigValue(...a),
  // Deliberately NOT mocking `setProjectConfigValue`. `[publish]` is machine-wide — a per-repo
  // `.sparkle/config.toml` that sets it is ignored with a warning, because a cloned repo must not
  // be able to grant itself a network egress target with a bearer token. If the pane ever reaches
  // for the project setter, this module mock has no such export and the test dies rather than
  // quietly writing to a file nothing reads.
}));
// The credential service. Mocked here because the pane now BOTH mounts `PublishTokenRow` (which
// reads a source on mount) and clears a destination's token on removal — so without this the pane's
// own tests would reach a real `invoke` and fail for a reason that has nothing to do with the pane.
//
// `publishTokenEnvVarName` is deliberately the REAL implementation, not a stub: the removal warning
// prints that variable's name, and a stubbed one would let this suite pass while the pane told the
// user to unset a variable that does not match what Rust actually reads.
const clearPublishToken = vi.fn();
const getPublishTokenSource = vi.fn();
vi.mock("../services/publishCredential", async (importActual) => {
  const actual = await importActual<typeof import("../services/publishCredential")>();
  return {
    ...actual,
    clearPublishToken: (...a: unknown[]) => clearPublishToken(...a),
    getPublishTokenSource: (...a: unknown[]) => getPublishTokenSource(...a),
    setPublishToken: vi.fn(),
    isPublishTokenPresent: vi.fn(),
  };
});
vi.mock("../services/publishCapabilities", async (importActual) => {
  // Keep the real PUBLISH_AFFORDANCES: the card renders from it, and a stubbed copy would let the
  // pane's test pass against an affordance list production does not have.
  const actual = await importActual<typeof import("../services/publishCapabilities")>();
  return { ...actual, probeDestination: (...a: unknown[]) => probeDestination(...a) };
});

import { PublishPane } from "./PublishPane";
import { PUBLISH_TOKEN_ROW_TESTID } from "./PublishTokenRow";

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

/** Two destinations with `drodio` active — the shape the multi-destination cases need. */
const TWO_DESTINATIONS = {
  config: {
    publish: {
      active: "drodio",
      destinations: {
        drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
        linkedin: { name: "LinkedIn", url: "https://linkedin.example/api/mcp", has_credential_in_keychain: false },
      },
    },
  },
};

beforeEach(() => {
  getConfig.mockReset();
  probeDestination.mockReset();
  setConfigValue.mockReset().mockResolvedValue(undefined);
  setConfigValues.mockReset().mockResolvedValue(undefined);
  unsetConfigValue.mockReset().mockResolvedValue(undefined);
  // `clearPublishToken` resolves to the source that SURVIVES the clear — "none" is the ordinary
  // case. A test that cares about the environment-still-supplies-one case overrides it.
  clearPublishToken.mockReset().mockResolvedValue("none");
  getPublishTokenSource.mockReset().mockResolvedValue("keychain");
});

/** Type the three fields of the mounted add form and press its submit button. */
function fillAndSubmitForm(draft: { id: string; name: string; url: string }) {
  fireEvent.change(screen.getByTestId("publish-form-id"), { target: { value: draft.id } });
  fireEvent.change(screen.getByTestId("publish-form-name"), { target: { value: draft.name } });
  fireEvent.change(screen.getByTestId("publish-form-url"), { target: { value: draft.url } });
  fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
}

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

// ── ADDING, SWITCHING AND REMOVING (bead `sparkle-131ms.9`) ──────────────────────────────────────
//
// Every assertion here is about the WRITE — which config setter was called, with which dotted path
// and which value — because that is the whole of what these controls do. A test that asserted the
// form rendered, or that a destination appeared in the list, would pass against a pane that showed
// the destination and never wrote it: the list is re-read from `getConfig`, which the test itself
// mocks, so it can be made to say anything.
//
// The GLOBAL setters are the only ones mocked, on purpose — see the module mock at the top.

describe("PublishPane — adding a destination", () => {
  it("writes name, url and publish.active in ONE atomic write when it is the first one", async () => {
    getConfig.mockResolvedValueOnce({ config: {} }).mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByText(/No publish destination is configured/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" });

    // ONE call, all three keys. Two writes would leave a window in which the destination exists
    // and `publish.active` is still null — and publish ops REFUSE on a null active rather than
    // guessing, so that window is a destination that is configured and cannot be published to.
    await waitFor(() => expect(setConfigValues).toHaveBeenCalledTimes(1));
    expect(setConfigValues).toHaveBeenCalledWith({
      "publish.destinations.drodio.name": "drodio.com",
      "publish.destinations.drodio.url": "https://drodio.com/api/mcp",
      "publish.active": "drodio",
    });
    // The atomic write is the point: `publish.active` must not have been set separately.
    expect(setConfigValue).not.toHaveBeenCalled();

    // And the pane re-READS rather than trusting its own optimism.
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
  });

  it("does not repoint publish.active when a destination is already active", async () => {
    // Adding LinkedIn must not silently move where the founder publishes. This is the assertion an
    // implementation that always writes `publish.active` would fail.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "linkedin", name: "LinkedIn", url: "https://linkedin.example/api/mcp" });

    await waitFor(() => expect(setConfigValues).toHaveBeenCalledTimes(1));
    expect(setConfigValues).toHaveBeenCalledWith({
      "publish.destinations.linkedin.name": "LinkedIn",
      "publish.destinations.linkedin.url": "https://linkedin.example/api/mcp",
    });
  });

  it("claims publish.active when the config's existing active names a destination that does not exist", async () => {
    // A hand-edited config.toml can point `active` at a destination that was never added, or that
    // an older build removed without repointing. That is a NON-NULL string pointing at nothing, so
    // an `active === null` test does not see it — and the first destination the user adds would
    // leave the config still dangling and every publish still refusing, which is precisely the
    // state the pane exists to get them out of.
    getConfig
      .mockResolvedValueOnce({ config: { publish: { active: "ghost", destinations: {} } } })
      .mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByText(/No publish destination is configured/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" });

    await waitFor(() => expect(setConfigValues).toHaveBeenCalledTimes(1));
    expect(setConfigValues).toHaveBeenCalledWith({
      "publish.destinations.drodio.name": "drodio.com",
      "publish.destinations.drodio.url": "https://drodio.com/api/mcp",
      "publish.active": "drodio",
    });
  });

  /** THE COULD-NOT-RUN vs. RAN-AND-SAID-NO DISTINCTION, on the new mutating path. A write that
   *  failed must render as "that did not save" and must NOT render as a destination that exists. */
  it("a failed config write says nothing was saved, and does not claim the destination was added", async () => {
    getConfig.mockResolvedValue({ config: {} });

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByText(/No publish destination is configured/)).toBeTruthy());

    setConfigValues.mockRejectedValue(new Error("config.toml is read-only"));
    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" });

    await waitFor(() => expect(screen.getByTestId("publish-write-error")).toBeTruthy());
    expect(screen.getByTestId("publish-write-error").textContent).toContain("read-only");
    expect(screen.getByTestId("publish-write-error").textContent).toContain("nothing changed");
    // No card, no picker: the pane must not paint a destination the config does not hold.
    expect(screen.queryByTestId("publish-destination-card")).toBeNull();
    expect(screen.queryByTestId("publish-active-picker")).toBeNull();
    // The form stays open with the typed values still in it, so the user can retry rather than
    // retype.
    expect((screen.getByTestId("publish-form-id") as HTMLInputElement).value).toBe("drodio");
  });

  it("attempts NO write at all when the id or the URL is refused", async () => {
    getConfig.mockResolvedValue({ config: {} });

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByText(/No publish destination is configured/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));

    // An id config.toml would hold happily and every keychain call would then refuse.
    fillAndSubmitForm({ id: "Drodio.com", name: "drodio.com", url: "https://drodio.com/api/mcp" });
    expect(setConfigValues).not.toHaveBeenCalled();

    // …and a URL that would send a bearer token over plain http to a remote host.
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "http://drodio.com/api/mcp" });
    expect(setConfigValues).not.toHaveBeenCalled();
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});

describe("PublishPane — the active destination", () => {
  it("writes publish.active when the picker changes", async () => {
    getConfig.mockResolvedValue(TWO_DESTINATIONS);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.change(screen.getByTestId("publish-active-picker"), { target: { value: "linkedin" } });

    await waitFor(() => expect(setConfigValue).toHaveBeenCalledWith("publish.active", "linkedin"));
  });

  it("a failed switch leaves the picker on the destination the config still names", async () => {
    // The picker's value comes from the last successful READ, never from the click. Moving it
    // optimistically would show the founder publishing to LinkedIn when the config still says
    // drodio — and the next publish would go to drodio.
    getConfig.mockResolvedValue(TWO_DESTINATIONS);
    probeDestination.mockResolvedValue(VALID);
    setConfigValue.mockRejectedValue(new Error("config.toml is read-only"));

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.change(screen.getByTestId("publish-active-picker"), { target: { value: "linkedin" } });

    await waitFor(() => expect(screen.getByTestId("publish-write-error")).toBeTruthy());
    expect((screen.getByTestId("publish-active-picker") as HTMLSelectElement).value).toBe("drodio");
  });
});

describe("PublishPane — removing a destination", () => {
  it("says the token is CLEARED, and names the env var it cannot clear, BEFORE removing anything", async () => {
    // This copy moved when the pane gained the ability to clear the credential. It used to promise
    // the token stayed behind — true only while the pane could not reach the credential service.
    // Pinning the CURRENT sentence is what stops it silently reverting to the old promise, which
    // would send a user hunting at the destination for a token Sparkle had already deleted.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    const warning = screen.getByTestId("publish-remove-confirm-drodio").textContent ?? "";
    expect(warning).toMatch(/clears its saved token/i);
    // The env fallback is the case the user most needs told, because everything else on screen says
    // "removed" while the destination keeps working. The NAME must be there, not just the concept.
    expect(warning).toContain("SPARKLE_PUBLISH_TOKEN_DRODIO");
    // ...and the stale promise must be gone, not merely joined by the new sentence.
    expect(warning).not.toMatch(/stays in your keychain/i);

    // Nothing has been written yet — the warning is a gate, not a receipt.
    expect(unsetConfigValue).not.toHaveBeenCalled();
    expect(clearPublishToken).not.toHaveBeenCalled();
  });

  /** THE SIDE EFFECT the warning above promises. Asserting only the copy would pass against a pane
   *  that says it clears the token and never calls anything — which is precisely the vacuous shape
   *  AGENTS.md warns about, and would be worse than the old honest "it survives" message. */
  it("actually clears the destination's keychain token, AFTER the config write that removes it", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() => expect(clearPublishToken).toHaveBeenCalledWith("drodio"));

    // ORDER matters and is the opposite of the `publish.active` repoint above. Clearing FIRST and
    // then failing the config write would leave a configured destination whose credential had
    // silently vanished — a destination that looks fine and cannot work.
    const removed = unsetConfigValue.mock.invocationCallOrder[0]!;
    const cleared = clearPublishToken.mock.invocationCallOrder[0]!;
    expect(removed).toBeLessThan(cleared);
  });

  it("still reports the destination removed when clearing its token fails", async () => {
    // The config write already succeeded, so the destination IS gone. Rendering "remove failed"
    // over a removal that happened would be a lie in the other direction.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.drodio"),
    );
    expect(screen.queryByTestId("publish-write-error")).toBeNull();
  });

  /** THE EDGE CASE. `publish.active` naming a destination that no longer exists is a real bug:
   *  publish ops resolve their target as "the caller's explicit id, else `[publish] active`", so a
   *  dangling active is a publish that fails at call time citing a destination the user deleted. */
  it("repoints publish.active to a surviving destination BEFORE removing the active one", async () => {
    getConfig.mockResolvedValue(TWO_DESTINATIONS);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.drodio"),
    );
    expect(setConfigValue).toHaveBeenCalledWith("publish.active", "linkedin");

    // ORDER, not merely both: repointing AFTER the removal leaves the config momentarily naming a
    // destination that is gone, and leaves it that way permanently if the second write fails.
    const repointed = setConfigValue.mock.invocationCallOrder[0]!;
    const removed = unsetConfigValue.mock.invocationCallOrder[0]!;
    expect(repointed).toBeLessThan(removed);
  });

  it("CLEARS publish.active when the destination removed was the last one", async () => {
    // `unsetConfigValue`, not an empty string: `active` is a Rust `Option<String>` and the absent
    // key is how "none" is spelled. An empty string is a destination id that matches nothing —
    // which is the dangling case wearing a different hat.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.drodio"),
    );
    expect(unsetConfigValue).toHaveBeenCalledWith("publish.active");
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it("leaves publish.active alone when the destination removed was not the active one", async () => {
    getConfig.mockResolvedValue(TWO_DESTINATIONS);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.linkedin"),
    );
    // Neither touched: `drodio` is still where the founder publishes.
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(unsetConfigValue).not.toHaveBeenCalledWith("publish.active");
  });

  it("a failed removal says nothing changed and keeps the destination on screen", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    unsetConfigValue.mockRejectedValue(new Error("config.toml is read-only"));

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() => expect(screen.getByTestId("publish-write-error")).toBeTruthy());
    // Still there — the pane must not paint a removal the config did not take.
    expect(screen.getByTestId("publish-destination-card")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A DANGLING `publish.active` — non-null, naming a destination that does not exist (roborev 67318).
//
// Reachable by a hand edit of config.toml, or a removal by a build that did not repoint. It is NOT
// the same state as `active === null`, and treating the two as one is what made the picker paint a
// destination the user had never chosen.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const DANGLING_ACTIVE = {
  config: {
    publish: {
      active: "ghost",
      destinations: {
        drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
        linkedin: { name: "LinkedIn", url: "https://linkedin.example/api/mcp", has_credential_in_keychain: false },
      },
    },
  },
};

describe("PublishPane — publish.active names a destination that does not exist", () => {
  it("does NOT paint the first destination as chosen", async () => {
    // The defect this pins: `value="ghost"` matches no <option>, and with the placeholder gated on
    // `active === null` there was no empty option either — so the browser selected the first entry.
    // The pane read "Publish to drodio.com" while every publish op refused citing `ghost`.
    getConfig.mockResolvedValue(DANGLING_ACTIVE);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    expect((screen.getByTestId("publish-active-picker") as HTMLSelectElement).value).toBe("");
  });

  it("NAMES the dangling id, so the state is diagnosable rather than mysterious", async () => {
    getConfig.mockResolvedValue(DANGLING_ACTIVE);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    expect(screen.getByTestId("publish-active-picker").textContent).toContain("ghost");
  });

  /** THE ESCAPE HATCH. Re-selecting an entry already displayed fires no `change` event, so when the
   *  picker painted `drodio` the user could not choose `drodio` — there was no way out at all. */
  it("lets the user choose the destination the picker had been falsely showing", async () => {
    getConfig.mockResolvedValue(DANGLING_ACTIVE);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.change(screen.getByTestId("publish-active-picker"), { target: { value: "drodio" } });

    await waitFor(() => expect(setConfigValue).toHaveBeenCalledWith("publish.active", "drodio"));
  });

  it("repairs the dangling pointer when some OTHER destination is removed", async () => {
    // `active === id` alone never fires here — `ghost` is not the id being removed — so the config
    // used to stay dangling through a removal that was already rewriting it.
    getConfig.mockResolvedValue(DANGLING_ACTIVE);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.linkedin"),
    );
    expect(setConfigValue).toHaveBeenCalledWith("publish.active", "drodio");
  });

  /** The converse, and the reason the repair is not simply `!activeExists`: a DELIBERATE null must
   *  not be silently filled in during an unrelated removal. Without this pair, "repairs a dangling
   *  pointer" would pass just as well for a pane that always picks a destination for you. */
  it("does NOT choose a destination on the user's behalf when active is deliberately null", async () => {
    getConfig.mockResolvedValue({
      config: {
        publish: {
          active: null,
          destinations: {
            drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
            linkedin: { name: "LinkedIn", url: "https://linkedin.example/api/mcp", has_credential_in_keychain: false },
          },
        },
      },
    });
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-active-picker")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove linkedin$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.linkedin"),
    );
    expect(setConfigValue).not.toHaveBeenCalledWith("publish.active", "drodio");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MOUNT SEAM (roborev 67335, Medium).
//
// The headline of the integration — one credential row per destination, carrying THAT
// destination's id — was asserted by nothing. The suite mocked `getPublishTokenSource` and never
// checked it was called, never queried the row, and never checked the id. Deleting the JSX line,
// or passing `rows[0].id` instead of `row.id`, left the whole suite green — and a wrong id here
// writes one host's bearer into another host's keychain slot, which is the leak the rest of this
// work is about.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("PublishPane — the credential row is mounted per destination", () => {
  it("renders ONE row per destination, each with its OWN id", async () => {
    getConfig.mockResolvedValue(TWO_DESTINATIONS);
    probeDestination.mockResolvedValue(VALID);

    render(<PublishPane />);
    await waitFor(() => expect(screen.getAllByTestId(PUBLISH_TOKEN_ROW_TESTID).length).toBe(2));

    // The ids, as a SET: two rows both reading "drodio" is the specific bug a count cannot see.
    const ids = getPublishTokenSource.mock.calls.map((c: unknown[]) => c[0]);
    expect(new Set(ids)).toEqual(new Set(["drodio", "linkedin"]));
  });
});

describe("PublishPane — a token that could not be cleared is never silently swallowed", () => {
  it("says the credential is STILL LIVE when the clear fails, naming the destination", async () => {
    // The confirmation the user just read promises removal clears the token. Once the destination
    // is gone there is no row left to report otherwise, so silence here is a lie they cannot
    // detect — and the remedy (revoke at the destination) is one they will not perform.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("the keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() => expect(screen.getByTestId("publish-clear-failure")).toBeTruthy());
    const notice = screen.getByTestId("publish-clear-failure").textContent ?? "";
    expect(notice).toContain("drodio");
    expect(notice).toContain("the keychain is locked");
    expect(notice).toMatch(/still live/i);

    // The REMOVAL still succeeded, and must not read as a failed write — the two states say
    // opposite things about whether the action worked.
    expect(screen.queryByTestId("publish-write-error")).toBeNull();
  });

  it("shows no such notice when the clear succeeds", async () => {
    // The converse. Without it, a pane that ALWAYS rendered the warning would pass the test above.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockResolvedValue("none");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));

    await waitFor(() =>
      expect(unsetConfigValue).toHaveBeenCalledWith("publish.destinations.drodio"),
    );
    expect(screen.queryByTestId("publish-clear-failure")).toBeNull();
  });
});

describe("PublishPane — the still-live claim is retractable", () => {
  /** The notice asserts a PRESENT-TENSE fact the user can go and resolve, and the pane itself
   *  points at re-adding the id as the route back to a Clear button. Follow that advice with the
   *  notice stuck on screen and you get two contradictory statements at once — the row saying the
   *  token is stored, the notice saying it is live and must be revoked — with the false one
   *  surviving, and the remedy it prescribes destroying a bearer just legitimately re-saved
   *  (roborev 67382, Medium). */
  it("drops the notice when the same destination is added back", async () => {
    // The config must actually LOSE the destination on removal, or the re-add is refused as a
    // duplicate id and `addDestination` — where the retraction lives — never runs at all. Modelling
    // the removal is the difference between testing the product and testing the mock.
    const EMPTY = { config: { publish: { active: null, destinations: {} } } };
    getConfig.mockResolvedValueOnce(ONE_DESTINATION).mockResolvedValue(EMPTY);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("the keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    await waitFor(() => expect(screen.getByTestId("publish-clear-failure")).toBeTruthy());

    // Re-add the SAME id — the route the pane's own copy recommends.
    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" });

    await waitFor(() => expect(screen.queryByTestId("publish-clear-failure")).toBeNull());
  });

  it("keeps the notice when a DIFFERENT destination is added", async () => {
    // The converse. Without it, clearing on every add would pass the test above while throwing
    // away a live warning about an unrelated destination.
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("the keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    await waitFor(() => expect(screen.getByTestId("publish-clear-failure")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "linkedin", name: "LinkedIn", url: "https://linkedin.example/api/mcp" });

    await waitFor(() => expect(setConfigValues).toHaveBeenCalled());
    expect(screen.getByTestId("publish-clear-failure")).toBeTruthy();
  });

  it("can be dismissed", async () => {
    getConfig.mockResolvedValue(ONE_DESTINATION);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("the keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    await waitFor(() => expect(screen.getByTestId("publish-clear-failure")).toBeTruthy());

    fireEvent.click(screen.getByTestId("publish-clear-failure-dismiss"));
    expect(screen.queryByTestId("publish-clear-failure")).toBeNull();
  });

  /** THE DIRECTION THAT LOSES INFORMATION. Retracting on the ATTEMPT drops the warning even when
   *  the re-add fails — nothing is added, no row mounts, and the standing claim that a live bearer
   *  exists is gone for the session with nothing to replace it (roborev 67391, Medium). */
  it("KEEPS the notice when the re-add itself fails", async () => {
    const EMPTY = { config: { publish: { active: null, destinations: {} } } };
    getConfig.mockResolvedValueOnce(ONE_DESTINATION).mockResolvedValue(EMPTY);
    probeDestination.mockResolvedValue(VALID);
    clearPublishToken.mockRejectedValue("the keychain is locked");

    render(<PublishPane />);
    await waitFor(() => expect(screen.getByTestId("publish-destination-card")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove drodio$/i }));
    await waitFor(() => expect(screen.getByTestId("publish-clear-failure")).toBeTruthy());

    // The config is read-only, so the re-add cannot land.
    setConfigValues.mockRejectedValue("config.toml is not writable");
    fireEvent.click(screen.getByRole("button", { name: /^add destination$/i }));
    fillAndSubmitForm({ id: "drodio", name: "drodio.com", url: "https://drodio.com/api/mcp" });

    await waitFor(() => expect(screen.getByTestId("publish-write-error")).toBeTruthy());
    // The credential really is still live, and nothing else on screen says so.
    expect(screen.getByTestId("publish-clear-failure")).toBeTruthy();
  });
});
