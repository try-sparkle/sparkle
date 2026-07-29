// @vitest-environment jsdom
// Regression pin for the global afterEach(cleanup) in test-setup.ts. apps/desktop runs
// vitest WITHOUT globals, so @testing-library/react auto-cleanup never self-installs;
// test-setup.ts registers it manually. If that registration is dropped/reordered or the
// RTL import is swapped for the /pure entrypoint, rendered trees leak across tests and
// resurface as misattributed component failures. This file fails loudly instead: test A
// renders a probe; test B asserts the DOM starts empty (only true if cleanup ran between).
// Mirrors test-setup.test.ts, which pins the other setup-file contract (the localStorage
// shim). createElement + function decls (not JSX/arrows) keep it minimal.
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, it, expect } from "vitest";

function Probe() {
  return createElement("div", null, "cleanup-probe-marker");
}

describe("test-setup registers a global afterEach(cleanup)", function () {
  it("A: renders a probe into the document", function () {
    render(createElement(Probe));
    expect(screen.queryAllByText("cleanup-probe-marker").length).toBe(1);
  });
  it("B: the document starts empty, proving A was cleaned up", function () {
    expect(screen.queryAllByText("cleanup-probe-marker").length).toBe(0);
    render(createElement(Probe));
    expect(screen.queryAllByText("cleanup-probe-marker").length).toBe(1);
  });
});
