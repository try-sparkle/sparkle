// @vitest-environment jsdom
//
// ChatSection — the fixed "Chat" block at the top of the Build column.
//
// THE ASSERTION THAT MATTERS MOST HERE IS THE EMPTY ONE. A section that renders nothing when it
// holds nothing is the ordinary, tempting shape, and it is wrong for this block specifically: its
// `[+]` is the only way to add the first person, so hiding it at zero hides the only control that
// could ever fill it, and the user reads that as "the feature was removed" (bead sparkle-lcx8y).
// The zero-people case therefore gets more coverage than the populated one.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_EMPTY_DETAIL,
  CHAT_EMPTY_TESTID,
  CHAT_EMPTY_TITLE,
  CHAT_SECTION_TESTID,
  ChatSection,
} from "./ChatSection";
import {
  ADD_PERSON_LABEL,
  CHAT_ADD_PERSON_TESTID,
  CHAT_HEADER_TESTID,
  OPEN_SOCIAL_SETTINGS_EVENT,
} from "./ChatSectionHeader";
import { PERSON_ROW_TESTID } from "./PersonRow";
import { rowBoxFor } from "./rowAnatomy";
import { useSocialStore, type Person } from "../stores/socialStore";

function mkPerson(socialId: string, username: string, over: Partial<Person> = {}): Person {
  return {
    socialId,
    username,
    displayName: null,
    availability: "available",
    relationship: "connected",
    ...over,
  };
}

function seed(people: Person[], unread: Record<string, number> = {}) {
  useSocialStore.setState({
    people: Object.fromEntries(people.map((p) => [p.socialId, p])),
    unread,
  });
}

beforeEach(() => useSocialStore.getState().reset());
afterEach(cleanup);

describe("ChatSection — with nobody in it", () => {
  it("still renders, header and all", () => {
    render(<ChatSection pairSide="right" jointOpen={false} />);
    expect(screen.getByTestId(CHAT_SECTION_TESTID)).toBeTruthy();
    expect(screen.getByTestId(CHAT_HEADER_TESTID)).toBeTruthy();
    expect(screen.getByTestId("chat-header-count").textContent).toBe("0");
  });

  it("keeps the [+] on screen and reachable — never a hover reveal", () => {
    render(<ChatSection pairSide="right" jointOpen={false} />);
    const add = screen.getByTestId(CHAT_ADD_PERSON_TESTID);
    // A `visibility:hidden` box is neither a hit-test target nor sequentially focusable, so these
    // two reads are the whole property: it is drawn at rest, and it is a real button.
    expect(add.style.visibility).not.toBe("hidden");
    expect(add.style.display).not.toBe("none");
    expect(add.tagName).toBe("BUTTON");
    expect(screen.getByLabelText(ADD_PERSON_LABEL)).toBe(add);
  });

  it("says something HONEST rather than pretending to load", () => {
    render(<ChatSection pairSide="right" jointOpen={false} />);
    const empty = screen.getByTestId(CHAT_EMPTY_TESTID);
    expect(empty.textContent).toContain(CHAT_EMPTY_TITLE);
    expect(empty.textContent).toContain(CHAT_EMPTY_DETAIL);
    // The server half is not switched on, so nothing IS in flight. A spinner or "Loading…" here
    // would be a claim that never resolves.
    expect(empty.textContent?.toLowerCase()).not.toContain("loading");
  });

  it("puts the empty line OUTSIDE the tree — a tree may own only treeitems and groups", () => {
    render(<ChatSection pairSide="right" jointOpen={false} />);
    const tree = screen.getByRole("tree", { name: "Chats" });
    expect(tree.children.length).toBe(0);
    expect(tree.contains(screen.getByTestId(CHAT_EMPTY_TESTID))).toBe(false);
  });
});

