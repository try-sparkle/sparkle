// @vitest-environment jsdom
//
// roborev 58232. There was NO test for this component, and it is the surface that asks the user to
// move their work between Anthropic logins — so naming an account wrongly here is the most costly
// place to do it.
//
// THE BUG: `identities` started as `[]` and was filled by an async effect, so on first paint every
// account resolved to NOT_SIGNED_IN. The banner read "An account that isn't signed in has hit its
// limit. Switch to an account that isn't signed in to keep working." — the `from` account by
// construction IS signed in (it just hit a limit), and `from`/`to` collapsed to the same string, so
// the user could not tell what they were switching to. Not just a flash: a rejected
// `loadAccountState`, or a target with no identity row, left it there permanently.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loadAccountState = vi.fn();
vi.mock("../services/accountSelection", () => ({ loadAccountState: () => loadAccountState() }));

const recommendation = {
  from: { id: "a", nickname: "Personal", configDir: "/a", isDefault: false, createdAt: 0 },
  to: { id: "b", nickname: "Work", configDir: "/b", isDefault: false, createdAt: 0 },
  fraction: 0.9,
  reason: "approaching" as const,
};
vi.mock("../hooks/useAccountSwitch", () => ({
  useAccountSwitch: () => ({
    recommendation,
    plan: null,
    accept: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { AccountSwitchHost } from "./AccountSwitchHost";

const ident = (id: string, email: string) => ({
  id,
  email,
  organization: null,
  accountUuid: `uuid-${id}`,
  shellEmail: null,
  shellAccountUuid: null,
  identityChanged: false,
});

afterEach(() => {
  cleanup();
  loadAccountState.mockReset();
});

describe("AccountSwitchHost — naming the accounts it asks you to switch between", () => {
  it("renders NOTHING until identities resolve, rather than calling both accounts 'not signed in'", async () => {
    // A promise that never settles: the pre-load state, held open.
    loadAccountState.mockReturnValue(new Promise(() => {}));
    const { container } = render(<AccountSwitchHost />);

    expect(container.textContent).toBe("");
    // The specific false claim this guards against.
    expect(screen.queryByText(/isn't signed in/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to/i })).toBeNull();
  });

  it("names both accounts by their real logins once identities arrive", async () => {
    loadAccountState.mockResolvedValue({
      accounts: [],
      usage: [],
      identities: [ident("a", "me@personal.com"), ident("b", "me@work.com")],
      failed: false,
    });
    render(<AccountSwitchHost />);

    await waitFor(() => expect(screen.getByText(/me@personal\.com/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("me@personal.com");
    expect(text).toContain("me@work.com");
    expect(text).not.toMatch(/isn't signed in/i);
    // And the two are distinguishable — the failure was them collapsing to one string.
    expect(text.indexOf("me@personal.com")).not.toBe(text.indexOf("me@work.com"));
  });

  it("stays silent when the read FAILED — the shape loadAccountState actually returns", async () => {
    // My first version of this test mocked `mockRejectedValue`. `loadAccountState` NEVER REJECTS:
    // it catches internally and RESOLVES with `{ identities: [], failed: true }`. So that test
    // exercised a path the real module cannot take, and the `identities === null` gate it was
    // "proving" did not fire on the only failure that actually happens — the banner still rendered
    // with empty identities and produced the exact false statement. Vacuous, and it hid a live bug.
    loadAccountState.mockResolvedValue({ accounts: [], usage: [], identities: [], failed: true });
    const { container } = render(<AccountSwitchHost />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/isn't signed in/i)).toBeNull();
  });

  it("stays silent when the read FAILED but identities came back NON-empty", async () => {
    // This is the ONLY input for which the `failed` gate and the per-account gate differ, and it is
    // reachable: loadAccountState sets `failed` when `accounts` or `usage` comes back non-array
    // while `identities` was fine. Without it, mutating the `failed` check away left all four tests
    // green — the empty-array case is rejected by the per-account gate on its own, so the branch I
    // named as the headline fix was never exercised. My mutation check confirmed the whole gate,
    // not the part I claimed.
    loadAccountState.mockResolvedValue({
      accounts: [],
      usage: [],
      identities: [ident("a", "me@personal.com"), ident("b", "me@work.com")],
      failed: true,
    });
    const { container } = render(<AccountSwitchHost />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("stays silent when a row EXISTS but carries no login to name", async () => {
    // identities_at emits a row for every registered account, with email and accountUuid both null
    // when the config is unresolvable — so row presence is not nameability, and `from` is never
    // filtered for a login. This is the common real failure the previous gate missed.
    loadAccountState.mockResolvedValue({
      accounts: [],
      usage: [],
      identities: [
        { ...ident("a", "me@personal.com"), email: null, accountUuid: null },
        ident("b", "me@work.com"),
      ],
      failed: false,
    });
    const { container } = render(<AccountSwitchHost />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/isn't signed in/i)).toBeNull();
  });

  it("stays silent when identities load but the recommended TARGET has no row", async () => {
    // The gate has to be per-account. A non-empty list still names the missing one wrongly, and the
    // banner names two accounts — one unnameable is enough to make it meaningless.
    loadAccountState.mockResolvedValue({
      accounts: [],
      usage: [],
      identities: [ident("a", "me@personal.com")], // no row for "b", the target
      failed: false,
    });
    const { container } = render(<AccountSwitchHost />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/isn't signed in/i)).toBeNull();
  });
});
