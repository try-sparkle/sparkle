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
      identities: [ident("a", "me@personal.com"), ident("b", "me@work.com")],
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

  it("stays silent when identities cannot be loaded at all", async () => {
    // A rejected load left the old code showing the indistinguishable banner permanently. Silence
    // is the honest answer: a prompt that cannot say which account it means is worse than none.
    loadAccountState.mockRejectedValue(new Error("ipc down"));
    const { container } = render(<AccountSwitchHost />);

    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/isn't signed in/i)).toBeNull();
  });
});