describe("ChatSection — with people in it", () => {
  it("renders one row per person, inside its OWN tree", () => {
    seed([mkPerson("s1", "ada"), mkPerson("s2", "grace")]);
    render(<ChatSection pairSide="right" jointOpen={false} />);

    const tree = screen.getByRole("tree", { name: "Chats" });
    expect(tree.getAttribute("data-chat-tree")).not.toBeNull();
    const rows = screen.getAllByTestId(PERSON_ROW_TESTID);
    expect(rows.length).toBe(2);
    for (const row of rows) expect(tree.contains(row)).toBe(true);
    // Not the build tree: its tabStopId / renderedRowIds / ArrowDown ring are agent-shaped.
    expect(tree.getAttribute("data-agent-tree")).toBeNull();
    expect(screen.getByTestId("chat-header-count").textContent).toBe("2");
    // The empty line is gone once there is something to show.
    expect(screen.queryByTestId(CHAT_EMPTY_TESTID)).toBeNull();
  });

  it("paints each person's name", () => {
    seed([mkPerson("s1", "ada", { displayName: "Ada Lovelace" }), mkPerson("s2", "grace")]);
    render(<ChatSection pairSide="right" jointOpen={false} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("grace")).toBeTruthy();
  });

  it("clears that person's unread when their row is clicked — and only theirs", () => {
    seed([mkPerson("s1", "ada"), mkPerson("s2", "grace")], { s1: 4, s2: 2 });
    render(<ChatSection pairSide="right" jointOpen={false} />);

    // `peopleList` sorts available-first then by name, so address the row by its social id rather
    // than by index — an ordering change must not silently retarget this click.
    const adaRow = screen.getByTestId(CHAT_SECTION_TESTID).querySelector('[data-social-id="s1"]');
    fireEvent.click(adaRow as Element);

    expect(useSocialStore.getState().unread.s1).toBeUndefined();
    expect(useSocialStore.getState().unread.s2).toBe(2);
  });

  it("selects the clicked row, and only one at a time", () => {
    seed([mkPerson("s1", "ada"), mkPerson("s2", "grace")]);
    render(<ChatSection pairSide="right" jointOpen={false} />);
    const section = screen.getByTestId(CHAT_SECTION_TESTID);

    fireEvent.click(section.querySelector('[data-social-id="s1"]') as Element);
    expect(section.querySelector('[data-social-id="s1"]')?.getAttribute("aria-selected")).toBe("true");
    expect(section.querySelector('[data-social-id="s2"]')?.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(section.querySelector('[data-social-id="s2"]') as Element);
    expect(section.querySelector('[data-social-id="s1"]')?.getAttribute("aria-selected")).toBe("false");
    expect(section.querySelector('[data-social-id="s2"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("passes the pair's cable state THROUGH to every row's geometry", () => {
    // `jointOpen` is required with no default precisely so this cannot silently be false forever
    // (the defaulted-seam shape, bead sparkle-lgbwf). Assert the row's box against the shared rule
    // for the SAME inputs, so what is pinned is the pass-through and not a remembered string.
    seed([mkPerson("s1", "ada")]);
    render(<ChatSection pairSide="right" jointOpen />);
    const row = screen.getByTestId(PERSON_ROW_TESTID);
    const wired = rowBoxFor({ paneSide: "right", jointOpen: true, isActive: false });
    const unwired = rowBoxFor({ paneSide: "right", jointOpen: false, isActive: false });
    // The two differ — otherwise this assertion could not tell them apart.
    expect(wired.padLeft).not.toBe(unwired.padLeft);
    expect(row.style.paddingLeft).toBe(`${wired.padLeft}px`);
    expect(row.style.marginLeft).toBe(`${wired.marginLeft}px`);
  });

  it("does NOT let a selected person claim the pane — no mouth, until U6 owns the mount", () => {
    seed([mkPerson("s1", "ada")]);
    render(<ChatSection pairSide="right" jointOpen />);
    fireEvent.click(screen.getByTestId(PERSON_ROW_TESTID));

    const row = screen.getByTestId(PERSON_ROW_TESTID);
    expect(row.getAttribute("aria-selected")).toBe("true");
    // Selection is real; the junction is not. The terminal is still showing an agent — so BOTH
    // halves of the claim must be absent, the mouths AND the squared pane-side corner. This is the
    // configuration the app actually ships (`ownsPane={false}`), which is why it is pinned here
    // rather than only in PersonRow's own suite where the prop is supplied by the test.
    expect(screen.queryByTestId("row-mouth-top")).toBeNull();
    expect(screen.queryByTestId("row-joint-top")).toBeNull();
    const idle = rowBoxFor({ paneSide: "right", jointOpen: true, isActive: false });
    expect(row.style.borderRadius).toBe(`${idle.borderRadius}px`);
  });

  it("badges the header with the TOTAL unread across everyone", () => {
    seed([mkPerson("s1", "ada"), mkPerson("s2", "grace")], { s1: 4, s2: 2 });
    render(<ChatSection pairSide="right" jointOpen={false} />);
    expect(screen.getByTestId("chat-header-unread").textContent).toBe("6");
  });
});

describe("ChatSection — the [+] seam", () => {
  it("dispatches the open-social-settings event, importing nothing from Settings", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    try {
      render(<ChatSection pairSide="right" jointOpen={false} />);
      fireEvent.click(screen.getByTestId(CHAT_ADD_PERSON_TESTID));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_SOCIAL_SETTINGS_EVENT, heard);
    }
  });

  it("sits OUTSIDE the chat tree and outside any aria-hidden subtree", () => {
    render(<ChatSection pairSide="right" jointOpen={false} />);
    const add = screen.getByTestId(CHAT_ADD_PERSON_TESTID);
    // Inside the tree it would join the roving ring; inside an aria-hidden box (which is how every
    // STAGE header is wrapped, since a tree may not own a heading) it would be unreachable to AT.
    expect(screen.getByRole("tree", { name: "Chats" }).contains(add)).toBe(false);
    for (let el: Element | null = add; el !== null; el = el.parentElement) {
      expect(el.getAttribute("aria-hidden")).not.toBe("true");
    }
  });
});
