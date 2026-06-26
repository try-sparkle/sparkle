// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Usage } from "../services/accountStore";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

function makeDeps(accounts: Account[], usage: Usage[] = []): AccountsDeps {
  return {
    listAccounts: vi.fn(async () => accounts),
    getUsage: vi.fn(async () => usage),
    addAccount: vi.fn(async (nickname: string) => acct("new", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
  };
}

describe("AccountsScreen", () => {
  it("lists accounts with nickname, default tag, and usage bars", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "Personal", isDefault: true }), acct("b", { nickname: "Work" })],
      [{ id: "a", tokens5h: 0, tokens7d: 0, exhaustedUntil: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    // Two windows per account × two accounts = 4 progressbars.
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("Add account creates then calls onLogin with the new account", async () => {
    const deps = makeDeps([]);
    const onLogin = vi.fn();
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByText("+ Add account"));
    fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: "Cloud Max" } });
    fireEvent.click(screen.getByText("Create & log in"));
    await waitFor(() => expect(deps.addAccount).toHaveBeenCalledWith("Cloud Max"));
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ nickname: "Cloud Max" }));
  });

  it("inline rename calls setNickname exactly once on Enter (no blur double-commit)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Old" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // A trailing blur (as the input unmounts on commit) must NOT re-submit.
    fireEvent.blur(input);
    await waitFor(() => expect(deps.setNickname).toHaveBeenCalledWith("a", "New Name"));
    expect(deps.setNickname).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels rename without saving (no blur-driven save of the cancelled edit)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Old" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // The blur the unmount would trigger must not commit the discarded draft.
    fireEvent.blur(input);
    // The edit is discarded: original name is shown again and setNickname never ran.
    expect(await screen.findByText("Old")).toBeTruthy();
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  it("does not offer Remove on the default account", async () => {
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("Default");
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("Remove requires a confirm step", async () => {
    const deps = makeDeps([acct("a", { nickname: "Removable" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByText("Remove"));
    expect(deps.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm remove"));
    await waitFor(() => expect(deps.removeAccount).toHaveBeenCalledWith("a"));
  });

  it("shows an exhausted-until indicator when an account is rate-limited", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const deps = makeDeps(
      [acct("a", { nickname: "Limited" })],
      [{ id: "a", tokens5h: 0, tokens7d: 0, exhaustedUntil: future }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Exhausted until/)).toBeTruthy();
  });
});
