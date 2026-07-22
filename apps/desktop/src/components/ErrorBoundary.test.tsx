// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the logger so we can assert the caught error is funneled into the crash pipeline (log.error)
// without hitting the real Tauri invoke.
const logError = vi.fn();
vi.mock("../logger", () => ({
  log: { error: (...a: unknown[]) => logError(...a), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// SupportModal pulls a heavy dependency graph (accounts, support API); stub it to a marker so the
// "Report" wiring is testable in isolation.
vi.mock("./SupportModal", () => ({
  SupportModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="support-modal">
      support
      <button onClick={onClose}>close-support</button>
    </div>
  ),
}));

import { AgentPaneErrorCard, AppErrorFallback, ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);
beforeEach(() => {
  logError.mockReset();
  // React logs the caught error to console.error; silence it to keep test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** A child that throws on first render, then renders fine once `boom` is flipped off via a ref. */
function Boom({ shouldThrow }: { shouldThrow: () => boolean }) {
  if (shouldThrow()) throw new Error("kaboom");
  return <div data-testid="child-ok">child ok</div>;
}

describe("ErrorBoundary", () => {
  it("catches a throwing child and renders the fallback instead of unmounting", () => {
    render(
      <ErrorBoundary scope="test" fallback={({ error }) => <div>caught: {error.message}</div>}>
        <Boom shouldThrow={() => true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught: kaboom")).toBeTruthy();
    expect(screen.queryByTestId("child-ok")).toBeNull();
  });

  it("funnels the caught error through the logger (crash pipeline) with the given scope", () => {
    render(
      <ErrorBoundary scope="my-scope" fallback={() => <div>fallback</div>}>
        <Boom shouldThrow={() => true} />
      </ErrorBoundary>,
    );
    expect(logError).toHaveBeenCalledTimes(1);
    const [scope, message, data] = logError.mock.calls[0]!;
    expect(scope).toBe("my-scope");
    expect(String(message)).toContain("kaboom");
    // The componentStack rides along so the log line is diagnosable.
    expect(data).toHaveProperty("componentStack");
  });

  it("reset() remounts the children (recovery path)", () => {
    // The child throws until an external flag is cleared; the fallback's reset button clears the
    // boundary's error state, and on the re-render the (now non-throwing) child mounts.
    let boom = true;
    render(
      <ErrorBoundary
        fallback={({ reset }) => (
          <button
            onClick={() => {
              boom = false;
              reset();
            }}
          >
            Reload UI
          </button>
        )}
      >
        <Boom shouldThrow={() => boom} />
      </ErrorBoundary>,
    );
    // Crashed → fallback shown, child absent.
    expect(screen.getByText("Reload UI")).toBeTruthy();
    expect(screen.queryByTestId("child-ok")).toBeNull();
    // Reload → child remounts and renders successfully.
    fireEvent.click(screen.getByText("Reload UI"));
    expect(screen.getByTestId("child-ok")).toBeTruthy();
  });
});

describe("AppErrorFallback", () => {
  it("shows the recovery copy and a Reload UI + Report action", () => {
    render(<AppErrorFallback error={new Error("x")} reset={vi.fn()} />);
    expect(screen.getByText("Something broke")).toBeTruthy();
    expect(screen.getByText("Reload UI")).toBeTruthy();
    expect(screen.getByText("Report")).toBeTruthy();
  });

  it("Reload UI invokes reset (remount)", () => {
    const reset = vi.fn();
    render(<AppErrorFallback error={new Error("x")} reset={reset} />);
    fireEvent.click(screen.getByText("Reload UI"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("Report opens the existing SupportModal (crash/support pipeline)", () => {
    render(<AppErrorFallback error={new Error("x")} reset={vi.fn()} />);
    expect(screen.queryByTestId("support-modal")).toBeNull();
    fireEvent.click(screen.getByText("Report"));
    expect(screen.getByTestId("support-modal")).toBeTruthy();
    // ...and it can be dismissed.
    fireEvent.click(screen.getByText("close-support"));
    expect(screen.queryByTestId("support-modal")).toBeNull();
  });
});

describe("per-pane isolation", () => {
  it("one crashing pane shows its card while the sibling pane keeps rendering", () => {
    function Pane({ id, crash }: { id: string; crash: boolean }) {
      return (
        <ErrorBoundary
          scope="agent-pane"
          fallback={() => <div data-testid={`card-${id}`}>pane {id} error</div>}
        >
          <Boom shouldThrow={() => crash} />
          <div data-testid={`pane-${id}`}>pane {id} ok</div>
        </ErrorBoundary>
      );
    }
    render(
      <>
        <Pane id="a" crash={true} />
        <Pane id="b" crash={false} />
      </>,
    );
    // Pane A crashed → its card shows, its content is gone.
    expect(screen.getByTestId("card-a")).toBeTruthy();
    expect(screen.queryByTestId("pane-a")).toBeNull();
    // Pane B is untouched — the crash did NOT take down the sibling.
    expect(screen.getByTestId("pane-b")).toBeTruthy();
    expect(screen.queryByTestId("card-b")).toBeNull();
  });

  it("AgentPaneErrorCard hides itself (visibility:hidden, pointer-events:none) when not visible", () => {
    const { rerender } = render(
      <AgentPaneErrorCard error={new Error("x")} reset={vi.fn()} visible={false} />,
    );
    // `visibility: hidden` also drops the node from the a11y tree, so query with { hidden: true }.
    const hidden = screen.getByRole("alert", { hidden: true });
    expect(hidden.style.visibility).toBe("hidden");
    expect(hidden.style.pointerEvents).toBe("none");
    // A visible crashed pane paints and takes input.
    rerender(<AgentPaneErrorCard error={new Error("x")} reset={vi.fn()} visible={true} />);
    const shown = screen.getByRole("alert");
    expect(shown.style.visibility).toBe("visible");
    expect(shown.style.pointerEvents).toBe("auto");
  });

  it("AgentPaneErrorCard Retry invokes reset", () => {
    const reset = vi.fn();
    render(<AgentPaneErrorCard error={new Error("x")} reset={reset} visible={true} />);
    fireEvent.click(screen.getByText("Retry"));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
