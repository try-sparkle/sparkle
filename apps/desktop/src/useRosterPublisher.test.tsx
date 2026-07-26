// @vitest-environment jsdom
//
// One property: useRosterPublisher can be mounted ANYWHERE in the tree.
//
// This file used to guard the blank-on-launch bug — the hook called useCurrentWindowLabel, which
// threw "must be used within AppBoot" outside its provider, so mounting it in App's body painted a
// blank window on every launch. CM-U7 part 2 deleted that context: the hooks read module/store
// state and cannot throw, which left the two cases here asserting the identical vacuous "render
// doesn't throw" (roborev 46485-L). Collapsed to one case that states the property in its new
// form — the guard is now "no provider is REQUIRED", not "the provider must be above it".
//
// What the hook PUBLISHES (visited projects only, no never-opened project's prompt text) is pinned
// in useRosterPublisher.openSet.test.tsx, which drives the real hook and timer.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppBoot } from "./windowContext";
import { useRosterPublisher } from "./useRosterPublisher";

function Harness() {
  useRosterPublisher();
  return null;
}

afterEach(cleanup);

describe("useRosterPublisher", () => {
  it("mounts with or without AppBoot above it (the hooks are global now)", () => {
    expect(() => render(<Harness />)).not.toThrow();
    cleanup();
    expect(() =>
      render(
        <AppBoot>
          <Harness />
        </AppBoot>,
      ),
    ).not.toThrow();
  });
});
