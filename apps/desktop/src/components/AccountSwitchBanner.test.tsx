// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSwitchBanner } from "./AccountSwitchBanner";
import { accountDisplay, type Account, type Identity } from "../services/accountStore";
import type { SwitchRecommendation } from "../services/headroom";
import type { SwitchPlan } from "../services/accountSwitch";

afterEach(() => cleanup());

function acct(id: string, nickname: string): Account {
  return { id, nickname, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0 };
}
/** The host's real wiring: identify each account from its verified login, never its nickname. */
const displayFor =
  (identities: Identity[]) =>
  (a: Account) =>
    accountDisplay(a, identities.find((i) => i.id === a.id));
const ident = (id: string, email: string | null): Identity => ({
  id,
  email,
  organization: null,
  accountUuid: `uuid-${id}`,
});
const display = displayFor([ident("a", "drodio@storytell.ai"), ident("b", "drodio@gmail.com")]);

const rec: SwitchRecommendation = {
  from: acct("a", "Storytell"),
  to: acct("b", "Gmail"),
  fraction: 0.87,
  reason: "approaching",
};

describe("AccountSwitchBanner", () => {
  it("renders nothing when there is no recommendation and no plan", () => {
    const { container } = render(
      <AccountSwitchBanner recommendation={null} plan={null} display={display} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("warns BEFORE the limit, quantified, and names where it would go", () => {
    render(
      <AccountSwitchBanner recommendation={rec} plan={null} display={display} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("drodio@storytell.ai is 87% of its usual limit");
    expect(screen.getByRole("button", { name: "Switch to drodio@gmail.com" })).toBeTruthy();
  });

  it("accepting and dismissing call through", () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AccountSwitchBanner recommendation={rec} plan={null} display={display} onAccept={onAccept} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to drodio@gmail.com" }));
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("names the TRIGGER and how many agents are moving, while they migrate", () => {
    // ── THE COPY THIS ASSERTED WAS REPLACED, AND THESE ROWS WERE LEFT BEHIND ────────────────────
    // The banner used to report "1 of 3 agents moved … finish their current turn". The restyle
    // (b4525018f, "true to the trigger") replaced that with a sentence naming WHY the switch is
    // happening — a session limit that was actually observed — and this row went red on `main`,
    // blocking every open PR, because the copy moved and its test did not.
    //
    // What is asserted now is what the new sentence PROMISES, not its exact prose: the trigger, the
    // COUNT of agents being moved (still `pending + moved`, so it does not shrink as they land),
    // and the destination. Pinning the whole string would make the next copy tweak red again.
    const plan: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: ["y", "z"], moved: ["x"] };
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan}
        display={display}
        targetName="Second Account"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Session limit reached");
    expect(status.textContent).toContain("3 agents");
    expect(status.textContent).toContain("Second Account");
  });

  it("the count is the WHOLE switch, so it does not shrink as agents land", () => {
    // `pending + moved`: the sentence names how many this switch is moving, and an agent leaving
    // `pending` for `moved` must not make the banner claim a smaller job than it started.
    const almost: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: [], moved: ["x", "y", "z"] };
    render(
      <AccountSwitchBanner recommendation={null} plan={almost} display={display} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain("3 agents");
  });

  it("says 'agent', singular, when it is moving exactly one", () => {
    const one: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: ["y"], moved: [] };
    render(
      <AccountSwitchBanner recommendation={null} plan={one} display={display} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("1 agent");
    expect(text).not.toContain("1 agents");
  });

  it("the in-progress state takes precedence over a stale recommendation", () => {
    const plan: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: [], moved: ["x"] };
    render(
      <AccountSwitchBanner recommendation={rec} plan={plan} display={display} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    // Same copy move as the row above: the in-progress bar is identified by its trigger sentence.
    expect(screen.getByRole("status").textContent).toContain("Session limit reached");
  });

  it("states a reached limit without a percentage", () => {
    render(
      <AccountSwitchBanner
        recommendation={{ ...rec, fraction: null, reason: "exhausted" }}
        plan={null}
        display={display}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("drodio@storytell.ai has hit its limit");
  });

  it("never puts an unverifiable NICKNAME in the banner or on its button", () => {
    // A nickname is user-typed and says nothing about which Anthropic login a config dir holds.
    // This banner asks the user to move their work between logins, so naming an account it cannot
    // verify would be asserting a login nobody read. Assert the nicknames are ABSENT: asserting the
    // not-signed-in phrasing is PRESENT would pass just as well if both were rendered.
    render(
      <AccountSwitchBanner
        recommendation={rec}
        plan={null}
        display={displayFor([])}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("Storytell");
    expect(alert.textContent).not.toContain("Gmail");
    expect(alert.textContent).toContain("An account that isn't signed in is 87% of its usual limit");
  });
});
