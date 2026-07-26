// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSwitchBanner } from "./AccountSwitchBanner";
import type { Account } from "../services/accountStore";
import type { SwitchRecommendation } from "../services/headroom";
import type { SwitchPlan } from "../services/accountSwitch";

afterEach(() => cleanup());

function acct(id: string, nickname: string): Account {
  return { id, nickname, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0 };
}
const label = (a: Account) => a.nickname;

const rec: SwitchRecommendation = {
  from: acct("a", "Storytell"),
  to: acct("b", "Gmail"),
  fraction: 0.87,
  reason: "approaching",
};

describe("AccountSwitchBanner", () => {
  it("renders nothing when there is no recommendation and no plan", () => {
    const { container } = render(
      <AccountSwitchBanner recommendation={null} plan={null} label={label} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("warns BEFORE the limit, quantified, and names where it would go", () => {
    render(
      <AccountSwitchBanner recommendation={rec} plan={null} label={label} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Storytell is 87% of its usual limit");
    expect(screen.getByRole("button", { name: /Switch to Gmail/ })).toBeTruthy();
  });

  it("accepting and dismissing call through", () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AccountSwitchBanner recommendation={rec} plan={null} label={label} onAccept={onAccept} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Switch to Gmail/ }));
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("reports progress while agents migrate, and explains why it isn't instant", () => {
    // The switch is deliberately gradual — busy agents move as their turns end — so the banner has
    // to say so rather than looking stuck.
    const plan: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: ["y", "z"], moved: ["x"] };
    render(
      <AccountSwitchBanner recommendation={null} plan={plan} label={label} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("1 of 3 agents moved");
    expect(status.textContent).toContain("finish their current turn");
  });

  it("the in-progress state takes precedence over a stale recommendation", () => {
    const plan: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: [], moved: ["x"] };
    render(
      <AccountSwitchBanner recommendation={rec} plan={plan} label={label} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("1 of 1 agents moved");
  });

  it("states a reached limit without a percentage", () => {
    render(
      <AccountSwitchBanner
        recommendation={{ ...rec, fraction: null, reason: "exhausted" }}
        plan={null}
        label={label}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Storytell has hit its limit");
  });
});
