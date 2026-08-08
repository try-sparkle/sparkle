// @vitest-environment jsdom
//
// THE CHAT ROW IS A CIRCUIT MEMBER, AND IT IS NOT A BUILD AGENT ROW.
//
// Both halves are the point, and they pull in opposite directions:
//
//   • CIRCUIT. `unbindsOnPointerDown` drops the cable on any press outside the live circuit. A
//     person row that is not a member means the cable drops on the FIRST click on a person — the
//     same defect roborev 54697 filed against the compose box, relocated to a new row type.
//   • NOT A BUILD ROW. `isBuildAgentRow` answers "did the user press a row that owns an agent". A
//     human owns no agent. Folding the two selectors would make every consumer of that predicate
//     quietly wrong about people, and nothing would fail.
//
// So a green run requires the selectors to be DISJOINT and the circuit to be the UNION — which is
// exactly what a single widened `BUILD_ROW_SELECTOR` could not deliver.
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_ROW_SELECTOR,
  CHAT_ROW_SELECTOR,
  CIRCUIT_SELECTOR,
  CABLE_REST,
  isBuildAgentRow,
  isInsideCircuit,
  patchCable,
  unbindsOnPointerDown,
} from "./cable";

/** The chat block as `ChatSection` actually publishes it: a `role="treeitem"` inside the
 *  `data-chat-tree` container. Built from the DOM rather than from the selector string, so the
 *  test fails if either side changes its mind about the structure. */
function mountChatRow(): HTMLElement {
  document.body.innerHTML = `
    <div role="tree" aria-label="Chats" data-chat-tree>
      <div role="treeitem" data-social-id="s1"><span data-testid="person-row-name">Ada</span></div>
    </div>`;
  return document.querySelector('[data-chat-tree] [role="treeitem"] span') as HTMLElement;
}

function mountBuildRow(): HTMLElement {
  document.body.innerHTML = `
    <div role="tree" aria-label="Build agents" data-agent-tree>
      <div role="treeitem" data-agent-id="a1"><span>Alpha</span></div>
    </div>`;
  return document.querySelector('[data-agent-tree] [role="treeitem"] span') as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CHAT_ROW_SELECTOR", () => {
  it("is part of the circuit", () => {
    const inside = mountChatRow();
    expect(inside.closest(CIRCUIT_SELECTOR)).not.toBeNull();
    expect(isInsideCircuit(inside)).toBe(true);
  });

  it("does NOT make a person a build agent row", () => {
    const inside = mountChatRow();
    expect(inside.closest(BUILD_ROW_SELECTOR)).toBeNull();
    expect(isBuildAgentRow(inside)).toBe(false);
  });

  it("leaves a real build row answering exactly as before", () => {
    const inside = mountBuildRow();
    expect(isBuildAgentRow(inside)).toBe(true);
    expect(isInsideCircuit(inside)).toBe(true);
    // …and a build row is not a chat row either — the two are disjoint in both directions.
    expect(inside.closest(CHAT_ROW_SELECTOR)).toBeNull();
  });

  it("keeps the cable patched when a person row is pressed", () => {
    const wired = patchCable(CABLE_REST, "right");
    expect(unbindsOnPointerDown(wired, mountChatRow())).toBe(false);
  });

  it("still unbinds on a press that is neither a row nor any other circuit member", () => {
    // The complement, so the test above cannot pass by the predicate having become "never unbind".
    document.body.innerHTML = `<div data-testid="shell-background"></div>`;
    const outside = document.querySelector('[data-testid="shell-background"]') as HTMLElement;
    expect(unbindsOnPointerDown(patchCable(CABLE_REST, "right"), outside)).toBe(true);
  });

  it("is scoped to the chat tree — a stray treeitem elsewhere is not a chat row", () => {
    document.body.innerHTML = `<div role="treeitem" id="loose"></div>`;
    const loose = document.getElementById("loose") as HTMLElement;
    expect(loose.closest(CHAT_ROW_SELECTOR)).toBeNull();
  });
});
