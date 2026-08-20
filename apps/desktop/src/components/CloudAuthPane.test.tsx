// @vitest-environment jsdom
//
// Settings → "Claude auth for cloud agents" (Service B, W5). The pane's contract is narrow and
// security-shaped, so these tests pin exactly that: the stored METHOD is shown, the SECRET is
// write-only (never rendered, never restored, cleared on save), delete works, and the server's
// "subscription tokens are disabled here" refusal renders as an honest sentence.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getClaudeAuth = vi.fn();
const putClaudeAuth = vi.fn();
const deleteClaudeAuth = vi.fn();
vi.mock("../services/cloudAgents/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cloudAgents/api")>()),
  cloudApi: {
    getClaudeAuth: (...a: unknown[]) => getClaudeAuth(...a),
    putClaudeAuth: (...a: unknown[]) => putClaudeAuth(...a),
    deleteClaudeAuth: (...a: unknown[]) => deleteClaudeAuth(...a),
  },
}));

import { CloudAuthPane } from "./CloudAuthPane";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import { CloudApiError } from "../services/cloudAgents/api";

const SECRET = "sk-ant-super-secret-value";

beforeEach(() => {
  useCloudAuthStore.getState().reset();
  getClaudeAuth.mockReset().mockResolvedValue(null);
  putClaudeAuth.mockReset().mockResolvedValue(undefined);
  deleteClaudeAuth.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

/** The password input the user types the credential into. */
const secretInput = () => screen.getByTestId("cloudauth-secret") as HTMLInputElement;

describe("CloudAuthPane", () => {
  it("shows which method the server has stored — and never the secret", async () => {
    getClaudeAuth.mockResolvedValue({ method: "byok" });
    render(<CloudAuthPane />);
    await waitFor(() =>
      expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/API key saved/i),
    );
    // The GET returns the method only; nothing that could be a secret is anywhere in the DOM.
    expect(document.body.textContent).not.toContain("sk-ant");
    expect(secretInput().value).toBe("");
  });

  it("distinguishes 'none saved' from 'not asked yet'", async () => {
    let resolve!: (v: null) => void;
    getClaudeAuth.mockReturnValue(new Promise<null>((r) => (resolve = r)));
    render(<CloudAuthPane />);
    expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/Checking/i);
    resolve(null);
    await waitFor(() =>
      expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/No Claude credential/i),
    );
  });

  it("saves a BYOK key via PUT and clears the input (the secret is write-only)", async () => {
    render(<CloudAuthPane />);
    await waitFor(() => expect(getClaudeAuth).toHaveBeenCalled());

    fireEvent.change(secretInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: /Save credential/i }));

    await waitFor(() => expect(putClaudeAuth).toHaveBeenCalledWith("byok", SECRET));
    // Cleared from the field AND from the rendered document — no echo anywhere.
    await waitFor(() => expect(secretInput().value).toBe(""));
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByTestId("cloudauth-saved")).toBeTruthy();
    // The pane now reports the method it just saved, without re-fetching it.
    expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/API key saved/i);
  });

  it("saves a subscription token under the subscription method when that option is picked", async () => {
    render(<CloudAuthPane />);
    await waitFor(() => expect(getClaudeAuth).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(/subscription token \(opt-in\)/i));
    fireEvent.change(secretInput(), { target: { value: "sk-ant-oat-token" } });
    fireEvent.click(screen.getByRole("button", { name: /Save credential/i }));
    await waitFor(() =>
      expect(putClaudeAuth).toHaveBeenCalledWith("subscription", "sk-ant-oat-token"),
    );
  });

  it("labels the subscription option honestly (opt-in, save will be refused, ToS reason named)", async () => {
    render(<CloudAuthPane />);
    const label = screen.getByLabelText(/subscription token \(opt-in\)/i).closest("label")!;
    expect(label.textContent).toMatch(/claude setup-token/i);
    // The two disclosures a user needs BEFORE pasting a credential: (a) that saving will be
    // REFUSED, and (b) why. Both are asserted as properties — any wording that still says "we
    // won't store it" and still names the terms passes — because pinning the sentence is exactly
    // how the old copy ("Anthropic has not confirmed") stayed green while going factually stale.
    // Deliberately NOT matching a contraction or an apostrophe: a typographic pass turning
    // don't into don’t must not red a test whose disclosure is fully intact.
    expect(label.textContent).toMatch(/won.?t store|will not store|may decline|not enabled/i);
    expect(label.textContent).toMatch(/terms/i);
    expect(label.textContent).toMatch(/permit|prohibit|not allow/i);
    // …and BYOK is the recommended default (nothing pre-selects the ToS-sensitive path).
    expect((screen.getByLabelText(/API key \(recommended\)/i) as HTMLInputElement).checked).toBe(true);
  });

  it("renders the server's subscription-disabled refusal as a plain, actionable line", async () => {
    putClaudeAuth.mockRejectedValue(
      new CloudApiError(403, "subscription_auth_disabled", "subscription auth disabled"),
    );
    render(<CloudAuthPane />);
    await waitFor(() => expect(getClaudeAuth).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText(/subscription token \(opt-in\)/i));
    fireEvent.change(secretInput(), { target: { value: "sk-ant-oat-token" } });
    fireEvent.click(screen.getByRole("button", { name: /Save credential/i }));

    const err = await screen.findByTestId("cloudauth-error");
    // NOT the generic 403 reading ("cloud agents aren't available") — it names the method that is.
    expect(err.textContent).toMatch(/Subscription tokens aren't enabled/i);
    expect(err.textContent).toMatch(/API key/i);
    expect(screen.queryByTestId("cloudauth-saved")).toBeNull();
    // A refused save must not claim a credential is stored.
    expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/No Claude credential/i);
  });

  it("deletes the stored credential behind a confirm", async () => {
    getClaudeAuth.mockResolvedValue({ method: "subscription" });
    render(<CloudAuthPane />);
    await waitFor(() =>
      expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/subscription token saved/i),
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove credential/i }));
    expect(deleteClaudeAuth).not.toHaveBeenCalled(); // the first click only arms the confirm
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));

    await waitFor(() => expect(deleteClaudeAuth).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/No Claude credential/i),
    );
  });

  it("surfaces a failed probe without claiming there is no credential", async () => {
    getClaudeAuth.mockRejectedValue(new Error("Failed to fetch"));
    render(<CloudAuthPane />);
    const err = await screen.findByTestId("cloudauth-error");
    expect(err.textContent).toMatch(/offline/i);
    // `loaded` stays false → still "Checking…", never a confident "none saved".
    expect(screen.getByTestId("cloudauth-current").textContent).toMatch(/Checking/i);
  });
});
