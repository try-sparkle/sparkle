// @vitest-environment jsdom
//
// The Local/Cloud runtime toggle at agent creation. Its whole job is to be INVISIBLE until the
// server advertises the cloud capability, and to never leave a billed runtime armed once that
// capability goes away — so that's what these pin.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NewAgentRuntimeToggle } from "./NewAgentRuntimeToggle";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";

const me = (cloud: boolean) => ({
  clerkUserId: "u",
  entitled: true,
  balanceCents: 5000,
  tokenVersion: 1,
  ...(cloud ? { cloudAgentsEnabled: true } : {}),
});

beforeEach(() => {
  useUiStore.setState({ newAgentRuntime: "local" });
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
});
afterEach(cleanup);

describe("NewAgentRuntimeToggle", () => {
  it("renders nothing for a local-only user (no capability advertised)", () => {
    useAuthStore.setState({ me: me(false), tokenPresent: true });
    const { container } = render(<NewAgentRuntimeToggle />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("runtime-toggle")).toBeNull();
  });

  it("renders nothing when signed out, even with a stale capability in the store", () => {
    useAuthStore.setState({ me: me(true), tokenPresent: false });
    render(<NewAgentRuntimeToggle />);
    expect(screen.queryByTestId("runtime-toggle")).toBeNull();
  });

  it("offers Local (selected) and Cloud once the capability is advertised", () => {
    useAuthStore.setState({ me: me(true), tokenPresent: true });
    render(<NewAgentRuntimeToggle />);
    expect(screen.getByRole("radio", { name: "Local" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Cloud" }).getAttribute("aria-checked")).toBe("false");
  });

  it("selecting Cloud arms the cloud runtime for the next created agent", () => {
    useAuthStore.setState({ me: me(true), tokenPresent: true });
    render(<NewAgentRuntimeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    expect(useUiStore.getState().newAgentRuntime).toBe("cloud");
    expect(screen.getByRole("radio", { name: "Cloud" }).getAttribute("aria-checked")).toBe("true");
  });

  it("disarms Cloud when the capability goes away (never leaves a billed runtime selected)", () => {
    useAuthStore.setState({ me: me(true), tokenPresent: true });
    const { rerender } = render(<NewAgentRuntimeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    expect(useUiStore.getState().newAgentRuntime).toBe("cloud");

    // The server stops advertising it (flag off / downgraded account / sign-out).
    useAuthStore.setState({ me: me(false), tokenPresent: true });
    rerender(<NewAgentRuntimeToggle />);
    expect(screen.queryByTestId("runtime-toggle")).toBeNull();
    expect(useUiStore.getState().newAgentRuntime).toBe("local");
  });
});
