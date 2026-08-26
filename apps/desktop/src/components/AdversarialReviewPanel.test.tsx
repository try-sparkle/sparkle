// @vitest-environment jsdom
//
// The panel, driven through its REAL data path: only the Tauri `invoke` seam is mocked, so a
// wire-shaped payload goes through the service's normalisers, into the store, and out into the DOM.
// Every assertion below is on RENDERED CONTENT — never on "a fetch happened" or "the store flipped".
//
// The three things this suite exists to stop shipping, all of which render as a confident, calm
// panel while being wrong:
//   1. a STALE verdict shown as a current one,
//   2. `unknown` drawn as an empty state instead of the blocking outcome it is,
//   3. a findings list that silently loses rows the reviewer wrote.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { AdversarialReviewPanel, findingLocation } from "./AdversarialReviewPanel";
import { useAdversarialReviewStore } from "../stores/adversarialReviewStore";

/** A wire-shaped status, exactly as serde renders it — `record` and `line` and `note` all carry a
 *  literal `null` where the Rust side holds `None`. */
function wireStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    branch: "feat/x",
    headSha: "head1234567",
    record: null,
    stale: false,
    gate: "not-reviewed",
    blockOn: ["block", "unknown"],
    ...over,
  };
}

function wireRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "block",
    summary: "one security finding",
    findings: [
      {
        file: "apps/desktop/src-tauri/src/a.rs",
        line: 412,
        severity: "high",
        category: "security",
        summary: "user text reaches a shell",
        rationale: "the branch name is interpolated into sh -c",
      },
      {
        file: "apps/desktop/src/b.ts",
        line: null,
        severity: "low",
        category: "missing-tests",
        summary: "the empty case is untested",
        rationale: "only the populated list is exercised",
      },
    ],
    model: "claude-opus-5",
    diffBytes: 4211,
    truncated: false,
    reviewedSha: "abcdef1234567",
    branch: "feat/x",
    reviewedAtMs: 1,
    note: null,
    ...over,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  useAdversarialReviewStore.setState({ entries: {} });
});
afterEach(cleanup);

describe("findingLocation", () => {
  it("renders file:line, and just the file when line is null", () => {
    expect(findingLocation({ file: "a.ts", line: 12, severity: "low", category: "c", summary: "", rationale: "" })).toBe(
      "a.ts:12",
    );
    expect(findingLocation({ file: "a.ts", line: null, severity: "low", category: "c", summary: "", rationale: "" })).toBe(
      "a.ts",
    );
    // A finding whose file the reviewer omitted is still legible as a finding.
    expect(findingLocation({ file: "", line: null, severity: "low", category: "c", summary: "", rationale: "" })).toBe(
      "(file not named)",
    );
  });
});

describe("the verdict and its findings reach the screen", () => {
  it("renders every finding, grouped worst-first, with its location", async () => {
    invokeMock.mockResolvedValue(wireStatus({ record: wireRecord(), gate: "blocking" }));
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);

    await waitFor(() => expect(screen.getByTestId("adversarial-verdict")).toBeTruthy());
    expect(screen.getByTestId("adversarial-verdict").textContent).toContain("Block");
    // BOTH findings, not just the first — a list that silently loses rows is the failure this
    // asserts against, and one-row fixtures cannot see it.
    expect(screen.getAllByTestId("adversarial-finding")).toHaveLength(2);
    expect(screen.getByText("apps/desktop/src-tauri/src/a.rs:412")).toBeTruthy();
    // The null-line finding renders WITHOUT a bogus line number appended.
    expect(screen.getByText("apps/desktop/src/b.ts")).toBeTruthy();
    expect(screen.getByTestId("adversarial-group-high")).toBeTruthy();
    expect(screen.getByTestId("adversarial-group-low")).toBeTruthy();
    expect(screen.getByText(/user text reaches a shell/)).toBeTruthy();
  });

  it("an `unknown` verdict is drawn as a real outcome, not an empty state", async () => {
    // `unknown` is what the backend produces when it could not read a verdict at all, and it is
    // blocking by default. Rendering it as "nothing has been reviewed" would turn the one
    // fail-closed outcome into the one that looks like nothing happened.
    invokeMock.mockResolvedValue(
      wireStatus({
        record: wireRecord({
          verdict: "unknown",
          findings: [],
          summary: "",
          note: "the reviewer's reply contained no balanced JSON object",
        }),
        gate: "blocking",
      }),
    );
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);

    await waitFor(() => expect(screen.getByTestId("adversarial-verdict")).toBeTruthy());
    expect(screen.getByTestId("adversarial-verdict").textContent).toContain("Unknown");
    expect(screen.queryByTestId("adversarial-none")).toBeNull();
    // The reason is shown, so the user can tell a failed run from a clean one.
    expect(screen.getByTestId("adversarial-note").textContent).toContain("balanced JSON");
  });
});

