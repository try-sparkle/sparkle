// @vitest-environment jsdom
//
// The in-progress (auto-switch) notice: centered, green bar with black text, the "Session limit
// approaching: Automatically switching N agents to <nickname>" copy, a Manage link that opens the
// accounts screen, and a ✕ that dismisses the notice. Presentational — driven with fixture props.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSwitchBanner } from "./AccountSwitchBanner";
import type { SwitchPlan } from "../services/accountSwitch";
import type { Account, AccountDisplay } from "../services/accountStore";

afterEach(() => cleanup());

/** A plan moving `moved.length + pending.length` agents to `to`. */
function plan(movedCount: number, pendingCount: number, to = "acct-target"): SwitchPlan {
  return {
    fromAccountId: "acct-from",
    toAccountId: to,
    moved: Array.from({ length: movedCount }, (_, i) => `m${i}`),
    pending: Array.from({ length: pendingCount }, (_, i) => `p${i}`),
  };
}

const noDisplay = (_a: Account): AccountDisplay => ({}) as AccountDisplay;

describe("AccountSwitchBanner — auto-switch progress notice", () => {
  it("shows the copy with the agent count and target nickname", () => {
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(6, 42)}
        display={noDisplay}
        targetName="Personal"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onManage={vi.fn()}
        onDismissProgress={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    // 6 + 42 = 48 agents; the nickname is named.
    expect(status.textContent).toContain("Automatically switching 48 agents");
    expect(status.textContent).toContain("Personal");
    expect(status.textContent).toContain("Session limit reached");
  });

  it("renders a GREEN bar with BLACK text", () => {
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(1, 1)}
        display={noDisplay}
        targetName="Work"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onManage={vi.fn()}
        onDismissProgress={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    // The bar fill is the brand green; the text is black. jsdom normalises the hex to rgb.
    expect(status.style.background).toBe("rgb(52, 199, 89)"); // #34c759
    expect(status.style.color).toBe("rgb(0, 0, 0)");
  });

  it("centers the message (a balancing spacer on each side of the centered content)", () => {
    const { container } = render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(2, 3)}
        display={noDisplay}
        targetName="Work"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onManage={vi.fn()}
        onDismissProgress={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    // Three flex children: left spacer (flex:1), centered content, right ✕ zone (flex:1). The equal
    // spacers are what pull the content to true center.
    const children = Array.from(status.children) as HTMLElement[];
    expect(children.length).toBe(3);
    const [left, , right] = children;
    // `flex: 1` expands to flex-grow:1; equal growth on the two outer spacers is what centers the
    // middle content. (jsdom normalises the `flex` shorthand, so assert the grow longhand.)
    expect(left?.style.flexGrow).toBe("1");
    expect(right?.style.flexGrow).toBe("1");
    void container;
  });

  it("Manage opens the accounts screen", () => {
    const onManage = vi.fn();
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(1, 2)}
        display={noDisplay}
        targetName="Work"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onManage={onManage}
        onDismissProgress={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Manage"));
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("the ✕ dismisses the notice (calls onDismissProgress, not the recommendation dismiss)", () => {
    const onDismissProgress = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(1, 2)}
        display={noDisplay}
        targetName="Work"
        onAccept={vi.fn()}
        onDismiss={onDismiss}
        onManage={vi.fn()}
        onDismissProgress={onDismissProgress}
      />,
    );
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismissProgress).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("uses the singular 'agent' when only one is moving", () => {
    render(
      <AccountSwitchBanner
        recommendation={null}
        plan={plan(0, 1)}
        display={noDisplay}
        targetName="Work"
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onManage={vi.fn()}
        onDismissProgress={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("switching 1 agent ");
  });
});
