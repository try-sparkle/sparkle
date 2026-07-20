// @vitest-environment jsdom
//
// Settings → Mobile pane: device list states (ready / empty / relay-predates-endpoint), the
// inline unpair confirm → revoke → refetch flow, and the pair-code mint + countdown display.
// The Tauri IPC layer is mocked at sparkleApi's seam (invoke), so this exercises the real
// sparkleApi wrappers plus the component.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { CODE_TTL_MS, MobileDevicesPane } from "./MobileDevicesPane";

const DEVICES = {
  devices: [
    {
      id: "dev-1",
      name: "Diego's iPhone",
      platform: "ios",
      createdAt: "2026-06-30T18:00:00Z",
      lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      current: false,
    },
    {
      id: "dev-2",
      name: "Diego's Mac",
      platform: "desktop",
      createdAt: "2026-06-01T18:00:00Z",
      lastSeenAt: new Date().toISOString(),
      current: true,
    },
  ],
};

beforeEach(() => {
  invoke.mockReset();
});
afterEach(cleanup);

describe("MobileDevicesPane", () => {
  it("lists paired devices with unpair on non-current rows only", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? DEVICES : null));
    render(<MobileDevicesPane />);
    expect(await screen.findByText("Diego's iPhone")).toBeTruthy();
    expect(screen.getByText("Diego's Mac")).toBeTruthy();
    expect(screen.getByText("This Mac")).toBeTruthy();
    // Only the phone (non-current) gets an Unpair affordance.
    expect(screen.getAllByRole("button", { name: "Unpair…" })).toHaveLength(1);
  });

  it("revokes after inline confirm and refetches the list", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? DEVICES : null));
    render(<MobileDevicesPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Unpair…" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpair" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("revoke_paired_device", { id: "dev-1" }),
    );
    // Initial load + post-revoke refetch.
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "list_paired_devices")).toHaveLength(2),
    );
  });

  it("cancel dismisses the inline confirm without revoking", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? DEVICES : null));
    render(<MobileDevicesPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Unpair…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Unpair…" })).toBeTruthy();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "revoke_paired_device")).toBe(false);
  });

  it("shows the empty state when no devices are paired", async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === "list_paired_devices" ? { devices: [] } : null,
    );
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/No devices paired yet/)).toBeTruthy();
  });

  it("shows the relay-update-pending state on devices_unsupported (no crash)", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") throw "devices_unsupported";
      return null;
    });
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/relay update/)).toBeTruthy();
  });

  it("mints and displays a pairing code with a countdown", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") return { devices: [] };
      if (cmd === "desktop_pair_code") return "AB3XY9";
      return null;
    });
    render(<MobileDevicesPane />);
    fireEvent.click(screen.getByRole("button", { name: /Get pairing code/ }));
    expect(await screen.findByTestId("pair-code")).toBeTruthy();
    expect(screen.getByTestId("pair-code").textContent).toBe("AB3XY9");
    expect(screen.getByText(/Code expires in/)).toBeTruthy();
    expect(screen.getByText(/enter this code at sign-in/)).toBeTruthy();
    // Regenerate replaces the code.
    invoke.mockImplementation(async (cmd) =>
      cmd === "desktop_pair_code" ? "ZZ7QW2" : { devices: [] },
    );
    fireEvent.click(screen.getByRole("button", { name: /New code/ }));
    await waitFor(() => expect(screen.getByTestId("pair-code").textContent).toBe("ZZ7QW2"));
  });

  it("surfaces a pair-code failure inline", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") return { devices: [] };
      if (cmd === "desktop_pair_code") throw "not signed in";
      return null;
    });
    render(<MobileDevicesPane />);
    fireEvent.click(screen.getByRole("button", { name: /Get pairing code/ }));
    expect(await screen.findByText(/Couldn't get a pairing code/)).toBeTruthy();
  });

  it("shows the error state with a working Retry on a non-sentinel list failure", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") throw "device list failed: relay 500";
      return null;
    });
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/Couldn't load devices: device list failed/)).toBeTruthy();
    // Retry refetches — and a recovered relay renders the list.
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? DEVICES : null));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Diego's iPhone")).toBeTruthy();
  });

  it("treats an error that merely embeds the sentinel as an error, not relay-pending", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") throw "device list failed: devices_unsupported";
      return null;
    });
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/Couldn't load devices/)).toBeTruthy();
    expect(screen.queryByText(/relay update/)).toBeNull();
  });

  it("treats a malformed list response as an error, not an empty list", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? {} : null));
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/Couldn't load devices/)).toBeTruthy();
    expect(screen.queryByText(/No devices paired yet/)).toBeNull();
  });

  it("surfaces a revoke failure inline and keeps the row", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") return DEVICES;
      if (cmd === "revoke_paired_device") throw "unpair failed: relay 500";
      return null;
    });
    render(<MobileDevicesPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Unpair…" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpair" }));
    expect(await screen.findByText(/Unpair failed: unpair failed: relay 500/)).toBeTruthy();
    expect(screen.getByText("Diego's iPhone")).toBeTruthy();
    // A subsequent manual refresh clears the stale error.
    fireEvent.click(screen.getByRole("button", { name: "Refresh device list" }));
    await waitFor(() => expect(screen.queryByText(/Unpair failed/)).toBeNull());
  });

  it("offers refresh from the relay-update-pending state", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_paired_devices") throw "devices_unsupported";
      return null;
    });
    render(<MobileDevicesPane />);
    expect(await screen.findByText(/relay update/)).toBeTruthy();
    // The relay rolls out while the pane sits open; refresh now finds devices.
    invoke.mockImplementation(async (cmd) => (cmd === "list_paired_devices" ? DEVICES : null));
    fireEvent.click(screen.getByRole("button", { name: "Refresh device list" }));
    expect(await screen.findByText("Diego's iPhone")).toBeTruthy();
  });

  it("shows the expired message once the code TTL elapses", async () => {
    vi.useFakeTimers();
    try {
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "list_paired_devices") return { devices: [] };
        if (cmd === "desktop_pair_code") return "AB3XY9";
        return null;
      });
      render(<MobileDevicesPane />);
      // Let the initial load + mint promises settle under fake timers.
      await vi.waitFor(() => {
        expect(screen.getByRole("button", { name: /Get pairing code/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Get pairing code/ }));
      await vi.waitFor(() => expect(screen.getByTestId("pair-code")).toBeTruthy());
      expect(screen.getByText(/Code expires in/)).toBeTruthy();
      // Jump the CLOCK past the TTL, then fire a single tick of the 1s countdown interval.
      // The pane derives "expired" from Date.now() each tick, so one tick after the jump is
      // enough to observe it. Advancing the full 15min TTL instead (advanceTimersByTimeAsync)
      // runs ~900 intervals, each re-rendering — that took >6s of real time and blew the 5s
      // test timeout whenever the machine was busy.
      vi.setSystemTime(Date.now() + CODE_TTL_MS + 1500);
      await vi.advanceTimersByTimeAsync(1000);
      // waitFor the re-render: the tick's setNow() is a React state update, and the old
      // advance-the-whole-TTL version only flushed it incidentally, via the ~900 awaits it did.
      await vi.waitFor(() => expect(screen.getByText(/This code has expired/)).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });
});