describe("staleness is said before the verdict is believed", () => {
  it("names the reviewed commit and the current head, and tells the user to re-run", async () => {
    invokeMock.mockResolvedValue(
      wireStatus({ record: wireRecord({ verdict: "ship" }), stale: true, gate: "stale" }),
    );
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);

    const banner = await screen.findByTestId("adversarial-stale");
    expect(banner.textContent).toContain("abcdef12");
    expect(banner.textContent).toContain("head1234");
    expect(banner.textContent).toMatch(/re-run/i);
    // The verdict is still shown — dimmed — so the user can see WHAT was said about the old commit.
    expect(screen.getByTestId("adversarial-verdict").textContent).toContain("Ship");
  });

  it("does NOT show the stale banner for a current verdict", async () => {
    invokeMock.mockResolvedValue(
      wireStatus({ record: wireRecord({ reviewedSha: "head1234567" }), stale: false, gate: "blocking" }),
    );
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);
    await waitFor(() => expect(screen.getByTestId("adversarial-verdict")).toBeTruthy());
    expect(screen.queryByTestId("adversarial-stale")).toBeNull();
  });
});

describe("truncation", () => {
  it("says the findings only cover the part the reviewer saw", async () => {
    invokeMock.mockResolvedValue(
      wireStatus({ record: wireRecord({ truncated: true, diffBytes: 200000 }), gate: "blocking" }),
    );
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);
    const note = await screen.findByTestId("adversarial-truncated");
    expect(note.textContent).toMatch(/truncated/i);
    expect(note.textContent).toContain("200,000");
  });
});

describe("the off and unreviewed states", () => {
  it("an off project says how to turn it on and disables the button", async () => {
    invokeMock.mockResolvedValue(wireStatus({ enabled: false, gate: "off" }));
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);
    const off = await screen.findByTestId("adversarial-off");
    expect(off.textContent).toContain("[adversarial_review].enabled = true");
    expect((screen.getByTestId("adversarial-run") as HTMLButtonElement).disabled).toBe(true);
    // And it does NOT also claim the branch is simply unreviewed — one sentence, not two.
    expect(screen.queryByTestId("adversarial-none")).toBeNull();
  });

  it("an enabled, never-reviewed branch says so and leaves the button live", async () => {
    invokeMock.mockResolvedValue(wireStatus({ gate: "not-reviewed" }));
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);
    const none = await screen.findByTestId("adversarial-none");
    expect(none.textContent).toMatch(/not been reviewed/i);
    expect((screen.getByTestId("adversarial-run") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("a failing read", () => {
  it("shows the error instead of a silent blank panel", async () => {
    invokeMock.mockRejectedValue(new Error("adversarial_review_status: no such command"));
    render(<AdversarialReviewPanel root="/repo" branch="feat/x" />);
    const err = await screen.findByTestId("adversarial-error");
    expect(err.textContent).toContain("no such command");
  });
});
